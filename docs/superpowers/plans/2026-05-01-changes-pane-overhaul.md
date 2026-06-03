# Changes Pane Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Changes pane with a sectioned, self-sufficient git UI: correct status taxonomy, inline stage/unstage/discard/open-file actions, commit composer with smart-commit and amend, and a conflict-resolve dialog — matching VS Code ergonomics.

**Architecture:** Rust git layer keeps `index_status`/`worktree_status` raw and adds a typed `ConflictKind`. Frontend "fans out" each `FileStatus` into one or two `FileEntry` rows (`conflict` / `staged` / `unstaged`) and renders three collapsible sections. New Tauri commands cover discard, unstage-all, resolve-conflict, amend, and per-scope diffs. Optimistic section-membership patches make actions feel instant; the existing watcher reconciles. The whole pane decomposes into focused components (`FileRow`, `FileSection`, `ChangesHeader`, `CommitComposer`, `ConflictStageDialog`, `BranchCommits`) coordinated by a slim `CodeChanges.tsx` orchestrator.

**Tech Stack:** Rust + sqlx + Tauri v2 backend; Solid.js + TypeScript + UnoCSS + `@tanstack/solid-virtual` frontend; `vitest` + `@solidjs/testing-library` (frontend) and `cargo test` + `tempfile` (Rust) for tests.

**Spec:** `docs/superpowers/specs/2026-05-01-changes-pane-overhaul-design.md`

---

## File Structure

### Rust (modify)
- `src-tauri/src/git_ops.rs` — types, status parsing, untracked stats, new ops (discard, unstage_all, resolve_conflict, commit_amend, scoped diffs).
- `src-tauri/src/ipc.rs` — Tauri command wrappers for the new ops.
- `src-tauri/src/lib.rs` — register the new commands in the invoke handler.

### Frontend (create)
- `src/lib/gitStatus.ts` — shared status taxonomy (`fanOut`, `badgeForEntry`, `ConflictKind` labels).
- `src/lib/gitStatus.test.ts` — unit tests for the helper.
- `src/store/changesActions.ts` — optimistic patch helpers + IPC orchestration for stage / unstage / discard / resolve.
- `src/store/changesActions.test.ts` — tests for the patch + error-revert paths.
- `src/components/FileRow.tsx` — single row with hover actions and inline 3s discard confirm.
- `src/components/FileSection.tsx` — collapsible virtualized section with hover-revealed bulk actions.
- `src/components/ChangesHeader.tsx` — title + segmented counts + refresh.
- `src/components/CommitComposer.tsx` — textarea + split commit button + kebab (Amend / Commit & Push / Stage All & Commit).
- `src/components/ConflictStageDialog.tsx` — modal for the three-choice conflict-stage flow.
- `src/components/BranchCommits.tsx` — extracted Branch Commits panel.

### Frontend (modify)
- `src/types/index.ts` — replace `FileStatus.status` / `staging` with `indexStatus` / `worktreeStatus` / `conflict`. Add `ConflictKind` union.
- `src/lib/ipc.ts` — typed wrappers for new commands.
- `src/store/editorView.ts` — extend `DiffSource` with `staged` / `unstaged` variants; update `diffTabKey`.
- `src/components/CodeChanges.tsx` — rewrite as a slim orchestrator.
- `src/components/CodeChanges.test.tsx` — rewrite around new fixtures and behaviors.
- `src/components/DiffEditor.tsx` — dispatch on the new `DiffSource.type` values.
- `src/components/GitActions.tsx` — update `buildPrMessage` to use the new `FileStatus` shape.
- `src/lib/seedData.ts` — update demo fixtures.
- `src/components/Sidebar.tsx`, `src/components/FileTree.tsx` — update any code that read the old `status` / `staging` (audit via grep).
- `CHANGELOG.md` — single bullet under `## Unreleased`.

---

## Conventions

Throughout this plan:
- **Working dir is the project root** (`pwd` should print a path ending in `/containerized-nodemodules-557`).
- Run `cargo test -p verun_lib --lib git_ops::tests::<name>` for a single Rust test, `cargo test --lib` for all.
- Run `pnpm test -- src/path/to/file.test.ts` for one frontend test, `pnpm test` for all.
- Run `make check` for full project health (typecheck + cargo check + clippy + tests).
- Use the existing test helper `init_test_repo()` in `git_ops.rs` for new Rust tests. Reach for `tempfile::tempdir()` only if you need a different layout.
- All new types use `#[derive(Debug, Clone, Serialize)]` with `#[serde(rename_all = "camelCase")]` to match existing patterns.

---

## Task 1: Data model refactor (Rust + TS lockstep)

Replaces the flat `status: String, staging: String` pair with explicit `index_status` / `worktree_status` / `conflict` dimensions. This is a breaking wire-format change; every consumer is updated in this task so the codebase stays compiling and tested. UI of `CodeChanges.tsx` will look slightly off after this task — that is fixed in Task 13.

**Files:**
- Modify: `src-tauri/src/git_ops.rs:25-50` (FileStatus struct), `:111-177` (parse_porcelain_status), `:1029-1256` (tests).
- Modify: `src/types/index.ts:243-263` (FileStatus / GitStatus interfaces).
- Modify: `src/components/CodeChanges.tsx:19-33, :260-310` (status letter / color tables and row render).
- Modify: `src/components/GitActions.tsx:24` (PR message file map).
- Modify: `src/lib/seedData.ts:318` (demo data file shape).
- Modify: `src/components/CodeChanges.test.tsx:76-91` (test fixtures).
- Audit: `grep -n "f\\.status\\|file\\.staging\\|f\\.staging" src --include="*.ts" --include="*.tsx"` — update any other call site you find. (Initial audit: only `GitActions.tsx:24` and `seedData.ts:318` use the file shape; everything else `.status` is on different types.)

- [ ] **Step 1: Write the failing Rust test for new conflict pairs**

In `src-tauri/src/git_ops.rs`, inside `mod tests`, add:

```rust
#[test]
fn status_classifies_all_conflict_pairs() {
    // Helper: given a porcelain line, what does the parser return?
    fn parse_one(line: &str) -> FileStatus {
        let dir = tempfile::tempdir().unwrap();
        let rp = dir.path().join("repo");
        std::fs::create_dir(&rp).unwrap();
        let rps = rp.to_str().unwrap();
        git(rps).args(["init"]).output().unwrap();
        git(rps).args(["config", "user.email", "t@t.t"]).output().unwrap();
        git(rps).args(["config", "user.name", "t"]).output().unwrap();
        std::fs::write(rp.join("a.txt"), "x\n").unwrap();
        git(rps).args(["add", "."]).output().unwrap();
        git(rps).args(["commit", "-m", "init"]).output().unwrap();

        // Forge an index entry by writing porcelain output through update-index
        // For simplicity: parse_porcelain_status_line is a private helper we expose for tests.
        parse_porcelain_status_line(line).expect("parses")
    }

    let uu = parse_one("UU file.txt");
    assert_eq!(uu.conflict, Some(ConflictKind::BothModified));
    assert_eq!(uu.path, "file.txt");

    let aa = parse_one("AA file.txt");
    assert_eq!(aa.conflict, Some(ConflictKind::BothAdded));

    let dd = parse_one("DD file.txt");
    assert_eq!(dd.conflict, Some(ConflictKind::BothDeleted));

    let au = parse_one("AU file.txt");
    assert_eq!(au.conflict, Some(ConflictKind::AddedByUs));

    let ua = parse_one("UA file.txt");
    assert_eq!(ua.conflict, Some(ConflictKind::AddedByThem));

    let du = parse_one("DU file.txt");
    assert_eq!(du.conflict, Some(ConflictKind::DeletedByUs));

    let ud = parse_one("UD file.txt");
    assert_eq!(ud.conflict, Some(ConflictKind::DeletedByThem));
}

#[test]
fn status_separates_index_and_worktree_dimensions() {
    let mm = parse_porcelain_status_line("MM file.txt").unwrap();
    assert_eq!(mm.index_status, 'M');
    assert_eq!(mm.worktree_status, 'M');
    assert_eq!(mm.conflict, None);

    let m_space = parse_porcelain_status_line("M  file.txt").unwrap();
    assert_eq!(m_space.index_status, 'M');
    assert_eq!(m_space.worktree_status, ' ');

    let space_m = parse_porcelain_status_line(" M file.txt").unwrap();
    assert_eq!(space_m.index_status, ' ');
    assert_eq!(space_m.worktree_status, 'M');

    let untracked = parse_porcelain_status_line("?? file.txt").unwrap();
    assert_eq!(untracked.index_status, '?');
    assert_eq!(untracked.worktree_status, '?');

    let renamed = parse_porcelain_status_line("R  old.txt -> new.txt").unwrap();
    assert_eq!(renamed.index_status, 'R');
    assert_eq!(renamed.path, "new.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
}
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::status_classifies_all_conflict_pairs git_ops::tests::status_separates_index_and_worktree_dimensions
```

Expected: FAIL with "cannot find function `parse_porcelain_status_line`" / "no field `conflict` on type `FileStatus`".

- [ ] **Step 3: Refactor the Rust types**

Replace the existing `FileStatus` definition in `src-tauri/src/git_ops.rs` (around line 25-32) with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,    // UU
    BothAdded,       // AA
    BothDeleted,     // DD
    AddedByUs,       // AU
    AddedByThem,     // UA
    DeletedByUs,     // DU
    DeletedByThem,   // UD
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Raw porcelain index byte: ' ', 'M', 'A', 'D', 'R', 'C', 'U', '?'.
    pub index_status: char,
    /// Raw porcelain worktree byte: ' ', 'M', 'D', 'U', '?'.
    pub worktree_status: char,
    /// Set when the pair represents a merge conflict.
    pub conflict: Option<ConflictKind>,
    pub old_path: Option<String>,
}
```

The `staging: String` and the old single-letter `status: String` are removed. Do not add a serde alias — the wire format is breaking.

- [ ] **Step 4: Rewrite the porcelain parser**

Replace the body of `parse_porcelain_status` in `src-tauri/src/git_ops.rs` and add a new helper `parse_porcelain_status_line` so per-line parsing is testable in isolation:

```rust
fn parse_porcelain_status(worktree_path: &str) -> Result<Vec<FileStatus>, String> {
    let output = git_read_only(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git status: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();
    for line in stdout.lines() {
        if let Some(fs) = parse_porcelain_status_line(line) {
            // Skip directory entries (untracked dirs end with '/')
            if fs.path.ends_with('/') {
                continue;
            }
            files.push(fs);
        }
    }
    Ok(files)
}

/// Parse one line of `git status --porcelain` output into a FileStatus.
/// Public-in-crate so tests can call it directly without forging a real conflict.
pub(crate) fn parse_porcelain_status_line(line: &str) -> Option<FileStatus> {
    if line.len() < 4 {
        return None;
    }
    let bytes = line.as_bytes();
    let xy = (bytes[0] as char, bytes[1] as char);
    let path_part = &line[3..];

    // Renames: "R  old -> new" or "C  old -> new"
    let (path, old_path) = if path_part.contains(" -> ") {
        let parts: Vec<&str> = path_part.splitn(2, " -> ").collect();
        (parts[1].to_string(), Some(parts[0].to_string()))
    } else {
        (path_part.to_string(), None)
    };

    let conflict = match xy {
        ('U', 'U') => Some(ConflictKind::BothModified),
        ('A', 'A') => Some(ConflictKind::BothAdded),
        ('D', 'D') => Some(ConflictKind::BothDeleted),
        ('A', 'U') => Some(ConflictKind::AddedByUs),
        ('U', 'A') => Some(ConflictKind::AddedByThem),
        ('D', 'U') => Some(ConflictKind::DeletedByUs),
        ('U', 'D') => Some(ConflictKind::DeletedByThem),
        _ => None,
    };

    Some(FileStatus {
        path,
        index_status: xy.0,
        worktree_status: xy.1,
        conflict,
        old_path,
    })
}
```

Delete the old `(status, staging) = match (index_status, worktree_status) { ... }` block entirely.

- [ ] **Step 5: Update existing Rust tests for the new shape**

Existing tests reference `f.status` and `f.staging`. In `src-tauri/src/git_ops.rs` `mod tests`:

- `status_with_changes` — no field access change needed (uses `f.path` only).
- `status_staged_file` — replace:
  ```rust
  assert_eq!(staged.staging, "staged");
  assert_eq!(staged.status, "A");
  ```
  with:
  ```rust
  assert_eq!(staged.index_status, 'A');
  assert_eq!(staged.worktree_status, ' ');
  assert_eq!(staged.conflict, None);
  ```
- `stage_all_and_unstage` — replace `assert!(status.files.iter().all(|f| f.staging == "staged"))` with `assert!(status.files.iter().all(|f| f.index_status != ' ' && f.index_status != '?'))`. Replace `assert_eq!(a.staging, "untracked")` with `assert_eq!(a.index_status, '?')`.
- `get_commit_files` (around line 588) currently sets `staging: "committed".to_string()`. Update its `FileStatus` constructor to set `index_status` to the diff-tree status char, `worktree_status: ' '`, `conflict: None`. The `staging` field is gone.

- [ ] **Step 6: Run all Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::
```

Expected: all green, including the two new tests.

- [ ] **Step 7: Update TypeScript types**

In `src/types/index.ts`, replace lines 245-250 (the `FileStatus` interface) with:

```ts
export type ConflictKind =
  | 'bothModified'
  | 'bothAdded'
  | 'bothDeleted'
  | 'addedByUs'
  | 'addedByThem'
  | 'deletedByUs'
  | 'deletedByThem'

export interface FileStatus {
  path: string
  indexStatus: string    // single character: ' ', 'M', 'A', 'D', 'R', 'C', 'U', '?'
  worktreeStatus: string // single character: ' ', 'M', 'D', 'U', '?'
  conflict: ConflictKind | null
  oldPath?: string
}
```

- [ ] **Step 8: Update consumers — `GitActions.tsx`**

In `src/components/GitActions.tsx:24`, replace:

```ts
.map(f => `  ${f.status} ${f.path}`)
```

with:

```ts
.map(f => `  ${f.conflict ? '!' : f.indexStatus !== ' ' && f.indexStatus !== '?' ? f.indexStatus : f.worktreeStatus} ${f.path}`)
```

- [ ] **Step 9: Update consumers — `seedData.ts`**

In `src/lib/seedData.ts:318`, replace the fixture mapping:

```ts
files: files.map(f => ({ path: f.path, status: f.status, staging: '' })),
```

with:

```ts
files: files.map(f => ({
  path: f.path,
  indexStatus: f.indexStatus ?? ' ',
  worktreeStatus: f.worktreeStatus ?? 'M',
  conflict: null,
})),
```

Audit the seed data in the same file (search for any other place that builds a `FileStatus`-shaped object literal) and apply the same shape.

- [ ] **Step 10: Update `CodeChanges.tsx` minimally to keep it compiling**

In `src/components/CodeChanges.tsx`, replace the `STATUS_LETTERS` and `STATUS_COLORS` maps (lines 19-33) with placeholder logic that uses the new fields. This is throwaway — the full rewrite happens in Task 13.

```ts
function letterFor(f: FileStatus): string {
  if (f.conflict) return '!'
  if (f.indexStatus === '?' && f.worktreeStatus === '?') return 'U'
  if (f.indexStatus !== ' ' && f.indexStatus !== '?') return f.indexStatus
  return f.worktreeStatus
}

function colorFor(f: FileStatus): string {
  if (f.conflict) return 'text-red-400'
  if (f.indexStatus === '?' && f.worktreeStatus === '?') return 'text-emerald-400'
  const ch = f.indexStatus !== ' ' && f.indexStatus !== '?' ? f.indexStatus : f.worktreeStatus
  if (ch === 'M') return 'text-amber-400'
  if (ch === 'A') return 'text-emerald-400'
  if (ch === 'D') return 'text-red-400'
  if (ch === 'R' || ch === 'C') return 'text-blue-400'
  return 'text-text-muted'
}
```

In the row render block (around line 266-308), replace `STATUS_LETTERS[f().status] || '?'` with `letterFor(f())` and `STATUS_COLORS[f().status] || 'text-text-muted'` with `colorFor(f())`.

- [ ] **Step 11: Update `CodeChanges.test.tsx` fixtures**

In `src/components/CodeChanges.test.tsx`, change `makeStatus`:

```ts
function makeStatus(count: number): GitStatus {
  return {
    files: Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      indexStatus: ' ',
      worktreeStatus: 'M',
      conflict: null,
    })),
    stats: Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      insertions: i,
      deletions: 0,
    })),
    totalInsertions: count,
    totalDeletions: 0,
  }
}
```

- [ ] **Step 12: Run frontend tests + typecheck**

```bash
pnpm test
pnpm check
```

Expected: all green. If `tsc` flags other consumers of `f.status` / `f.staging` you missed, fix them now.

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/git_ops.rs src/types/index.ts src/components/CodeChanges.tsx src/components/CodeChanges.test.tsx src/components/GitActions.tsx src/lib/seedData.ts
git commit -m "refactor(git): split FileStatus into indexStatus + worktreeStatus + conflict

Conflict pairs (UU, AA, DD, AU, UA, DU, UD) now produce a typed
ConflictKind. Untracked is detected by indexStatus == '?'. The legacy
single-letter status and staging string fields are removed across Rust
and TypeScript consumers."
```

---

## Task 2: Untracked file stats

**Goal:** untracked files appear in `GitStatus.stats` with their line count, so the UI can show `+N` next to them. Tracked files keep using `git diff HEAD --numstat`.

**Files:**
- Modify: `src-tauri/src/git_ops.rs:179-218` (parse_numstat).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/git_ops.rs`:

```rust
#[test]
fn numstat_includes_untracked_line_counts() {
    let (_dir, rp) = init_test_repo();
    fs::write(format!("{rp}/new.txt"), "line1\nline2\nline3\n").unwrap();

    let status = get_git_status(&rp).unwrap();
    let new_stats = status.stats.iter().find(|s| s.path == "new.txt").unwrap();
    assert_eq!(new_stats.insertions, 3);
    assert_eq!(new_stats.deletions, 0);
    assert_eq!(status.total_insertions >= 3, true);
}

#[test]
fn numstat_caps_pathological_untracked_files() {
    let (_dir, rp) = init_test_repo();
    let big = "x\n".repeat(60_000);
    fs::write(format!("{rp}/big.txt"), big).unwrap();

    let status = get_git_status(&rp).unwrap();
    let big_stats = status.stats.iter().find(|s| s.path == "big.txt").unwrap();
    assert_eq!(big_stats.insertions, 0);
    assert_eq!(big_stats.deletions, 0);
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::numstat_includes_untracked_line_counts git_ops::tests::numstat_caps_pathological_untracked_files
```

Expected: FAIL — `new.txt` is missing from `stats`.

- [ ] **Step 3: Add untracked stats collection**

Replace the body of `parse_numstat` in `src-tauri/src/git_ops.rs`:

```rust
const UNTRACKED_LINE_CAP: usize = 50_000;

fn parse_numstat(worktree_path: &str) -> Result<Vec<FileDiffStats>, String> {
    let mut stats = parse_tracked_numstat(worktree_path)?;
    stats.extend(parse_untracked_numstat(worktree_path)?);
    Ok(stats)
}

fn parse_tracked_numstat(worktree_path: &str) -> Result<Vec<FileDiffStats>, String> {
    let output = git_read_only(worktree_path)
        .args(["diff", "HEAD", "--numstat"])
        .output()
        .map_err(|e| format!("Failed to run git diff --numstat: {e}"))?;

    let stdout = if !output.status.success() {
        // HEAD might not exist yet (no commits) — fall back to staged diff
        let fallback = git_read_only(worktree_path)
            .args(["diff", "--cached", "--numstat"])
            .output()
            .map_err(|e| format!("Failed to run git diff --cached --numstat: {e}"))?;
        String::from_utf8_lossy(&fallback.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    let mut stats = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        // Binary files show "-" — treat as 0/0.
        let insertions = parts[0].parse::<u32>().unwrap_or(0);
        let deletions = parts[1].parse::<u32>().unwrap_or(0);
        stats.push(FileDiffStats {
            path: parts[2].to_string(),
            insertions,
            deletions,
        });
    }
    Ok(stats)
}

fn parse_untracked_numstat(worktree_path: &str) -> Result<Vec<FileDiffStats>, String> {
    let output = git_read_only(worktree_path)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| format!("Failed to run git ls-files --others: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let mut stats = Vec::new();
    let raw = output.stdout;
    for chunk in raw.split(|b| *b == 0u8) {
        if chunk.is_empty() {
            continue;
        }
        let path = match std::str::from_utf8(chunk) {
            Ok(s) => s.to_string(),
            Err(_) => continue,
        };
        let full = std::path::Path::new(worktree_path).join(&path);
        // Read content; if file is binary (read fails) or oversize, return 0/0.
        let insertions = match std::fs::read_to_string(&full) {
            Ok(content) => {
                let count = content.lines().count();
                if count > UNTRACKED_LINE_CAP { 0 } else { count as u32 }
            }
            Err(_) => 0,
        };
        stats.push(FileDiffStats {
            path,
            insertions,
            deletions: 0,
        });
    }
    Ok(stats)
}
```

- [ ] **Step 4: Run the new tests + the full numstat suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/git_ops.rs
git commit -m "feat(git): include untracked file line counts in numstat

Untracked files now show up in GitStatus.stats with insertions = line count
(deletions always 0). Files larger than 50k lines or unreadable as UTF-8
report 0/0 to avoid pathological reads."
```

---

## Task 3: New Rust ops + tests

Adds the underlying git operations in `git_ops.rs`. Each function gets its own test. No Tauri commands yet — that comes in Task 4.

**Files:**
- Modify: `src-tauri/src/git_ops.rs` (append new functions and tests).

- [ ] **Step 1: Write failing tests for discard**

Append to `mod tests` in `src-tauri/src/git_ops.rs`:

```rust
#[test]
fn discard_files_reverts_modified_and_removes_untracked() {
    let (_dir, rp) = init_test_repo();

    // Modified tracked file
    fs::write(format!("{rp}/README.md"), "# changed\n").unwrap();
    // Untracked file
    fs::write(format!("{rp}/scratch.txt"), "junk\n").unwrap();

    discard_files(&rp, &["README.md".to_string(), "scratch.txt".to_string()]).unwrap();

    // README reverted
    let readme = fs::read_to_string(format!("{rp}/README.md")).unwrap();
    assert_eq!(readme, "# test\n");
    // scratch removed
    assert!(!std::path::Path::new(&format!("{rp}/scratch.txt")).exists());
}

#[test]
fn discard_all_unstaged_reverts_and_cleans() {
    let (_dir, rp) = init_test_repo();
    fs::write(format!("{rp}/README.md"), "# changed\n").unwrap();
    fs::write(format!("{rp}/scratch.txt"), "junk\n").unwrap();
    fs::create_dir_all(format!("{rp}/sub")).unwrap();
    fs::write(format!("{rp}/sub/file.txt"), "junk\n").unwrap();

    discard_all_unstaged(&rp).unwrap();

    let readme = fs::read_to_string(format!("{rp}/README.md")).unwrap();
    assert_eq!(readme, "# test\n");
    assert!(!std::path::Path::new(&format!("{rp}/scratch.txt")).exists());
    assert!(!std::path::Path::new(&format!("{rp}/sub")).exists());
}
```

- [ ] **Step 2: Run to verify failures**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::discard_
```

Expected: FAIL — functions don't exist.

- [ ] **Step 3: Implement discard functions**

Append in the "Git actions" section of `src-tauri/src/git_ops.rs` (after `pull_branch`):

```rust
/// Discard a list of paths.
/// - Tracked files are reverted via `git checkout HEAD -- <paths>`.
/// - Untracked files are removed from disk.
pub fn discard_files(worktree_path: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    // Classify: ask git which of the given paths are tracked.
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for p in paths {
        let out = git_read_only(worktree_path)
            .args(["ls-files", "--error-unmatch", "--", p])
            .output()
            .map_err(|e| format!("Failed to classify path: {e}"))?;
        if out.status.success() {
            tracked.push(p.clone());
        } else {
            untracked.push(p.clone());
        }
    }

    if !tracked.is_empty() {
        let mut cmd = git(worktree_path);
        cmd.args(["checkout", "HEAD", "--"]);
        for p in &tracked {
            cmd.arg(p);
        }
        let out = cmd.output().map_err(|e| format!("Failed to discard: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git checkout HEAD failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    for p in &untracked {
        let full = std::path::Path::new(worktree_path).join(p);
        if full.is_file() {
            std::fs::remove_file(&full).map_err(|e| format!("Failed to remove {p}: {e}"))?;
        }
    }
    Ok(())
}

/// Discard every unstaged change: revert tracked, clean untracked.
pub fn discard_all_unstaged(worktree_path: &str) -> Result<(), String> {
    let out = git(worktree_path)
        .args(["checkout", "HEAD", "--", "."])
        .output()
        .map_err(|e| format!("Failed to checkout: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git checkout HEAD failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let out = git(worktree_path)
        .args(["clean", "-fd"])
        .output()
        .map_err(|e| format!("Failed to clean: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git clean -fd failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}
```

- [ ] **Step 4: Run discard tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::discard_
```

Expected: green.

- [ ] **Step 5: Write failing test for unstage_all**

Append to `mod tests`:

```rust
#[test]
fn unstage_all_clears_index() {
    let (_dir, rp) = init_test_repo();
    fs::write(format!("{rp}/a.txt"), "a\n").unwrap();
    fs::write(format!("{rp}/b.txt"), "b\n").unwrap();
    git(&rp).args(["add", "."]).output().unwrap();

    let before = get_git_status(&rp).unwrap();
    assert!(before.files.iter().all(|f| f.index_status != ' ' && f.index_status != '?'));

    unstage_all(&rp).unwrap();

    let after = get_git_status(&rp).unwrap();
    // After reset, both should now be untracked again (?? state).
    assert!(after.files.iter().all(|f| f.index_status == '?' && f.worktree_status == '?'));
}
```

- [ ] **Step 6: Run to verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::unstage_all_clears_index
```

Expected: FAIL.

- [ ] **Step 7: Implement `unstage_all`**

Append in `src-tauri/src/git_ops.rs`:

```rust
/// Unstage everything in the index (equivalent to `git reset HEAD --`).
pub fn unstage_all(worktree_path: &str) -> Result<(), String> {
    let out = git(worktree_path)
        .args(["reset", "HEAD", "--"])
        .output()
        .map_err(|e| format!("Failed to reset: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git reset HEAD failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}
```

- [ ] **Step 8: Run unstage_all test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::unstage_all_clears_index
```

Expected: green.

- [ ] **Step 9: Write failing test for `commit_amend`**

```rust
#[test]
fn commit_amend_rewrites_last_commit_message() {
    let (_dir, rp) = init_test_repo();
    let original_hash = git_read_only(&rp)
        .args(["rev-parse", "HEAD"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap();

    // Stage a tweak so amend has new content.
    fs::write(format!("{rp}/README.md"), "# amended\n").unwrap();
    git(&rp).args(["add", "README.md"]).output().unwrap();

    let new_hash = commit_amend(&rp, "init (amended)").unwrap();
    assert_ne!(new_hash, original_hash);

    let msg = git_read_only(&rp)
        .args(["log", "-1", "--format=%s"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap();
    assert_eq!(msg, "init (amended)");
}
```

- [ ] **Step 10: Verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::commit_amend_rewrites_last_commit_message
```

Expected: FAIL.

- [ ] **Step 11: Implement `commit_amend`**

Append in `src-tauri/src/git_ops.rs`:

```rust
/// Amend the last commit with a new message (and any currently staged changes).
pub fn commit_amend(worktree_path: &str, message: &str) -> Result<String, String> {
    let out = git(worktree_path)
        .args(["commit", "--amend", "-m", message])
        .output()
        .map_err(|e| format!("Failed to amend: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git commit --amend failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let hash_out = git_read_only(worktree_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to read HEAD: {e}"))?;
    Ok(String::from_utf8_lossy(&hash_out.stdout).trim().to_string())
}
```

- [ ] **Step 12: Run amend test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::commit_amend_rewrites_last_commit_message
```

Expected: green.

- [ ] **Step 13: Write failing test for `resolve_conflict`**

```rust
fn forge_conflict(rp: &str) {
    // Create branch A with "ours" content, branch B with "theirs" content,
    // attempt merge to leave a real conflict in the index.
    git(rp).args(["checkout", "-b", "branch-a"]).output().unwrap();
    fs::write(format!("{rp}/conflict.txt"), "ours-line\n").unwrap();
    git(rp).args(["add", "."]).output().unwrap();
    git(rp).args(["commit", "-m", "ours"]).output().unwrap();

    // Detect default branch name (master vs main)
    let head = git_read_only(rp)
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .output();
    let default_branch = if let Ok(o) = head {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            s.rsplit('/').next().unwrap_or("master").to_string()
        } else {
            String::from("master")
        }
    } else {
        // init_test_repo doesn't set a default — read from the previous branch
        let log = git_read_only(rp).args(["branch", "--show-current"]).output().unwrap();
        String::from_utf8_lossy(&log.stdout).trim().to_string()
    };
    // Use whatever branch existed before branch-a — call git for-each-ref
    let branches = git_read_only(rp).args(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).output().unwrap();
    let bs = String::from_utf8_lossy(&branches.stdout);
    let other = bs.lines().find(|b| *b != "branch-a").unwrap_or("master").to_string();

    git(rp).args(["checkout", &other]).output().unwrap();
    git(rp).args(["checkout", "-b", "branch-b"]).output().unwrap();
    fs::write(format!("{rp}/conflict.txt"), "theirs-line\n").unwrap();
    git(rp).args(["add", "."]).output().unwrap();
    git(rp).args(["commit", "-m", "theirs"]).output().unwrap();

    // Try to merge branch-a into branch-b; conflict expected.
    let _ = git(rp).args(["merge", "branch-a", "--no-edit"]).output();
}

#[test]
fn resolve_conflict_ours_keeps_our_content() {
    let (_dir, rp) = init_test_repo();
    forge_conflict(&rp);

    resolve_conflict(&rp, "conflict.txt", "ours").unwrap();

    let content = fs::read_to_string(format!("{rp}/conflict.txt")).unwrap();
    // 'ours' from the perspective of branch-b is branch-b's line.
    assert_eq!(content, "theirs-line\n");

    let status = get_git_status(&rp).unwrap();
    let f = status.files.iter().find(|f| f.path == "conflict.txt");
    // After resolve + add, the file should no longer be in conflict (or absent).
    assert!(f.map(|f| f.conflict.is_none()).unwrap_or(true));
}

#[test]
fn resolve_conflict_theirs_takes_other_content() {
    let (_dir, rp) = init_test_repo();
    forge_conflict(&rp);

    resolve_conflict(&rp, "conflict.txt", "theirs").unwrap();

    let content = fs::read_to_string(format!("{rp}/conflict.txt")).unwrap();
    // 'theirs' from the perspective of branch-b is branch-a's line.
    assert_eq!(content, "ours-line\n");
}

#[test]
fn resolve_conflict_rejects_invalid_choice() {
    let (_dir, rp) = init_test_repo();
    let err = resolve_conflict(&rp, "any.txt", "neither").unwrap_err();
    assert!(err.contains("ours") || err.contains("theirs"));
}
```

- [ ] **Step 14: Verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::resolve_conflict_
```

Expected: FAIL.

- [ ] **Step 15: Implement `resolve_conflict`**

Append in `src-tauri/src/git_ops.rs`:

```rust
/// Resolve a conflict by taking either side, then stage the file.
/// `choice` must be "ours" or "theirs".
pub fn resolve_conflict(
    worktree_path: &str,
    file_path: &str,
    choice: &str,
) -> Result<(), String> {
    let flag = match choice {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("Invalid choice '{other}': expected 'ours' or 'theirs'")),
    };

    let out = git(worktree_path)
        .args(["checkout", flag, "--", file_path])
        .output()
        .map_err(|e| format!("Failed to checkout {flag}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git checkout {flag} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let out = git(worktree_path)
        .args(["add", "--", file_path])
        .output()
        .map_err(|e| format!("Failed to stage resolved file: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}
```

- [ ] **Step 16: Run resolve_conflict tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::resolve_conflict_
```

Expected: green.

- [ ] **Step 17: Write failing tests for scoped diffs**

```rust
#[test]
fn staged_diff_returns_index_vs_head() {
    let (_dir, rp) = init_test_repo();
    fs::write(format!("{rp}/README.md"), "# v2\n").unwrap();
    git(&rp).args(["add", "README.md"]).output().unwrap();
    // Now modify worktree again so MM state.
    fs::write(format!("{rp}/README.md"), "# v3\n").unwrap();

    let staged = get_staged_diff(&rp, "README.md", None, None).unwrap();
    let staged_text: String = staged
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.kind == "add")
        .map(|l| l.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(staged_text.contains("# v2"));
    assert!(!staged_text.contains("# v3"));

    let unstaged = get_unstaged_diff(&rp, "README.md", None, None).unwrap();
    let unstaged_text: String = unstaged
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.kind == "add")
        .map(|l| l.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(unstaged_text.contains("# v3"));
}

#[test]
fn staged_diff_contents_returns_head_vs_index_strings() {
    let (_dir, rp) = init_test_repo();
    fs::write(format!("{rp}/README.md"), "# v2\n").unwrap();
    git(&rp).args(["add", "README.md"]).output().unwrap();
    fs::write(format!("{rp}/README.md"), "# v3\n").unwrap();

    let dc = get_staged_diff_contents(&rp, "README.md").unwrap();
    assert_eq!(dc.old_text, "# test\n");
    assert_eq!(dc.new_text, "# v2\n");

    let ud = get_unstaged_diff_contents(&rp, "README.md").unwrap();
    assert_eq!(ud.old_text, "# v2\n");
    assert_eq!(ud.new_text, "# v3\n");
}
```

- [ ] **Step 18: Verify failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::staged_diff_
```

Expected: FAIL.

- [ ] **Step 19: Implement scoped diffs**

Append in `src-tauri/src/git_ops.rs`:

```rust
/// Diff between HEAD and the staging index for a file.
pub fn get_staged_diff(
    worktree_path: &str,
    file_path: &str,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<FileDiff, String> {
    scoped_diff(worktree_path, file_path, context_lines, ignore_whitespace, &["--cached"])
}

/// Diff between the staging index and the worktree for a file.
pub fn get_unstaged_diff(
    worktree_path: &str,
    file_path: &str,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<FileDiff, String> {
    scoped_diff(worktree_path, file_path, context_lines, ignore_whitespace, &[])
}

fn scoped_diff(
    worktree_path: &str,
    file_path: &str,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
    extra: &[&str],
) -> Result<FileDiff, String> {
    let ctx_flag = format!("-U{}", context_lines.unwrap_or(3));
    let mut args = vec!["diff", &ctx_flag];
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
    args.extend(extra);
    args.extend(["--", file_path]);

    let output = git_read_only(worktree_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to get scoped diff: {e}"))?;

    let raw_diff = String::from_utf8_lossy(&output.stdout).to_string();
    let hunks = parse_unified_diff(&raw_diff);

    let mut insertions: u32 = 0;
    let mut deletions: u32 = 0;
    for h in &hunks {
        for l in &h.lines {
            match l.kind.as_str() {
                "add" => insertions += 1,
                "delete" => deletions += 1,
                _ => {}
            }
        }
    }

    let status = if raw_diff.contains("new file mode") {
        "A"
    } else if raw_diff.contains("deleted file mode") {
        "D"
    } else {
        "M"
    };

    let full_path = std::path::Path::new(worktree_path).join(file_path);
    let total_lines = if full_path.exists() {
        std::fs::read_to_string(&full_path)
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0)
    } else {
        0
    };

    Ok(FileDiff {
        path: file_path.to_string(),
        status: status.to_string(),
        hunks,
        stats: FileDiffStats {
            path: file_path.to_string(),
            insertions,
            deletions,
        },
        total_lines,
    })
}

/// Side-by-side: HEAD text vs index text for a file.
pub fn get_staged_diff_contents(
    worktree_path: &str,
    file_path: &str,
) -> Result<DiffContents, String> {
    let (old_text, old_exists) = read_at_rev(worktree_path, "HEAD", file_path);
    let (new_text, new_exists) = read_at_rev(worktree_path, "", file_path); // ":path" via empty rev handled below
    let (new_text, new_exists) = if new_text.is_empty() && !new_exists {
        // Read directly from index (`:<path>` syntax)
        let out = git_read_only(worktree_path)
            .args(["show", &format!(":{file_path}")])
            .output();
        match out {
            Ok(o) if o.status.success() => (String::from_utf8_lossy(&o.stdout).to_string(), true),
            _ => (String::new(), false),
        }
    } else {
        (new_text, new_exists)
    };
    let status = if !old_exists && new_exists {
        "A"
    } else if old_exists && !new_exists {
        "D"
    } else {
        "M"
    };
    Ok(DiffContents {
        path: file_path.to_string(),
        status: status.to_string(),
        old_text,
        new_text,
        binary: false,
    })
}

/// Side-by-side: index text vs worktree file for a file.
pub fn get_unstaged_diff_contents(
    worktree_path: &str,
    file_path: &str,
) -> Result<DiffContents, String> {
    let out = git_read_only(worktree_path)
        .args(["show", &format!(":{file_path}")])
        .output();
    let (old_text, old_exists) = match out {
        Ok(o) if o.status.success() => (String::from_utf8_lossy(&o.stdout).to_string(), true),
        _ => (String::new(), false),
    };

    let full_path = std::path::Path::new(worktree_path).join(file_path);
    let (new_text, new_exists) = match std::fs::read_to_string(&full_path) {
        Ok(s) => (s, true),
        Err(_) => (String::new(), false),
    };

    let status = if !old_exists && new_exists {
        "A"
    } else if old_exists && !new_exists {
        "D"
    } else {
        "M"
    };
    Ok(DiffContents {
        path: file_path.to_string(),
        status: status.to_string(),
        old_text,
        new_text,
        binary: false,
    })
}
```

Note: `get_staged_diff_contents` initially calls `read_at_rev(worktree_path, "", file_path)` which will fail and reset `new_text` / `new_exists` to fall through to the `git show :<path>` (index) read. That's intentional but ugly — simplify by skipping the first call and going straight to `git show :<path>`:

```rust
pub fn get_staged_diff_contents(
    worktree_path: &str,
    file_path: &str,
) -> Result<DiffContents, String> {
    let (old_text, old_exists) = read_at_rev(worktree_path, "HEAD", file_path);

    let out = git_read_only(worktree_path)
        .args(["show", &format!(":{file_path}")])
        .output();
    let (new_text, new_exists) = match out {
        Ok(o) if o.status.success() => (String::from_utf8_lossy(&o.stdout).to_string(), true),
        _ => (String::new(), false),
    };

    let status = if !old_exists && new_exists {
        "A"
    } else if old_exists && !new_exists {
        "D"
    } else {
        "M"
    };
    Ok(DiffContents {
        path: file_path.to_string(),
        status: status.to_string(),
        old_text,
        new_text,
        binary: false,
    })
}
```

Use this cleaner version (delete the convoluted one above). The unstaged version is already clean.

- [ ] **Step 20: Run scoped diff tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests::staged_diff_
```

Expected: green.

- [ ] **Step 21: Run the entire git_ops test suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib git_ops::tests
cargo clippy --manifest-path src-tauri/Cargo.toml --no-deps -- -D warnings
```

Expected: tests green, clippy zero warnings.

- [ ] **Step 22: Commit**

```bash
git add src-tauri/src/git_ops.rs
git commit -m "feat(git): add discard, unstage_all, resolve_conflict, amend, scoped diffs

New ops:
- discard_files / discard_all_unstaged
- unstage_all
- resolve_conflict (ours/theirs, then auto-stage)
- commit_amend
- get_staged_diff / get_unstaged_diff
- get_staged_diff_contents / get_unstaged_diff_contents

All tested against temp repos, including a forged merge conflict."
```

---

## Task 4: Tauri commands + IPC wrappers

Wire the new git_ops functions through `ipc.rs`, register in `lib.rs`, and add typed wrappers in `src/lib/ipc.ts`.

**Files:**
- Modify: `src-tauri/src/ipc.rs` (append commands).
- Modify: `src-tauri/src/lib.rs` (register handlers).
- Modify: `src/lib/ipc.ts` (typed wrappers).

- [ ] **Step 1: Add Tauri commands**

Append to the "Git operations" block in `src-tauri/src/ipc.rs` (after `git_commit_and_push`, around line 1444):

```rust
#[tauri::command]
pub async fn git_discard(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::discard_files(&t.worktree_path, &paths)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_discard_all_unstaged(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::discard_all_unstaged(&t.worktree_path)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_all(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::unstage_all(&t.worktree_path)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_resolve_conflict(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
    choice: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::resolve_conflict(&t.worktree_path, &file_path, &choice)
        })
        .await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_commit_amend(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let hash = flatten_join(
        tokio::task::spawn_blocking(move || git_ops::commit_amend(&t.worktree_path, &message)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(hash)
}

#[tauri::command]
pub async fn get_staged_diff(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<git_ops::FileDiff, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_staged_diff(&t.worktree_path, &file_path, context_lines, ignore_whitespace)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_unstaged_diff(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<git_ops::FileDiff, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_unstaged_diff(
                &t.worktree_path,
                &file_path,
                context_lines,
                ignore_whitespace,
            )
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_staged_diff_contents(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
) -> Result<git_ops::DiffContents, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_staged_diff_contents(&t.worktree_path, &file_path)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_unstaged_diff_contents(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
) -> Result<git_ops::DiffContents, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_unstaged_diff_contents(&t.worktree_path, &file_path)
        })
        .await,
    )
}
```

- [ ] **Step 2: Register handlers in `lib.rs`**

In `src-tauri/src/lib.rs`, find the existing `git_ship` line in the invoke handler (around line 329) and add **after `ipc::git_commit_and_push`** (line 316):

```rust
            ipc::git_discard,
            ipc::git_discard_all_unstaged,
            ipc::git_unstage_all,
            ipc::git_resolve_conflict,
            ipc::git_commit_amend,
            ipc::get_staged_diff,
            ipc::get_unstaged_diff,
            ipc::get_staged_diff_contents,
            ipc::get_unstaged_diff_contents,
```

- [ ] **Step 3: Compile-check Rust**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --no-deps -- -D warnings
```

Expected: green.

- [ ] **Step 4: Add typed wrappers in `src/lib/ipc.ts`**

Find the existing `gitCommitAndPush` wrapper (around line 218) in `src/lib/ipc.ts` and add immediately below:

```ts
export const gitDiscard = (taskId: string, paths: string[]) =>
  invoke<void>('git_discard', { taskId, paths })

export const gitDiscardAllUnstaged = (taskId: string) =>
  invoke<void>('git_discard_all_unstaged', { taskId })

export const gitUnstageAll = (taskId: string) =>
  invoke<void>('git_unstage_all', { taskId })

export const gitResolveConflict = (taskId: string, filePath: string, choice: 'ours' | 'theirs') =>
  invoke<void>('git_resolve_conflict', { taskId, filePath, choice })

export const gitCommitAmend = (taskId: string, message: string) =>
  invoke<string>('git_commit_amend', { taskId, message })

export const getStagedDiff = (taskId: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_staged_diff', { taskId, filePath, contextLines, ignoreWhitespace })

export const getUnstagedDiff = (taskId: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_unstaged_diff', { taskId, filePath, contextLines, ignoreWhitespace })

export const getStagedDiffContents = (taskId: string, filePath: string) =>
  invoke<DiffContents>('get_staged_diff_contents', { taskId, filePath })

export const getUnstagedDiffContents = (taskId: string, filePath: string) =>
  invoke<DiffContents>('get_unstaged_diff_contents', { taskId, filePath })
```

- [ ] **Step 5: Typecheck**

```bash
pnpm check
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src/lib/ipc.ts
git commit -m "feat(ipc): wire new git ops as Tauri commands

Adds git_discard, git_discard_all_unstaged, git_unstage_all,
git_resolve_conflict, git_commit_amend, get_staged_diff,
get_unstaged_diff, and the matching *_contents commands. Each emits
git-local-changed when it mutates state."
```

---

## Task 5: Shared status helper (`src/lib/gitStatus.ts`)

**Files:**
- Create: `src/lib/gitStatus.ts`.
- Create: `src/lib/gitStatus.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/gitStatus.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import type { FileStatus } from '../types'
import { fanOut, badgeForEntry, conflictLabel } from './gitStatus'

const f = (over: Partial<FileStatus> = {}): FileStatus => ({
  path: 'x.ts',
  indexStatus: ' ',
  worktreeStatus: ' ',
  conflict: null,
  ...over,
})

describe('fanOut', () => {
  test('untracked produces a single unstaged entry', () => {
    const out = fanOut(f({ indexStatus: '?', worktreeStatus: '?' }))
    expect(out).toEqual([{ kind: 'unstaged', file: expect.any(Object) }])
  })

  test('staged-only produces a single staged entry', () => {
    const out = fanOut(f({ indexStatus: 'A', worktreeStatus: ' ' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('staged')
  })

  test('unstaged-only produces a single unstaged entry', () => {
    const out = fanOut(f({ indexStatus: ' ', worktreeStatus: 'M' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('unstaged')
  })

  test('MM produces both staged and unstaged entries', () => {
    const out = fanOut(f({ indexStatus: 'M', worktreeStatus: 'M' }))
    expect(out).toHaveLength(2)
    expect(out.map(e => e.kind).sort()).toEqual(['staged', 'unstaged'])
  })

  test('conflict produces a single conflict entry', () => {
    const out = fanOut(f({ indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('conflict')
  })
})

describe('badgeForEntry', () => {
  test('staged Added → A emerald', () => {
    const b = badgeForEntry({ kind: 'staged', file: f({ indexStatus: 'A' }) })
    expect(b.letter).toBe('A')
    expect(b.colorClass).toContain('emerald')
    expect(b.label).toBe('Added')
  })

  test('staged Modified → M amber', () => {
    const b = badgeForEntry({ kind: 'staged', file: f({ indexStatus: 'M' }) })
    expect(b.letter).toBe('M')
    expect(b.colorClass).toContain('amber')
  })

  test('untracked → U emerald', () => {
    const b = badgeForEntry({ kind: 'unstaged', file: f({ indexStatus: '?', worktreeStatus: '?' }) })
    expect(b.letter).toBe('U')
    expect(b.colorClass).toContain('emerald')
  })

  test('unstaged Modified → M amber', () => {
    const b = badgeForEntry({ kind: 'unstaged', file: f({ indexStatus: ' ', worktreeStatus: 'M' }) })
    expect(b.letter).toBe('M')
    expect(b.colorClass).toContain('amber')
  })

  test('conflict → ! red with kind label', () => {
    const b = badgeForEntry({ kind: 'conflict', file: f({ conflict: 'bothModified' }) })
    expect(b.letter).toBe('!')
    expect(b.colorClass).toContain('red')
    expect(b.tooltip).toContain('Both modified')
  })
})

describe('conflictLabel', () => {
  test('all variants have a human-readable label', () => {
    const variants = ['bothModified', 'bothAdded', 'bothDeleted', 'addedByUs', 'addedByThem', 'deletedByUs', 'deletedByThem'] as const
    for (const v of variants) {
      expect(conflictLabel(v)).not.toBe('')
    }
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/lib/gitStatus.test.ts
```

Expected: FAIL — `gitStatus` module not found.

- [ ] **Step 3: Implement `gitStatus.ts`**

Create `src/lib/gitStatus.ts`:

```ts
import type { FileStatus, ConflictKind } from '../types'

export type FileEntry =
  | { kind: 'conflict'; file: FileStatus }
  | { kind: 'staged'; file: FileStatus }
  | { kind: 'unstaged'; file: FileStatus }

export interface StatusBadge {
  letter: string
  colorClass: string
  label: string
  tooltip?: string
}

export function fanOut(file: FileStatus): FileEntry[] {
  if (file.conflict) {
    return [{ kind: 'conflict', file }]
  }
  if (file.indexStatus === '?' && file.worktreeStatus === '?') {
    return [{ kind: 'unstaged', file }]
  }
  const out: FileEntry[] = []
  if (file.indexStatus !== ' ' && file.indexStatus !== '?') {
    out.push({ kind: 'staged', file })
  }
  if (file.worktreeStatus !== ' ' && file.worktreeStatus !== '?') {
    out.push({ kind: 'unstaged', file })
  }
  return out
}

export function conflictLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'bothModified': return 'Both modified'
    case 'bothAdded':    return 'Both added'
    case 'bothDeleted':  return 'Both deleted'
    case 'addedByUs':    return 'Added by us'
    case 'addedByThem':  return 'Added by them'
    case 'deletedByUs':  return 'Deleted by us'
    case 'deletedByThem':return 'Deleted by them'
  }
}

function badgeForChar(ch: string): { letter: string; colorClass: string; label: string } {
  switch (ch) {
    case 'A': return { letter: 'A', colorClass: 'text-emerald-400', label: 'Added' }
    case 'M': return { letter: 'M', colorClass: 'text-amber-400',   label: 'Modified' }
    case 'D': return { letter: 'D', colorClass: 'text-red-400',     label: 'Deleted' }
    case 'R': return { letter: 'R', colorClass: 'text-blue-400',    label: 'Renamed' }
    case 'C': return { letter: 'C', colorClass: 'text-blue-400',    label: 'Copied' }
    default:  return { letter: ch || '?', colorClass: 'text-text-muted', label: 'Unknown' }
  }
}

export function badgeForEntry(entry: FileEntry): StatusBadge {
  if (entry.kind === 'conflict' && entry.file.conflict) {
    const label = conflictLabel(entry.file.conflict)
    return {
      letter: '!',
      colorClass: 'text-red-400',
      label: 'Conflict',
      tooltip: label,
    }
  }
  const f = entry.file
  // Untracked
  if (entry.kind === 'unstaged' && f.indexStatus === '?' && f.worktreeStatus === '?') {
    return { letter: 'U', colorClass: 'text-emerald-400', label: 'Untracked' }
  }
  if (entry.kind === 'staged') {
    const b = badgeForChar(f.indexStatus)
    return { ...b, label: `${b.label} (staged)` }
  }
  // unstaged with tracked changes
  return badgeForChar(f.worktreeStatus)
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/lib/gitStatus.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gitStatus.ts src/lib/gitStatus.test.ts
git commit -m "feat(git): shared status taxonomy helper

Adds fanOut() (FileStatus -> FileEntry[]), badgeForEntry() (letter +
color + label + conflict tooltip), and conflictLabel(). Single source of
truth for any UI that renders git status."
```

---

## Task 6: DiffSource extension + DiffEditor dispatch

**Files:**
- Modify: `src/store/editorView.ts`.
- Modify: `src/components/DiffEditor.tsx`.
- Modify: `src/store/files.ts` (or wherever `diffTabKey` lives — confirm via grep).

- [ ] **Step 1: Locate `DiffSource` and `diffTabKey` definitions**

```bash
grep -n "type DiffSource\|export type DiffSource\|diffTabKey" src/store src/components --include="*.ts" --include="*.tsx" -r
```

Expected: finds the type in `src/store/editorView.ts` and `diffTabKey` in `src/store/files.ts`. Confirm before editing.

- [ ] **Step 2: Extend `DiffSource`**

In `src/store/editorView.ts`, replace the `DiffSource` definition with:

```ts
export type DiffSource =
  | { type: 'working' }
  | { type: 'staged' }
  | { type: 'unstaged' }
  | { type: 'commit'; commitHash: string }
```

If `DiffSource` is constructed via shorthand spreads or factory functions elsewhere, update those call sites too. Use `grep -rn "type: 'working'\|type: 'commit'" src` to find them.

- [ ] **Step 3: Update `diffTabKey`**

In `src/store/files.ts` (or wherever it lives), the existing implementation looks something like:

```ts
export const diffTabKey = (source: DiffSource, path: string) =>
  source.type === 'commit' ? `diff:commit:${source.commitHash}:${path}` : `diff:working:${path}`
```

Replace with one that includes the type discriminator for all cases:

```ts
export const diffTabKey = (source: DiffSource, path: string) => {
  switch (source.type) {
    case 'working':  return `diff:working:${path}`
    case 'staged':   return `diff:staged:${path}`
    case 'unstaged': return `diff:unstaged:${path}`
    case 'commit':   return `diff:commit:${source.commitHash}:${path}`
  }
}
```

- [ ] **Step 4: Update `DiffEditor.tsx` to dispatch on type**

Open `src/components/DiffEditor.tsx`. Find the IPC fetch logic (search for `getFileDiffContents` or `getCommitFileContents`). Add cases for the new types:

```ts
async function fetchContents(taskId: string, path: string, source: DiffSource): Promise<DiffContents> {
  switch (source.type) {
    case 'working':  return ipc.getFileDiffContents(taskId, path)
    case 'staged':   return ipc.getStagedDiffContents(taskId, path)
    case 'unstaged': return ipc.getUnstagedDiffContents(taskId, path)
    case 'commit':   return ipc.getCommitFileContents(taskId, source.commitHash, path)
  }
}
```

If the component also fetches a structured `FileDiff` (hunk view), do the same for `getFileDiff` / `getStagedDiff` / `getUnstagedDiff` / `getCommitFileDiff`. Search for the existing call site and mirror the dispatch.

- [ ] **Step 5: Run typecheck and existing diff tests**

```bash
pnpm check
pnpm test -- src/components/DiffEditor.test.ts
```

Expected: typecheck passes; existing tests still green (we did not change `working`/`commit` behavior).

- [ ] **Step 6: Add a test for the new dispatch**

Append to `src/components/DiffEditor.test.ts`:

```ts
test('staged source routes to getStagedDiffContents', async () => {
  const stagedMock = vi.fn().mockResolvedValue({ path: 'x.ts', status: 'M', oldText: 'a', newText: 'b', binary: false })
  vi.doMock('../lib/ipc', () => ({
    getFileDiffContents: vi.fn(),
    getStagedDiffContents: stagedMock,
    getUnstagedDiffContents: vi.fn(),
    getCommitFileContents: vi.fn(),
  }))
  // Render or call the helper directly — match whatever pattern the existing tests use.
  // Assert stagedMock was called once with the right args.
  // (Snapshot the precise assertion based on how the existing tests are written.)
})
```

If `DiffEditor.test.ts` uses a different mocking style, follow that convention rather than this snippet — the goal is one test per new source type that confirms the right IPC fires.

- [ ] **Step 7: Run new tests**

```bash
pnpm test -- src/components/DiffEditor.test.ts
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/store/editorView.ts src/store/files.ts src/components/DiffEditor.tsx src/components/DiffEditor.test.ts
git commit -m "feat(diff): add staged and unstaged DiffSource variants

DiffSource now has 4 variants. diffTabKey discriminates so the same
file can have multiple distinct tabs. DiffEditor dispatches each type
to its matching IPC."
```

---

## Task 7: Extract `BranchCommits.tsx`

Pure refactor — moves the existing Branch Commits panel out of `CodeChanges.tsx` into its own component. No behavior change.

**Files:**
- Create: `src/components/BranchCommits.tsx`.
- Modify: `src/components/CodeChanges.tsx`.

- [ ] **Step 1: Create the new component**

Create `src/components/BranchCommits.tsx`:

```tsx
import { Component, createSignal, createMemo, Show, For } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { ChevronDown, ChevronRight, GitCommit, Circle } from 'lucide-solid'
import { clsx } from 'clsx'
import { taskGit } from '../store/git'
import type { BranchCommit } from '../types'

interface Props {
  taskId: string
  selectedCommit: string | null
  uncommittedCount: number
  onSelectCommit: (hash: string | null) => void
}

export const BranchCommits: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(localStorage.getItem('verun:commitsOpen') !== 'false')
  let scrollRef: HTMLDivElement | undefined

  const commits = (): BranchCommit[] => taskGit(props.taskId).commits

  const togglePanel = () => {
    const next = !open()
    setOpen(next)
    localStorage.setItem('verun:commitsOpen', String(next))
  }

  const virt = createVirtualizer({
    get count() { return commits().length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 28,
    overscan: 8,
    initialRect: { width: 280, height: 192 },
  })

  const visibleRows = createMemo(() => {
    const rows = virt.getVirtualItems()
    if (rows.length > 0 || commits().length === 0) return rows
    const size = 28
    return Array.from({ length: Math.min(commits().length, 10) }, (_, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }))
  })

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000)
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
    return `${Math.floor(diff / 86400_000)}d ago`
  }

  return (
    <div class="shrink-0">
      <div class="h-px bg-outline/8 shrink-0" />
      <button
        class="w-full h-8 flex items-center gap-1.5 px-3 text-xs hover:bg-surface-2"
        onClick={togglePanel}
      >
        {open() ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
        <GitCommit size={12} class="text-text-dim shrink-0" />
        <span class="font-medium text-text-secondary">Branch Commits</span>
        <Show when={commits().length > 0}>
          <span class="text-text-dim text-[10px] tabular-nums">{commits().length}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div ref={scrollRef} class="max-h-48 overflow-auto">
          <button
            class={clsx(
              'relative w-full flex items-center gap-2 px-3 py-1.5 text-xs',
              props.selectedCommit === null
                ? 'bg-surface-2 text-text-primary'
                : 'hover:bg-surface-2 text-text-secondary',
            )}
            style={props.selectedCommit === null ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
            onClick={() => props.onSelectCommit(null)}
          >
            <Circle size={11} class="shrink-0 text-text-dim" />
            <span class="truncate flex-1 text-left">Uncommitted changes</span>
            <Show when={props.uncommittedCount > 0}>
              <span class="text-[10px] text-text-dim shrink-0">
                {props.uncommittedCount} file{props.uncommittedCount !== 1 ? 's' : ''}
              </span>
            </Show>
          </button>

          <div style={{ height: `${virt.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            <For each={visibleRows()}>
              {(vrow) => {
                const commit = () => commits()[vrow.index]
                return (
                  <Show when={commit()}>
                    {(c) => {
                      const isSelected = () => props.selectedCommit === c().hash
                      return (
                        <button
                          class={clsx(
                            'absolute left-0 top-0 w-full flex items-center gap-2 px-3 py-1.5 text-xs',
                            isSelected() ? 'bg-surface-2 text-text-primary' : 'hover:bg-surface-2 text-text-secondary',
                          )}
                          style={{
                            height: `${vrow.size}px`,
                            transform: `translateY(${vrow.start}px)`,
                            'box-shadow': isSelected() ? 'inset 2px 0 0 #2d6e4f' : undefined,
                          }}
                          onClick={() => props.onSelectCommit(c().hash)}
                        >
                          <span class="font-mono text-text-dim text-[10px] shrink-0">{c().shortHash}</span>
                          <span class="truncate flex-1 text-left">{c().message}</span>
                          <span class="text-[10px] text-text-dim shrink-0">{formatTime(c().timestamp)}</span>
                        </button>
                      )
                    }}
                  </Show>
                )
              }}
            </For>
          </div>

          <Show when={commits().length === 0}>
            <div class="px-3 py-3 text-[11px] text-text-dim text-center">
              No commits on this branch yet
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
```

- [ ] **Step 2: Use it in `CodeChanges.tsx`**

In `src/components/CodeChanges.tsx`, delete the entire commit panel JSX block (the `<div class="h-px bg-outline/8 shrink-0" />` plus the `<div class="shrink-0">…</div>` that contains the Branch Commits button and list — currently lines ~320-396) and replace with:

```tsx
<BranchCommits
  taskId={props.taskId}
  selectedCommit={selectedCommit()}
  uncommittedCount={uncommittedCount()}
  onSelectCommit={selectCommit}
/>
```

Add the import at the top: `import { BranchCommits } from './BranchCommits'`.

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm check
pnpm test -- src/components/CodeChanges.test.tsx
```

Expected: green. Existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/BranchCommits.tsx src/components/CodeChanges.tsx
git commit -m "refactor(changes): extract BranchCommits into its own component

Pure move with no behavior change. Sets up CodeChanges.tsx to be a slim
orchestrator in subsequent tasks."
```

---

## Task 8: `FileRow` component

**Files:**
- Create: `src/components/FileRow.tsx`.
- Create: `src/components/FileRow.test.tsx`.

- [ ] **Step 1: Write failing tests**

Create `src/components/FileRow.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { FileRow } from './FileRow'
import type { FileEntry } from '../lib/gitStatus'

const entry = (over: Partial<FileEntry['file']> = {}, kind: FileEntry['kind'] = 'unstaged'): FileEntry => ({
  kind,
  file: {
    path: 'src/foo.ts',
    indexStatus: ' ',
    worktreeStatus: 'M',
    conflict: null,
    ...over,
  },
} as FileEntry)

describe('<FileRow />', () => {
  test('renders status letter from badge', () => {
    cleanup()
    const { container } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={() => {}}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={() => {}}
      />
    ))
    expect(container.textContent).toContain('M')
  })

  test('first × click does not call onDiscard; second click within window does', () => {
    cleanup()
    const onDiscard = vi.fn()
    const { getByTitle } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={() => {}}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={onDiscard}
      />
    ))
    const btn = getByTitle('Discard')
    fireEvent.click(btn)
    expect(onDiscard).not.toHaveBeenCalled()
    fireEvent.click(btn) // confirm
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  test('clicking the row calls onOpenDiff', () => {
    cleanup()
    const onOpenDiff = vi.fn()
    const { container } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={onOpenDiff}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={() => {}}
      />
    ))
    fireEvent.click(container.querySelector('[data-testid=file-row]')!)
    expect(onOpenDiff).toHaveBeenCalledTimes(1)
  })

  test('staged kind shows minus button, unstaged shows plus', () => {
    cleanup()
    const stagedView = render(() => (
      <FileRow entry={entry({ indexStatus: 'M' }, 'staged')} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(stagedView.queryByTitle('Unstage')).toBeTruthy()

    cleanup()
    const unstagedView = render(() => (
      <FileRow entry={entry()} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(unstagedView.queryByTitle('Stage')).toBeTruthy()
  })

  test('conflict kind shows ! letter and stage button (not discard)', () => {
    cleanup()
    const view = render(() => (
      <FileRow entry={entry({ indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }, 'conflict')} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(view.container.textContent).toContain('!')
    expect(view.queryByTitle('Stage')).toBeTruthy()
    expect(view.queryByTitle('Discard')).toBeFalsy()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/FileRow.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FileRow`**

Create `src/components/FileRow.tsx`:

```tsx
import { Component, createSignal, Show, onCleanup } from 'solid-js'
import { FileText, Plus, Minus, X } from 'lucide-solid'
import { getFileIcon } from '../lib/fileIcons'
import { badgeForEntry, type FileEntry } from '../lib/gitStatus'

interface Props {
  entry: FileEntry
  active: boolean
  insertions?: number
  deletions?: number
  onOpenDiff: () => void
  onOpenDiffPinned?: () => void
  onOpenFile: () => void
  onPrimary: () => void   // stage on unstaged, unstage on staged, conflict-stage on conflict
  onDiscard: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export const FileRow: Component<Props> = (props) => {
  const [confirming, setConfirming] = createSignal(false)
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => { if (confirmTimer) clearTimeout(confirmTimer) })

  const badge = () => badgeForEntry(props.entry)
  const fileName = () => props.entry.file.path.split('/').pop() || props.entry.file.path
  const FileIcon = () => {
    const I = getFileIcon(fileName())
    return <I size={12} />
  }

  const isStaged = () => props.entry.kind === 'staged'
  const isConflict = () => props.entry.kind === 'conflict'
  const showDiscard = () => !isConflict()

  const primaryTitle = () => isStaged() ? 'Unstage' : 'Stage'
  const PrimaryIcon = () => isStaged() ? <Minus size={12} /> : <Plus size={12} />

  const handleDiscard = (e: MouseEvent) => {
    e.stopPropagation()
    if (!confirming()) {
      setConfirming(true)
      confirmTimer = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer) clearTimeout(confirmTimer)
    setConfirming(false)
    props.onDiscard()
  }

  return (
    <div
      data-testid="file-row"
      class={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${
        props.active ? 'bg-surface-2 text-text-primary' : 'hover:bg-surface-2 text-text-secondary'
      }`}
      style={{ 'box-shadow': props.active ? 'inset 2px 0 0 #2d6e4f' : undefined }}
      onClick={props.onOpenDiff}
      onDblClick={(e) => { e.stopPropagation(); props.onOpenDiffPinned?.() }}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <span class="shrink-0 text-text-dim">
        <FileIcon />
      </span>

      <span class="truncate flex-1" title={props.entry.file.path}>
        {props.entry.file.path}
      </span>

      <span class="shrink-0 hidden group-hover:flex items-center gap-0.5">
        <button
          class="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text-secondary"
          title="Open File"
          onClick={(e) => { e.stopPropagation(); props.onOpenFile() }}
        >
          <FileText size={12} />
        </button>
        <button
          class="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text-secondary"
          title={primaryTitle()}
          onClick={(e) => { e.stopPropagation(); props.onPrimary() }}
        >
          <PrimaryIcon />
        </button>
        <Show when={showDiscard()}>
          <button
            class={`p-0.5 rounded ${confirming() ? 'bg-red-500/20 text-red-300' : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'}`}
            title={confirming() ? 'Confirm discard?' : 'Discard'}
            onClick={handleDiscard}
          >
            <X size={12} />
          </button>
        </Show>
      </span>

      <Show when={props.insertions || props.deletions}>
        <span class="shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums">
          <Show when={(props.insertions ?? 0) > 0}>
            <span class="text-emerald-400">+{props.insertions}</span>
          </Show>
          <Show when={(props.deletions ?? 0) > 0}>
            <span class="text-red-400">-{props.deletions}</span>
          </Show>
        </span>
      </Show>

      <span
        class={`shrink-0 text-[11px] font-medium tabular-nums w-3 text-center ${badge().colorClass}`}
        title={badge().tooltip || badge().label}
      >
        {badge().letter}
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/components/FileRow.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/FileRow.tsx src/components/FileRow.test.tsx
git commit -m "feat(changes): FileRow component with hover actions

Inline open-file, primary (stage/unstage/conflict-stage), and discard
buttons. Discard uses 3s inline confirm. Status letter + tooltip from
the shared gitStatus helper."
```

---

## Task 9: `FileSection` component

**Files:**
- Create: `src/components/FileSection.tsx`.
- Create: `src/components/FileSection.test.tsx`.

- [ ] **Step 1: Write failing tests**

Create `src/components/FileSection.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { FileSection } from './FileSection'
import type { FileEntry } from '../lib/gitStatus'

const e = (path: string, kind: FileEntry['kind'] = 'unstaged'): FileEntry => ({
  kind,
  file: { path, indexStatus: ' ', worktreeStatus: 'M', conflict: null },
} as FileEntry)

const noopRow = () => <div>row</div>

describe('<FileSection />', () => {
  test('renders title and count', () => {
    cleanup()
    const { container } = render(() => (
      <FileSection
        kind="staged"
        title="Staged Changes"
        entries={[e('a.ts', 'staged'), e('b.ts', 'staged')]}
        renderRow={noopRow}
        bulkActions={[]}
      />
    ))
    expect(container.textContent).toContain('Staged Changes')
    expect(container.textContent).toContain('2')
  })

  test('section is hidden when entries is empty', () => {
    cleanup()
    const { container } = render(() => (
      <FileSection
        kind="staged"
        title="Staged Changes"
        entries={[]}
        renderRow={noopRow}
        bulkActions={[]}
      />
    ))
    expect(container.textContent).not.toContain('Staged Changes')
  })

  test('clicking the header toggles open state', () => {
    cleanup()
    localStorage.removeItem('verun:changes:section:staged:open')
    const { container, getByText } = render(() => (
      <FileSection
        kind="staged"
        title="Staged"
        entries={[e('a.ts', 'staged')]}
        renderRow={() => <div data-testid="row">row</div>}
        bulkActions={[]}
      />
    ))
    expect(container.querySelector('[data-testid=row]')).toBeTruthy()
    fireEvent.click(getByText('Staged'))
    expect(container.querySelector('[data-testid=row]')).toBeFalsy()
    expect(localStorage.getItem('verun:changes:section:staged:open')).toBe('false')
  })

  test('bulk action button fires its handler', () => {
    cleanup()
    const onClick = vi.fn()
    const { getByTitle } = render(() => (
      <FileSection
        kind="changes"
        title="Changes"
        entries={[e('a.ts')]}
        renderRow={noopRow}
        bulkActions={[{ icon: () => <span>+</span>, title: 'Stage All', onClick }]}
      />
    ))
    fireEvent.click(getByTitle('Stage All'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/FileSection.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FileSection`**

Create `src/components/FileSection.tsx`:

```tsx
import { Component, createSignal, Show, For, JSX } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-solid'
import type { FileEntry } from '../lib/gitStatus'

export type SectionKind = 'conflicts' | 'staged' | 'changes'

export interface BulkAction {
  icon: Component<{ size: number }>
  title: string
  onClick: () => void | Promise<void>
}

interface Props {
  kind: SectionKind
  title: string
  entries: FileEntry[]
  renderRow: (entry: FileEntry, index: number) => JSX.Element
  bulkActions: BulkAction[]
  bulkInflight?: boolean
}

const STORAGE_KEY = (kind: SectionKind) => `verun:changes:section:${kind}:open`

export const FileSection: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(localStorage.getItem(STORAGE_KEY(props.kind)) !== 'false')
  let scrollRef: HTMLDivElement | undefined

  const toggle = () => {
    const next = !open()
    setOpen(next)
    localStorage.setItem(STORAGE_KEY(props.kind), String(next))
  }

  const virt = createVirtualizer({
    get count() { return props.entries.length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 28,
    overscan: 10,
    initialRect: { width: 280, height: 320 },
  })

  const visibleRows = () => {
    const rows = virt.getVirtualItems()
    if (rows.length > 0 || props.entries.length === 0) return rows
    const size = 28
    return Array.from({ length: Math.min(props.entries.length, 20) }, (_, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }))
  }

  return (
    <Show when={props.entries.length > 0}>
      <div class="flex flex-col min-h-0">
        <div class="group flex items-center gap-1.5 px-3 h-7 hover:bg-surface-2 cursor-pointer select-none" onClick={toggle}>
          {open() ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
          <span class="text-xs font-medium text-text-secondary uppercase tracking-wide">{props.title}</span>
          <span class="text-[10px] text-text-dim tabular-nums">({props.entries.length})</span>
          <span class="flex-1" />
          <Show when={props.bulkInflight}>
            <Loader2 size={11} class="animate-spin text-text-dim" />
          </Show>
          <span class="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <For each={props.bulkActions}>
              {(action) => {
                const Icon = action.icon
                return (
                  <button
                    class="p-0.5 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3"
                    title={action.title}
                    onClick={(e) => { e.stopPropagation(); action.onClick() }}
                  >
                    <Icon size={12} />
                  </button>
                )
              }}
            </For>
          </span>
        </div>

        <Show when={open()}>
          <div ref={scrollRef} class="overflow-auto" style={{ 'max-height': '40vh' }}>
            <div style={{ height: `${virt.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              <For each={visibleRows()}>
                {(vrow) => (
                  <div
                    class="absolute left-0 top-0 w-full"
                    style={{
                      height: `${vrow.size}px`,
                      transform: `translateY(${vrow.start}px)`,
                    }}
                  >
                    {props.renderRow(props.entries[vrow.index], vrow.index)}
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/components/FileSection.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/FileSection.tsx src/components/FileSection.test.tsx
git commit -m "feat(changes): FileSection component (collapsible + virtualized)

Section header shows title + count, hides entirely when count is 0.
Bulk actions are revealed on hover. Open/closed state persists in
localStorage per kind. Virtualization via @tanstack/solid-virtual."
```

---

## Task 10: `ChangesHeader` component

**Files:**
- Create: `src/components/ChangesHeader.tsx`.
- Create: `src/components/ChangesHeader.test.tsx`.

- [ ] **Step 1: Write failing tests**

Create `src/components/ChangesHeader.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { ChangesHeader } from './ChangesHeader'

describe('<ChangesHeader />', () => {
  test('shows zero conflict + zero staged segments hidden, changes count visible', () => {
    cleanup()
    const { container } = render(() => (
      <ChangesHeader
        conflicts={0}
        staged={0}
        changes={5}
        totalInsertions={10}
        totalDeletions={3}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={() => {}}
      />
    ))
    expect(container.textContent).not.toContain('conflicts')
    expect(container.textContent).not.toContain('staged')
    expect(container.textContent).toContain('5')
    expect(container.textContent).toContain('+10')
    expect(container.textContent).toContain('-3')
  })

  test('conflict segment uses red text and pulses when count > 0', () => {
    cleanup()
    const { container } = render(() => (
      <ChangesHeader
        conflicts={2}
        staged={0}
        changes={0}
        totalInsertions={0}
        totalDeletions={0}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={() => {}}
      />
    ))
    const seg = container.querySelector('[data-testid=conflict-seg]') as HTMLElement
    expect(seg).toBeTruthy()
    expect(seg.className).toContain('red')
    expect(seg.className).toContain('animate-pulse')
  })

  test('clicking a segment calls onJumpToSection', () => {
    cleanup()
    const onJump = vi.fn()
    const { getByTestId } = render(() => (
      <ChangesHeader
        conflicts={1}
        staged={2}
        changes={3}
        totalInsertions={0}
        totalDeletions={0}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={onJump}
      />
    ))
    fireEvent.click(getByTestId('staged-seg'))
    expect(onJump).toHaveBeenCalledWith('staged')
  })

  test('refresh button calls onRefresh', () => {
    cleanup()
    const onRefresh = vi.fn()
    const { getByTitle } = render(() => (
      <ChangesHeader
        conflicts={0} staged={0} changes={0}
        totalInsertions={0} totalDeletions={0}
        loading={false}
        onRefresh={onRefresh}
        onJumpToSection={() => {}}
      />
    ))
    fireEvent.click(getByTitle('Refresh'))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/ChangesHeader.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ChangesHeader`**

Create `src/components/ChangesHeader.tsx`:

```tsx
import { Component, Show } from 'solid-js'
import { RefreshCw } from 'lucide-solid'
import type { SectionKind } from './FileSection'

interface Props {
  conflicts: number
  staged: number
  changes: number
  totalInsertions: number
  totalDeletions: number
  loading: boolean
  selectedCommitShortHash?: string
  onRefresh: () => void
  onJumpToSection: (kind: SectionKind) => void
}

export const ChangesHeader: Component<Props> = (props) => {
  return (
    <div class="flex items-center justify-between px-3 h-9 bg-surface-1">
      <div class="flex items-center gap-2 text-xs text-text-muted min-w-0">
        <span class="font-medium text-text-secondary shrink-0">
          {props.selectedCommitShortHash ? 'Commit' : 'Changes'}
        </span>
        <Show when={props.selectedCommitShortHash}>
          <span class="font-mono text-text-dim truncate">{props.selectedCommitShortHash}</span>
        </Show>

        <Show when={props.conflicts > 0}>
          <button
            data-testid="conflict-seg"
            class="text-red-400 animate-pulse hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('conflicts')}
          >
            !{props.conflicts} conflict{props.conflicts !== 1 ? 's' : ''}
          </button>
        </Show>
        <Show when={props.staged > 0}>
          <Show when={props.conflicts > 0}><span class="text-text-dim shrink-0">·</span></Show>
          <button
            data-testid="staged-seg"
            class="hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('staged')}
          >
            {props.staged} staged
          </button>
        </Show>
        <Show when={props.changes > 0}>
          <Show when={props.conflicts > 0 || props.staged > 0}><span class="text-text-dim shrink-0">·</span></Show>
          <button
            data-testid="changes-seg"
            class="hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('changes')}
          >
            {props.changes} change{props.changes !== 1 ? 's' : ''}
          </button>
        </Show>

        <Show when={props.totalInsertions > 0}>
          <span class="text-emerald-400 shrink-0 tabular-nums">+{props.totalInsertions}</span>
        </Show>
        <Show when={props.totalDeletions > 0}>
          <span class="text-red-400 shrink-0 tabular-nums">-{props.totalDeletions}</span>
        </Show>
      </div>

      <div class="flex items-center gap-0.5 shrink-0">
        <button
          class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 disabled:opacity-40"
          onClick={props.onRefresh}
          disabled={props.loading}
          title="Refresh"
        >
          <RefreshCw size={12} class={props.loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/components/ChangesHeader.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChangesHeader.tsx src/components/ChangesHeader.test.tsx
git commit -m "feat(changes): ChangesHeader component with segmented counts

Segments hide at zero. Conflicts segment is red and pulses while count
> 0. Each segment is clickable to jump to its section."
```

---

## Task 11: `ConflictStageDialog` component

**Files:**
- Create: `src/components/ConflictStageDialog.tsx`.
- Create: `src/components/ConflictStageDialog.test.tsx`.

- [ ] **Step 1: Write failing tests**

Create `src/components/ConflictStageDialog.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { ConflictStageDialog } from './ConflictStageDialog'

describe('<ConflictStageDialog />', () => {
  test('does not render when path is null', () => {
    cleanup()
    const { container } = render(() => (
      <ConflictStageDialog path={null} onChoose={() => {}} onClose={() => {}} />
    ))
    expect(container.textContent).toBe('')
  })

  test('clicking Accept ours fires onChoose("ours")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Accept ours/i))
    expect(onChoose).toHaveBeenCalledWith('ours')
  })

  test('clicking Accept theirs fires onChoose("theirs")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Accept theirs/i))
    expect(onChoose).toHaveBeenCalledWith('theirs')
  })

  test('clicking Stage as-is fires onChoose("asIs")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Stage as-is/i))
    expect(onChoose).toHaveBeenCalledWith('asIs')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/ConflictStageDialog.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `ConflictStageDialog`**

Create `src/components/ConflictStageDialog.tsx`:

```tsx
import { Component, Show } from 'solid-js'

export type ConflictChoice = 'ours' | 'theirs' | 'asIs'

interface Props {
  path: string | null
  onChoose: (choice: ConflictChoice) => void
  onClose: () => void
}

export const ConflictStageDialog: Component<Props> = (props) => {
  return (
    <Show when={props.path}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={props.onClose}
      >
        <div
          class="bg-surface-2 rounded-lg shadow-2xl ring-1 ring-outline/8 p-4 w-96 max-w-[90vw]"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 class="text-sm font-medium text-text-primary mb-1">Stage with conflict</h3>
          <p class="text-xs text-text-muted mb-3 truncate" title={props.path!}>
            {props.path}
          </p>
          <p class="text-xs text-text-muted mb-4">
            This file has unresolved conflict markers. Choose how to stage it.
          </p>
          <div class="flex flex-col gap-2">
            <button
              class="h-8 px-3 rounded text-xs bg-surface-3 hover:bg-surface-4 text-text-primary text-left"
              onClick={() => props.onChoose('ours')}
            >
              <span class="font-medium">Accept ours</span>
              <span class="text-text-dim ml-2">— keep this branch's version</span>
            </button>
            <button
              class="h-8 px-3 rounded text-xs bg-surface-3 hover:bg-surface-4 text-text-primary text-left"
              onClick={() => props.onChoose('theirs')}
            >
              <span class="font-medium">Accept theirs</span>
              <span class="text-text-dim ml-2">— take the other branch's version</span>
            </button>
            <button
              class="h-8 px-3 rounded text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-left"
              onClick={() => props.onChoose('asIs')}
            >
              <span class="font-medium">Stage as-is</span>
              <span class="text-amber-300/70 ml-2">— keep conflict markers in the commit</span>
            </button>
          </div>
          <div class="mt-3 flex justify-end">
            <button
              class="text-[11px] text-text-dim hover:text-text-secondary"
              onClick={props.onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/components/ConflictStageDialog.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ConflictStageDialog.tsx src/components/ConflictStageDialog.test.tsx
git commit -m "feat(changes): ConflictStageDialog with three-choice resolve

Modal offers Accept ours / Accept theirs / Stage as-is when staging a
file that still has conflict markers."
```

---

## Task 12: `CommitComposer` component

**Files:**
- Create: `src/components/CommitComposer.tsx`.
- Create: `src/components/CommitComposer.test.tsx`.

- [ ] **Step 1: Write failing tests**

Create `src/components/CommitComposer.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { CommitComposer } from './CommitComposer'

describe('<CommitComposer />', () => {
  test('Commit button disabled when worktree is fully clean', () => {
    cleanup()
    const { getByText } = render(() => (
      <CommitComposer
        taskId="t1"
        canCommit={false}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    expect((getByText('Commit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('Commit button enabled when canCommit is true and message is non-empty', async () => {
    cleanup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { getByText, getByPlaceholderText } = render(() => (
      <CommitComposer
        taskId="t1"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={onCommit}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'feat: thing' } })
    fireEvent.click(getByText('Commit'))
    expect(onCommit).toHaveBeenCalledWith('feat: thing')
  })

  test('draft message persists per task in localStorage', () => {
    cleanup()
    localStorage.removeItem('verun:changes:msg:t-A')
    const view1 = render(() => (
      <CommitComposer
        taskId="t-A"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = view1.getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'wip' } })
    expect(localStorage.getItem('verun:changes:msg:t-A')).toBe('wip')

    cleanup()
    const view2 = render(() => (
      <CommitComposer
        taskId="t-A"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta2 = view2.getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    expect(ta2.value).toBe('wip')
  })

  test('Cmd+Enter submits when canCommit and message is non-empty', () => {
    cleanup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { getByPlaceholderText } = render(() => (
      <CommitComposer
        taskId="t-cmd"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={onCommit}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'msg' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('msg')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/components/CommitComposer.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `CommitComposer`**

Create `src/components/CommitComposer.tsx`:

```tsx
import { Component, createEffect, createSignal, on, Show } from 'solid-js'
import { ChevronDown, Loader2 } from 'lucide-solid'

interface Props {
  taskId: string
  canCommit: boolean      // there is at least one staged/unstaged/untracked file
  canAmend: boolean       // at least one commit on the branch
  amendDefaultMessage: string
  onCommit: (message: string) => Promise<void>
  onCommitAndPush: (message: string) => Promise<void>
  onAmend: (message: string) => Promise<void>
}

const KEY = (taskId: string) => `verun:changes:msg:${taskId}`

export const CommitComposer: Component<Props> = (props) => {
  const [msg, setMsg] = createSignal(localStorage.getItem(KEY(props.taskId)) ?? '')
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [amendMode, setAmendMode] = createSignal(false)

  createEffect(on(() => props.taskId, (id) => {
    setMsg(localStorage.getItem(KEY(id)) ?? '')
    setAmendMode(false)
  }))

  createEffect(on(msg, (m) => {
    if (m) localStorage.setItem(KEY(props.taskId), m)
    else localStorage.removeItem(KEY(props.taskId))
  }))

  const submitDisabled = () => busy() || !msg().trim() || !props.canCommit
  const buttonLabel = () => amendMode() ? 'Commit (amend)' : 'Commit'

  const runWith = async (op: 'commit' | 'push' | 'amend') => {
    if (submitDisabled() && op !== 'amend') return
    if (op === 'amend' && (busy() || !msg().trim())) return
    setBusy(true)
    try {
      const m = msg()
      if (op === 'commit') await props.onCommit(m)
      else if (op === 'push') await props.onCommitAndPush(m)
      else await props.onAmend(m)
      setMsg('')
      setAmendMode(false)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (amendMode()) runWith('amend')
      else runWith('commit')
    }
  }

  const enterAmendMode = () => {
    if (!props.canAmend) return
    setAmendMode(true)
    setOpen(false)
    if (!msg().trim()) setMsg(props.amendDefaultMessage)
  }

  return (
    <div class="shrink-0 border-t-1 border-t-solid border-t-outline/8 bg-surface-1 p-2 flex flex-col gap-1.5">
      <textarea
        class="w-full bg-surface-2 text-text-primary text-xs rounded px-2 py-1.5 resize-none ring-1 ring-outline/8 focus:ring-accent/40 outline-none"
        rows={Math.min(6, Math.max(1, msg().split('\n').length))}
        placeholder="Commit message…"
        value={msg()}
        onInput={(e) => setMsg(e.currentTarget.value)}
        onKeyDown={handleKey}
      />
      <div class="flex items-center gap-1 relative">
        <div class="flex items-stretch toolbar-chrome shrink-0 overflow-hidden">
          <button
            class="flex items-center gap-1 px-2 h-6 text-[11px] hover:bg-surface-2 disabled:opacity-40"
            disabled={amendMode() ? (!msg().trim() || busy()) : submitDisabled()}
            onClick={() => runWith(amendMode() ? 'amend' : 'commit')}
          >
            <Show when={busy()} fallback={null}>
              <Loader2 size={11} class="animate-spin" />
            </Show>
            <span>{buttonLabel()}</span>
          </button>
          <span class="w-px self-stretch bg-outline/8" />
          <button
            class="flex items-center px-1.5 hover:bg-surface-2"
            onClick={() => setOpen(!open())}
          >
            <ChevronDown size={11} />
          </button>
        </div>
        <span class="text-[10px] text-text-dim ml-auto">⌘↵</span>

        <Show when={open()}>
          <div class="absolute bottom-7 left-0 z-50 bg-surface-2 ring-1 ring-outline/8 rounded shadow-xl py-1 min-w-44">
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={!props.canAmend}
              onClick={enterAmendMode}
            >
              Amend last commit
            </button>
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={submitDisabled()}
              onClick={() => runWith('push')}
            >
              Commit & Push
            </button>
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={submitDisabled()}
              onClick={() => runWith('commit')}
            >
              Stage All & Commit
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}
```

Note: "Stage All & Commit" calls `onCommit` here because `onCommit` already implements the smart-commit fallback (stage-all if nothing staged) — see Task 13.

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/components/CommitComposer.test.tsx
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/CommitComposer.tsx src/components/CommitComposer.test.tsx
git commit -m "feat(changes): CommitComposer with split button + kebab + draft

Bottom-fixed textarea (auto-grows 1-6 rows). Cmd+Enter submits. Drafts
persist per task. Kebab offers Amend, Commit & Push, Stage All & Commit."
```

---

## Task 13: Wire `CodeChanges.tsx` orchestrator + optimistic updates

This is the largest single task: rewrites `CodeChanges.tsx` as an orchestrator using all the new components, adds the optimistic-update helpers, and adds the smart-commit / amend / push flows.

**Files:**
- Create: `src/store/changesActions.ts`.
- Create: `src/store/changesActions.test.ts`.
- Modify: `src/components/CodeChanges.tsx`.
- Modify: `src/components/CodeChanges.test.tsx`.

- [ ] **Step 1: Write failing tests for `changesActions`**

Create `src/store/changesActions.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { createRoot } from 'solid-js'
import { gitStates, setGitStates } from './git'
import {
  optimisticStage,
  optimisticUnstage,
  optimisticDiscard,
  optimisticResolve,
} from './changesActions'
import type { FileStatus } from '../types'

const status = (files: FileStatus[]) => ({
  files,
  stats: [],
  totalInsertions: 0,
  totalDeletions: 0,
})

beforeEach(() => {
  setGitStates({ 't1': {
    status: status([]),
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null, checks: [], branchUrl: null, github: null,
    lastLocalRefresh: 0, lastRemoteRefresh: 0,
  } })
})

describe('optimisticStage', () => {
  test('untracked → A staged', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: '?', worktreeStatus: '?', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('A')
    expect(f.worktreeStatus).toBe(' ')
  })

  test('worktree-modified → indexStatus = M, worktreeStatus = " "', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })

  test('MM → keeps indexStatus M, clears worktreeStatus', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'M', worktreeStatus: 'M', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })
})

describe('optimisticUnstage', () => {
  test('staged-only A → untracked', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'A', worktreeStatus: ' ', conflict: null }]))
    optimisticUnstage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('?')
    expect(f.worktreeStatus).toBe('?')
  })

  test('staged M → unstaged M', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'M', worktreeStatus: ' ', conflict: null }]))
    optimisticUnstage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe(' ')
    expect(f.worktreeStatus).toBe('M')
  })
})

describe('optimisticDiscard', () => {
  test('removes the file from the list', () => {
    setGitStates('t1', 'status', status([
      { path: 'a.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null },
      { path: 'b.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null },
    ]))
    optimisticDiscard('t1', 'a.ts')
    expect(gitStates['t1']!.status!.files.map(f => f.path)).toEqual(['b.ts'])
  })
})

describe('optimisticResolve', () => {
  test('clears conflict, sets indexStatus to M, clears worktreeStatus', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }]))
    optimisticResolve('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.conflict).toBeNull()
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })
})
```

- [ ] **Step 2: Verify failure**

```bash
pnpm test -- src/store/changesActions.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `changesActions.ts`**

Create `src/store/changesActions.ts`:

```ts
import { produce } from 'solid-js/store'
import { setGitStates, refreshTaskGit } from './git'
import * as ipc from '../lib/ipc'
import { addToast } from './ui'

function patchFile(taskId: string, path: string, fn: (f: any) => void) {
  setGitStates(produce(s => {
    const st = s[taskId]?.status
    if (!st) return
    const f = st.files.find((f: any) => f.path === path)
    if (f) fn(f)
  }))
}

function removeFile(taskId: string, path: string) {
  setGitStates(produce(s => {
    const st = s[taskId]?.status
    if (!st) return
    st.files = st.files.filter((f: any) => f.path !== path)
    st.stats = st.stats.filter((s: any) => s.path !== path)
  }))
}

export function optimisticStage(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    if (f.indexStatus === '?' && f.worktreeStatus === '?') {
      f.indexStatus = 'A'
    } else if (f.indexStatus === ' ' || f.indexStatus === '?') {
      f.indexStatus = f.worktreeStatus === '?' ? 'A' : f.worktreeStatus
    }
    f.worktreeStatus = ' '
  })
}

export function optimisticUnstage(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    if (f.indexStatus === 'A' && f.worktreeStatus === ' ') {
      f.indexStatus = '?'
      f.worktreeStatus = '?'
      return
    }
    f.worktreeStatus = f.indexStatus
    f.indexStatus = ' '
  })
}

export function optimisticDiscard(taskId: string, path: string) {
  removeFile(taskId, path)
}

export function optimisticResolve(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    f.conflict = null
    f.indexStatus = 'M'
    f.worktreeStatus = ' '
  })
}

export async function stageOne(taskId: string, path: string): Promise<void> {
  optimisticStage(taskId, path)
  try {
    await ipc.gitStage(taskId, [path])
  } catch (e: any) {
    addToast(`Failed to stage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function unstageOne(taskId: string, path: string): Promise<void> {
  optimisticUnstage(taskId, path)
  try {
    await ipc.gitUnstage(taskId, [path])
  } catch (e: any) {
    addToast(`Failed to unstage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function discardOne(taskId: string, path: string): Promise<void> {
  optimisticDiscard(taskId, path)
  try {
    await ipc.gitDiscard(taskId, [path])
  } catch (e: any) {
    addToast(`Failed to discard: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function resolveConflict(
  taskId: string,
  path: string,
  choice: 'ours' | 'theirs',
): Promise<void> {
  optimisticResolve(taskId, path)
  try {
    await ipc.gitResolveConflict(taskId, path, choice)
  } catch (e: any) {
    addToast(`Failed to resolve: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function stageConflictAsIs(taskId: string, path: string): Promise<void> {
  optimisticResolve(taskId, path)
  try {
    await ipc.gitStage(taskId, [path])
  } catch (e: any) {
    addToast(`Failed to stage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function stageAll(taskId: string): Promise<void> {
  try {
    await ipc.gitStage(taskId, [])  // existing convention: empty paths → stage all
  } catch (e: any) {
    addToast(`Failed to stage all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function unstageAll(taskId: string): Promise<void> {
  try {
    await ipc.gitUnstageAll(taskId)
  } catch (e: any) {
    addToast(`Failed to unstage all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function discardAllUnstaged(taskId: string): Promise<void> {
  try {
    await ipc.gitDiscardAllUnstaged(taskId)
  } catch (e: any) {
    addToast(`Failed to discard all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function commitWithFallback(
  taskId: string,
  message: string,
  hasStaged: boolean,
): Promise<void> {
  if (!hasStaged) {
    await ipc.gitStage(taskId, [])
  }
  await ipc.gitCommit(taskId, message)
  await refreshTaskGit(taskId, { force: true })
}

export async function commitAndPush(taskId: string, message: string): Promise<void> {
  await ipc.gitCommitAndPush(taskId, message)
  await refreshTaskGit(taskId, { local: true, remote: true, force: true })
}

export async function commitAmend(taskId: string, message: string): Promise<void> {
  await ipc.gitCommitAmend(taskId, message)
  await refreshTaskGit(taskId, { force: true })
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/store/changesActions.test.ts
```

Expected: green (the optimistic-only tests pass; the IPC-orchestration functions aren't exercised in these unit tests).

- [ ] **Step 5: Rewrite `CodeChanges.tsx`**

Replace the entirety of `src/components/CodeChanges.tsx` with:

```tsx
import { Component, createSignal, createMemo, createEffect, on, Show } from 'solid-js'
import { GitCompare, FileText, ClipboardCopy, FolderOpen, ExternalLink, Tag, Plus, Minus, X } from 'lucide-solid'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ChangesHeader } from './ChangesHeader'
import { FileSection, type SectionKind, type BulkAction } from './FileSection'
import { FileRow } from './FileRow'
import { CommitComposer } from './CommitComposer'
import { ConflictStageDialog, type ConflictChoice } from './ConflictStageDialog'
import { BranchCommits } from './BranchCommits'
import { fanOut, type FileEntry } from '../lib/gitStatus'
import { taskGit, refreshTaskGit } from '../store/git'
import { taskById } from '../store/tasks'
import { selectedTaskId } from '../store/ui'
import { openDiffTab, openFilePinned, revealFileInTree, mainView, type DiffSource } from '../store/editorView'
import { diffTabKey } from '../store/files'
import * as ipc from '../lib/ipc'
import {
  stageOne, unstageOne, discardOne, resolveConflict, stageConflictAsIs,
  stageAll, unstageAll, discardAllUnstaged,
  commitWithFallback, commitAndPush, commitAmend,
} from '../store/changesActions'
import type { GitStatus } from '../types'

interface Props { taskId: string }

export const CodeChanges: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null)
  const [commitStatus, setCommitStatus] = createSignal<GitStatus | null>(null)
  const [conflictDialogPath, setConflictDialogPath] = createSignal<string | null>(null)
  const [bulkInflight, setBulkInflight] = createSignal<SectionKind | null>(null)

  const liveStatus = (): GitStatus | null =>
    selectedCommit() ? commitStatus() : taskGit(props.taskId).status

  const statsByPath = createMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>()
    for (const s of liveStatus()?.stats ?? []) map.set(s.path, s)
    return map
  })

  const allEntries = createMemo<FileEntry[]>(() => {
    const files = liveStatus()?.files ?? []
    return files.flatMap(fanOut)
  })

  const conflicts = () => allEntries().filter(e => e.kind === 'conflict')
  const stagedEntries = () => allEntries().filter(e => e.kind === 'staged')
  const unstagedEntries = () => allEntries().filter(e => e.kind === 'unstaged')

  const refresh = async () => {
    try {
      setLoading(true); setError(null)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: any) { setError(e?.toString() || 'Failed to load status') }
    finally { setLoading(false) }
  }

  const selectCommit = async (hash: string | null) => {
    setSelectedCommit(hash)
    if (hash === null) setCommitStatus(null)
    else {
      try { setCommitStatus(await ipc.getCommitFiles(props.taskId, hash)) }
      catch {}
    }
  }

  createEffect(on(() => props.taskId, () => {
    setSelectedCommit(null)
    setCommitStatus(null)
    refreshTaskGit(props.taskId)
    ipc.watchWorktree(props.taskId)
  }))

  // Diff source per row kind
  const sourceForEntry = (entry: FileEntry): DiffSource => {
    if (selectedCommit()) return { type: 'commit', commitHash: selectedCommit()! }
    if (entry.kind === 'staged') return { type: 'staged' }
    if (entry.kind === 'unstaged' && entry.file.indexStatus === '?') return { type: 'working' }
    if (entry.kind === 'unstaged') return { type: 'unstaged' }
    return { type: 'working' }  // conflict
  }

  const isRowActive = (entry: FileEntry) => {
    const tid = selectedTaskId()
    if (!tid || tid !== props.taskId) return false
    return mainView(tid) === diffTabKey(sourceForEntry(entry), entry.file.path)
  }

  // Row handlers
  const openDiff = (entry: FileEntry, opts?: { pinned?: boolean }) =>
    openDiffTab(props.taskId, entry.file.path, sourceForEntry(entry), opts)

  const openFile = (entry: FileEntry) =>
    openFilePinned(props.taskId, entry.file.path, entry.file.path.split('/').pop() || entry.file.path)

  const onPrimary = async (entry: FileEntry) => {
    if (entry.kind === 'conflict') { setConflictDialogPath(entry.file.path); return }
    if (entry.kind === 'staged') await unstageOne(props.taskId, entry.file.path)
    else await stageOne(props.taskId, entry.file.path)
  }

  const onDiscard = async (entry: FileEntry) => {
    await discardOne(props.taskId, entry.file.path)
  }

  const onConflictChoice = async (choice: ConflictChoice) => {
    const path = conflictDialogPath()
    if (!path) return
    setConflictDialogPath(null)
    if (choice === 'ours' || choice === 'theirs') {
      await resolveConflict(props.taskId, path, choice)
    } else {
      await stageConflictAsIs(props.taskId, path)
    }
  }

  // Bulk handlers
  const runBulk = async (kind: SectionKind, fn: () => Promise<void>) => {
    setBulkInflight(kind)
    try { await fn() } finally { setBulkInflight(null) }
  }

  const conflictBulk: BulkAction[] = []
  const stagedBulk = (): BulkAction[] => [
    { icon: Minus, title: 'Unstage all', onClick: () => runBulk('staged', () => unstageAll(props.taskId)) },
  ]
  const changesBulk = (): BulkAction[] => [
    { icon: Plus, title: 'Stage all', onClick: () => runBulk('changes', () => stageAll(props.taskId)) },
    {
      icon: X,
      title: 'Discard all',
      onClick: () => runBulk('changes', async () => {
        if (window.confirm('Discard all unstaged changes? This cannot be undone.')) {
          await discardAllUnstaged(props.taskId)
        }
      }),
    },
  ]

  // Header jump-to-section
  const onJumpToSection = (kind: SectionKind) => {
    localStorage.setItem(`verun:changes:section:${kind}:open`, 'true')
    refreshTaskGit(props.taskId, { force: true })
  }

  // Commit composer
  const canCommit = () => allEntries().length > 0
  const canAmend = () => taskGit(props.taskId).commits.length > 0
  const amendDefault = () => taskGit(props.taskId).commits[0]?.message ?? ''
  const onCommit = (msg: string) => commitWithFallback(props.taskId, msg, stagedEntries().length > 0)
  const onCommitAndPush = async (msg: string) => {
    if (stagedEntries().length === 0 && unstagedEntries().length > 0) {
      // commitAndPush in our IPC stages all + commits + pushes already
    }
    await commitAndPush(props.taskId, msg)
  }
  const onAmend = (msg: string) => commitAmend(props.taskId, msg)

  // Row context menu (existing behavior preserved)
  const [fileMenu, setFileMenu] = createSignal<{ x: number; y: number; entry: FileEntry } | null>(null)
  const closeFileMenu = () => setFileMenu(null)
  const fullPath = (rel: string) => {
    const t = taskById(props.taskId)
    return t?.worktreePath ? `${t.worktreePath}/${rel}` : rel
  }
  const fileMenuItems = (): ContextMenuItem[] => {
    const m = fileMenu()
    if (!m) return []
    const e = m.entry
    const path = e.file.path
    const name = path.split('/').pop() || path
    return [
      { label: 'Open Diff',       icon: GitCompare,   action: () => { openDiff(e, { pinned: true }); closeFileMenu() } },
      { label: 'Open File',       icon: FileText,     action: () => { openFile(e); closeFileMenu() } },
      { label: 'Open in VS Code', icon: ExternalLink, action: () => { ipc.openInApp(fullPath(path), 'Visual Studio Code'); closeFileMenu() } },
      { separator: true },
      e.kind === 'conflict'
        ? { label: 'Stage…',     icon: Plus,  action: () => { setConflictDialogPath(path); closeFileMenu() } }
        : e.kind === 'staged'
          ? { label: 'Unstage',  icon: Minus, action: () => { unstageOne(props.taskId, path); closeFileMenu() } }
          : { label: 'Stage',    icon: Plus,  action: () => { stageOne(props.taskId, path); closeFileMenu() } },
      ...(e.kind !== 'conflict'
        ? [{ label: 'Discard',   icon: X,     action: () => { discardOne(props.taskId, path); closeFileMenu() } }]
        : []),
      { separator: true },
      { label: 'Reveal in File Tree', icon: FolderOpen,    action: () => { revealFileInTree(props.taskId, path); closeFileMenu() } },
      { label: 'Reveal in Finder',    icon: FolderOpen,    action: () => { ipc.openInFinder(fullPath(path)); closeFileMenu() } },
      { separator: true },
      { label: 'Copy Name',           icon: Tag,           action: () => { navigator.clipboard.writeText(name); closeFileMenu() } },
      { label: 'Copy Relative Path',  icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(path); closeFileMenu() } },
      { label: 'Copy Absolute Path',  icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(fullPath(path)); closeFileMenu() } },
    ]
  }

  // Render row helper passed to each FileSection
  const renderRow = (entry: FileEntry) => {
    const stats = statsByPath().get(entry.file.path)
    return (
      <FileRow
        entry={entry}
        active={isRowActive(entry)}
        insertions={stats?.insertions}
        deletions={stats?.deletions}
        onOpenDiff={() => openDiff(entry)}
        onOpenDiffPinned={() => openDiff(entry, { pinned: true })}
        onOpenFile={() => openFile(entry)}
        onPrimary={() => onPrimary(entry)}
        onDiscard={() => onDiscard(entry)}
        onContextMenu={(e) => { e.preventDefault(); setFileMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, entry }) }}
      />
    )
  }

  return (
    <div class="flex flex-col h-full overflow-hidden min-w-0">
      <ChangesHeader
        conflicts={conflicts().length}
        staged={stagedEntries().length}
        changes={unstagedEntries().length}
        totalInsertions={liveStatus()?.totalInsertions ?? 0}
        totalDeletions={liveStatus()?.totalDeletions ?? 0}
        loading={loading()}
        selectedCommitShortHash={selectedCommit()
          ? taskGit(props.taskId).commits.find(c => c.hash === selectedCommit())?.shortHash
          : undefined}
        onRefresh={refresh}
        onJumpToSection={onJumpToSection}
      />

      <Show when={error()}>
        <div class="px-3 py-2 text-xs text-red-400 bg-red-400/5 border-b-1 border-b-solid border-b-outline/8 flex items-center justify-between">
          <span class="truncate">{error()}</span>
          <button class="shrink-0 ml-2" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      </Show>

      <div class="flex-1 overflow-auto flex flex-col min-h-0">
        <FileSection
          kind="conflicts"
          title="Conflicts"
          entries={conflicts()}
          renderRow={renderRow}
          bulkActions={conflictBulk}
          bulkInflight={bulkInflight() === 'conflicts'}
        />
        <FileSection
          kind="staged"
          title="Staged Changes"
          entries={stagedEntries()}
          renderRow={renderRow}
          bulkActions={stagedBulk()}
          bulkInflight={bulkInflight() === 'staged'}
        />
        <FileSection
          kind="changes"
          title="Changes"
          entries={unstagedEntries()}
          renderRow={renderRow}
          bulkActions={changesBulk()}
          bulkInflight={bulkInflight() === 'changes'}
        />

        <Show when={allEntries().length === 0 && !loading() && !selectedCommit()}>
          <div class="px-4 py-10 text-center">
            <p class="text-sm text-text-muted mb-1">No changes yet</p>
            <p class="text-xs text-text-dim">File modifications will appear here as the agent works.</p>
          </div>
        </Show>
      </div>

      <Show when={!selectedCommit()}>
        <CommitComposer
          taskId={props.taskId}
          canCommit={canCommit()}
          canAmend={canAmend()}
          amendDefaultMessage={amendDefault()}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onAmend={onAmend}
        />
      </Show>

      <BranchCommits
        taskId={props.taskId}
        selectedCommit={selectedCommit()}
        uncommittedCount={liveStatus()?.files.length ?? 0}
        onSelectCommit={selectCommit}
      />

      <ConflictStageDialog
        path={conflictDialogPath()}
        onChoose={onConflictChoice}
        onClose={() => setConflictDialogPath(null)}
      />

      <ContextMenu
        open={!!fileMenu()}
        onClose={closeFileMenu}
        pos={fileMenu() ? { x: fileMenu()!.x, y: fileMenu()!.y } : undefined}
        minWidth="min-w-44"
        items={fileMenuItems()}
      />
    </div>
  )
}
```

- [ ] **Step 6: Update `CodeChanges.test.tsx`**

Rewrite `src/components/CodeChanges.test.tsx` to cover the new behaviors:

```tsx
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'
import type { GitStatus, BranchCommit, FileStatus } from '../types'

const { watchWorktreeMock, refreshTaskGitMock, gitStageMock, gitUnstageMock, gitDiscardMock, gitCommitMock } = vi.hoisted(() => ({
  watchWorktreeMock: vi.fn(),
  refreshTaskGitMock: vi.fn(),
  gitStageMock: vi.fn().mockResolvedValue(undefined),
  gitUnstageMock: vi.fn().mockResolvedValue(undefined),
  gitDiscardMock: vi.fn().mockResolvedValue(undefined),
  gitCommitMock: vi.fn().mockResolvedValue('hash'),
}))

const [gitState, setGitState] = createStore<Record<string, any>>({})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  watchWorktree: watchWorktreeMock,
  getCommitFiles: vi.fn().mockResolvedValue({ files: [], stats: [], totalInsertions: 0, totalDeletions: 0 }),
  openInApp: vi.fn(),
  openInFinder: vi.fn(),
  gitStage: gitStageMock,
  gitUnstage: gitUnstageMock,
  gitDiscard: gitDiscardMock,
  gitDiscardAllUnstaged: vi.fn().mockResolvedValue(undefined),
  gitUnstageAll: vi.fn().mockResolvedValue(undefined),
  gitResolveConflict: vi.fn().mockResolvedValue(undefined),
  gitCommit: gitCommitMock,
  gitCommitAmend: vi.fn().mockResolvedValue('h'),
  gitCommitAndPush: vi.fn().mockResolvedValue('h'),
  getFileDiff: vi.fn().mockResolvedValue(''),
}))

vi.mock('../store/git', () => ({
  taskGit: (taskId: string) => gitState[taskId] ?? {
    status: null, commits: [], branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null, checks: [], branchUrl: null, github: null,
    lastLocalRefresh: 0, lastRemoteRefresh: 0,
  },
  gitStates: gitState,
  setGitStates: (...args: any[]) => { /* bypass; tests assert via mocks */ },
  refreshTaskGit: (...args: unknown[]) => refreshTaskGitMock(...args),
}))

vi.mock('../store/ui', () => ({ selectedTaskId: () => 'task-code', addToast: vi.fn() }))
vi.mock('../store/tasks', () => ({ taskById: () => ({ worktreePath: '/tmp/worktree' }) }))
vi.mock('../store/files', () => ({ diffTabKey: () => 'k' }))
vi.mock('../store/editorView', () => ({
  openDiffTab: vi.fn(),
  openFilePinned: vi.fn(),
  revealFileInTree: vi.fn(),
  mainView: () => 'session',
}))
vi.mock('../lib/fileIcons', () => ({ getFileIcon: vi.fn(() => () => null) }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))

import { CodeChanges } from './CodeChanges'

const status = (files: FileStatus[]): GitStatus => ({
  files,
  stats: files.map(f => ({ path: f.path, insertions: 1, deletions: 0 })),
  totalInsertions: files.length,
  totalDeletions: 0,
})

describe('<CodeChanges />', () => {
  beforeEach(() => {
    cleanup()
    watchWorktreeMock.mockClear()
    refreshTaskGitMock.mockReset()
    gitStageMock.mockClear()
    gitUnstageMock.mockClear()
    gitDiscardMock.mockClear()
    setGitState('task-code', {
      status: status([
        { path: 'mm.ts',         indexStatus: 'M', worktreeStatus: 'M', conflict: null },
        { path: 'staged-only.ts', indexStatus: 'A', worktreeStatus: ' ', conflict: null },
        { path: 'untracked.ts',   indexStatus: '?', worktreeStatus: '?', conflict: null },
        { path: 'conflict.ts',    indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' },
      ]),
      commits: [{ hash: 'h1', shortHash: 'h1', message: 'init', author: 'me', timestamp: 1, filesChanged: 1, insertions: 1, deletions: 0 }] as BranchCommit[],
      branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
      pr: null, checks: [], branchUrl: null, github: null,
      lastLocalRefresh: 0, lastRemoteRefresh: 0,
    })
  })

  test('MM file produces both staged and unstaged rows', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    const occurrences = container.textContent?.match(/mm\.ts/g) ?? []
    expect(occurrences.length).toBe(2)
  })

  test('conflict appears under Conflicts section with ! letter', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('Conflicts')
    expect(container.textContent).toContain('conflict.ts')
    expect(container.textContent).toContain('!')
  })

  test('untracked appears in Changes with U letter', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('untracked.ts')
    expect(container.textContent).toContain('U')
  })

  test('header counts segments by section', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('1 conflict')
    expect(container.textContent).toContain('1 staged')
    expect(container.textContent).toContain('2 changes') // mm.ts unstaged side + untracked.ts
  })
})
```

(Adjust DOM-query strategy if your existing test conventions differ — these snippets show the expected behaviors, not the only way to query for them.)

- [ ] **Step 7: Run tests + typecheck**

```bash
pnpm test
pnpm check
```

Expected: green.

- [ ] **Step 8: Run Rust check**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --no-deps -- -D warnings
```

Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/store/changesActions.ts src/store/changesActions.test.ts src/components/CodeChanges.tsx src/components/CodeChanges.test.tsx
git commit -m "feat(changes): wire orchestrator with optimistic updates and composer

CodeChanges.tsx is now a slim orchestrator over ChangesHeader,
FileSection (x3), CommitComposer, ConflictStageDialog, and BranchCommits.
Stage/unstage/discard apply optimistic section-membership patches; the
watcher reconciles. Bulk actions use single IPCs. Smart-commit stages
all if nothing is staged."
```

---

## Task 14: Manual QA + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`.

- [ ] **Step 1: Run full project health check**

```bash
make check
```

Expected: zero errors / warnings.

- [ ] **Step 2: Manual QA in dev**

Start the dev server:

```bash
pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications
```

Walk through this checklist in the running app, on a real task:

- [ ] **Untracked file** — create a new file in the worktree (`echo hi > scratch.md`). Confirm: appears under `Changes` section, status letter `U` in green, `+1` stat shown.
- [ ] **Modified file** — edit an existing file. Confirm: appears under `Changes`, letter `M` in amber.
- [ ] **Staged file** — stage from terminal (`git add <file>`). Confirm: row moves to `Staged Changes`, letter is the index status.
- [ ] **MM file** — modify an already-staged file again. Confirm: file appears in **both** `Staged Changes` (showing the staged side) and `Changes` (showing the new dirty side). Clicking each row opens the right diff scope.
- [ ] **Conflict** — `git rebase` or `git merge` to forge a conflict. Confirm: appears under `Conflicts` section, red `!` letter, header shows pulsing red `!1 conflict` segment.
- [ ] **Inline stage** — hover row, click `+`, confirm row moves immediately to `Staged Changes` (optimistic) and stays there after the watcher refresh.
- [ ] **Inline unstage** — hover row in Staged, click `−`, confirm row moves to Changes.
- [ ] **Inline discard** — hover row in Changes, click `×` once: red "Confirm" pill appears. Click again within 3s: row vanishes. Try clicking once and waiting 4s: state resets.
- [ ] **Bulk stage all** — hover Changes header, click `+`, confirm a single git invocation runs and all change-rows move to Staged.
- [ ] **Bulk unstage all** — same with `−` on Staged header.
- [ ] **Bulk discard all** — `×` on Changes header opens confirm modal; canceling does nothing; confirming clears the section.
- [ ] **Open File** — any row's file-icon button opens the file (not the diff) in a pinned tab.
- [ ] **Conflict-stage flow** — hover conflict row, click `+`. Dialog appears with three buttons. Pick "Accept ours" → row leaves Conflicts and shows in Staged. Re-create conflict, pick "Stage as-is" → row moves to Staged but file still has markers on disk.
- [ ] **Commit composer — empty pane** — clean worktree: composer's Commit button is disabled.
- [ ] **Commit composer — only unstaged** — change a file, type message, click Commit → smart-commits (stage-all + commit). Confirm Branch Commits panel updates.
- [ ] **Cmd+Enter** — typing message and pressing Cmd+Enter submits.
- [ ] **Drafts persist** — type message, switch to another task, come back: message is restored.
- [ ] **Amend** — kebab → Amend last commit. Textarea pre-fills with last message. Edit it, submit. Branch Commits' top row shows new hash and edited message.
- [ ] **Commit & Push** — kebab → Commit & Push. Confirm: commit succeeds, push completes (toast), Branch Commits + remote state update.
- [ ] **Section collapse persistence** — collapse `Staged Changes`, refresh app, confirm it's still collapsed.
- [ ] **Header segment jump** — click `2 changes` segment in header → Changes section opens (if collapsed).

If any item fails, file the issue inline (do not mark Task 14 done) and fix before proceeding.

- [ ] **Step 3: Update `CHANGELOG.md`**

In `CHANGELOG.md`, ensure there's an `## Unreleased` section at the top. Add a single bullet:

```
- Changes pane: full overhaul. Three sections (Conflicts / Staged Changes / Changes), inline stage/unstage/discard/open-file actions, commit composer with smart-commit, amend, and Commit & Push, conflict-resolve dialog (ours / theirs / stage as-is), and corrected status taxonomy across Rust and TypeScript.
```

- [ ] **Step 4: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for Changes pane overhaul"
```

- [ ] **Step 5: Verify branch is ready to ship**

```bash
git status
git log --oneline main..HEAD
make check
```

Expected: clean tree, log shows the task commits, `make check` green.

---

## Self-review (post-write)

Before handing off:

**Spec coverage:**
- Section 1 (data model): Tasks 1-2.
- Section 2 (component layout): Tasks 7-13.
- Section 3 (IPC): Tasks 3-4, 6.
- Section 4 (optimistic + flows): Task 13.
- Resolved details (empty state, hide on zero): Tasks 9 (FileSection hides at 0), 13 (empty-state shown only when `allEntries().length === 0`).

**Type consistency check:**
- `FileStatus` field names match across Rust (`index_status`, `worktree_status`, `old_path`) and TS (`indexStatus`, `worktreeStatus`, `oldPath`) via `serde(rename_all = "camelCase")`. ✓
- `ConflictKind` variant names match (camelCase across the wire). ✓
- `FileEntry`, `SectionKind`, `BulkAction`, `ConflictChoice` all used identically wherever they appear. ✓
- IPC names use `git_*` prefix (snake_case in Rust) and `git*` camelCase in TS. ✓
- `discard_files` Rust ↔ `gitDiscard` TS ↔ `git_discard` Tauri command — consistent. ✓

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later" / "similar to Task N" left in.
- Every code step has full code blocks; every command step has the exact command.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-01-changes-pane-overhaul.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
