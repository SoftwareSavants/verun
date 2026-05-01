# Changes Pane Overhaul — Design

**Date:** 2026-05-01
**Status:** Draft (awaiting user review)
**Component:** `src/components/CodeChanges.tsx` and supporting Rust/store layers

## Problem

The current Changes pane (`src/components/CodeChanges.tsx`) has correctness bugs, missing functionality, and a flat structure that hides important git state from the user. Concretely:

1. **Status letters are inverted.** `STATUS_LETTERS['?']` maps untracked files to the letter `U`, while real conflicts (Rust status `U`) fall through to `?`. Users see "U" on green for new files and "?" on grey for merge conflicts — the opposite of every IDE convention.
2. **Conflict detection is incomplete.** `parse_porcelain_status` in `src-tauri/src/git_ops.rs` only matches `(_, U) | (U, _)`, silently mislabeling `DD` (both deleted) and `AA` (both added) as plain `M`.
3. **Untracked files have no diff stats.** `parse_numstat` runs `git diff HEAD --numstat`, which excludes untracked files entirely. Their `+N` count is always missing.
4. **Files with both staged and unstaged changes (`MM`) are flattened.** The Rust code emits a single entry with `staging: "staged"`, dropping the unstaged dimension. There is no way to act on the staged or unstaged side independently.
5. **Staging dimension is invisible.** `FileStatus.staging` is computed but never rendered. A user cannot tell which files are staged vs unstaged from the UI.
6. **No inline actions.** `CodeChanges.tsx` has no Stage / Unstage / Discard / Open File controls on rows. All staging happens through the agent or external terminal.
7. **No commit composer.** Commit message + commit button do not exist in the pane. The only path to a commit is asking the agent.

The user wants a "10x better" overhaul, not a patch.

## Goals

- Correct status taxonomy across Rust, TypeScript, and the renderer.
- Self-sufficient pane: stage, unstage, discard, commit, push, amend without leaving the UI.
- Clear sectioned layout that mirrors the user's mental model (conflicts → staged → working).
- Snappy interactions via optimistic section-membership updates.
- VS Code-equivalent ergonomics where they exist; no novel paradigms.

## Non-goals

- Filter / search input (deferred — global search covers it).
- 3-way merge conflict editor (existing diff editor with conflict markers is enough).
- Drag-and-drop between sections.
- Commit message templates / co-authors / sign-off / GPG UI.
- Per-hunk staging UI.

## Sections

The design is broken into 4 sections, each independently implementable: data model, layout, IPC + actions, optimistic-update + commit-composer flows.

---

## Section 1 — Data Model

### Rust (`src-tauri/src/git_ops.rs`)

Replace single-letter `status` with explicit dimensions plus a typed conflict variant:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub index_status: char,    // ' ', 'M', 'A', 'D', 'R', 'C', 'U', '?'
    pub worktree_status: char, // ' ', 'M', 'D', 'U', '?'
    pub conflict: Option<ConflictKind>,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
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
```

`parse_porcelain_status` is rewritten in priority order:

1. If either byte is `U`, or pair is `AA` / `DD` → fill `conflict` and emit. No `index_status`/`worktree_status` translation needed for the UI; those still hold the raw bytes.
2. Else if pair is `??` → untracked. `index_status = '?'`, `worktree_status = '?'`.
3. Else → assign `index_status = bytes[0]`, `worktree_status = bytes[1]` directly. No further interpretation in Rust; the frontend decides what to render.
4. Unknown patterns log via `eprintln!` and skip (existing behavior).

### Untracked file stats

`parse_numstat` is split:

- Tracked files: existing `git diff HEAD --numstat` path.
- Untracked: `git ls-files --others --exclude-standard -z`, then for each path read its content from disk and count lines. Insertions = line count; deletions = 0. Cap per-file line count at 50,000 to avoid pathological cases — over the cap, return `0/0` and trust the existing binary detection elsewhere.

Both lists are merged into the `stats` field; `total_insertions` / `total_deletions` include both.

### TypeScript types (`src/types/index.ts`)

`FileStatus` mirrors Rust:

```ts
export interface FileStatus {
  path: string
  indexStatus: string    // single character
  worktreeStatus: string // single character
  conflict: ConflictKind | null
  oldPath?: string
}

export type ConflictKind =
  | 'bothModified' | 'bothAdded' | 'bothDeleted'
  | 'addedByUs'   | 'addedByThem'
  | 'deletedByUs' | 'deletedByThem'
```

The legacy `status` and `staging` fields are removed — every consumer (`GitActions.tsx`, `Sidebar.tsx`, `FileTree.tsx`, etc.) is updated to derive what it needs from the new fields. There is no compatibility shim.

### Frontend fan-out

A single `FileStatus` can produce one or two `FileEntry` values via a memo in `CodeChanges.tsx`:

```ts
type FileEntry =
  | { kind: 'conflict', file: FileStatus }
  | { kind: 'staged',   file: FileStatus }
  | { kind: 'unstaged', file: FileStatus }

function fanOut(file: FileStatus): FileEntry[] {
  if (file.conflict) return [{ kind: 'conflict', file }]
  const out: FileEntry[] = []
  const idx = file.indexStatus
  const wt  = file.worktreeStatus
  // Untracked: only the unstaged side exists
  if (idx === '?' && wt === '?') {
    out.push({ kind: 'unstaged', file })
    return out
  }
  if (idx !== ' ' && idx !== '?') out.push({ kind: 'staged',   file })
  if (wt  !== ' ' && wt  !== '?') out.push({ kind: 'unstaged', file })
  return out
}
```

A file in `MM` state produces two entries; both render rows that link to scoped diff editors.

### Shared status taxonomy (`src/lib/gitStatus.ts`)

New module owns the letter / color / label tables. Single source of truth for any component that renders status.

```ts
export interface StatusBadge {
  letter: string
  colorClass: string
  label: string
  tooltip?: string
}

export function badgeForEntry(entry: FileEntry): StatusBadge { /* ... */ }
```

Mapping (final):

| Case | Letter | Color | Label |
|---|---|---|---|
| `staged` + `index_status='A'` | `A` | emerald | Added |
| `staged` + `index_status='M'` | `M` | amber | Modified (staged) |
| `staged` + `index_status='D'` | `D` | red | Deleted (staged) |
| `staged` + `index_status='R'` | `R` | blue | Renamed |
| `staged` + `index_status='C'` | `C` | blue | Copied |
| `unstaged` + `worktree_status='M'` | `M` | amber | Modified |
| `unstaged` + `worktree_status='D'` | `D` | red | Deleted |
| `unstaged` + untracked | `U` | emerald | Untracked |
| `conflict` (any kind) | `!` | red | Conflict — `<ConflictKind label>` |

---

## Section 2 — Component Layout

### Pane structure (top to bottom)

1. **Header** — title + segmented counts + refresh.
2. **Conflicts** section (collapsible, hidden when count = 0).
3. **Staged Changes** section (collapsible, hidden when count = 0).
4. **Changes** section (collapsible; includes untracked merged in).
5. **Commit composer** — textarea + split commit button. Bottom-fixed, peer to Branch Commits.
6. **Branch Commits** — existing panel, preserved as-is.

### Header

Replaces the current `Changes · N files · +X -Y` line. New format:

```
Changes  !2 conflicts · 5 staged · 12 changes        +120 -45  ↻
```

Rules:
- Each segment is a button. Clicking it scrolls its section into view and forces it open.
- Segments with count `0` are hidden.
- The `conflicts` segment renders red. When `count > 0` it pulses (slow opacity fade, no movement, ~2s cycle, CSS only). When count = 0 it is hidden, not pulsed.
- Total `+/−` continues to come from `GitStatus.total_insertions` / `total_deletions`.
- Refresh button stays where it is.

### Section header

```
▼ Staged Changes  (5)                   [+ stage all] [× discard all]
```

- Chevron + label + parenthesized count.
- Section is collapsible. Open/closed state persists per-kind in `localStorage`:
  - `verun:changes:section:conflicts:open`
  - `verun:changes:section:staged:open`
  - `verun:changes:section:changes:open`
- Default: all open.
- Bulk action icons live on the right and are revealed on header hover (with focus-visible too, for keyboard).

Bulk actions per section:

| Section | Bulk actions |
|---|---|
| Conflicts | none (resolution is per-file by design) |
| Staged Changes | Unstage all (−) |
| Changes | Stage all (+), Discard all (×) |

`Stage all` calls a single IPC (`stage_all`) regardless of file count. `Discard all` and `Unstage all` likewise call single IPCs (`discard_all_unstaged`, `unstage_all`). All bulk actions show a spinner on the section header until the watcher refresh completes.

`Discard all` opens a real confirm dialog (`window.confirm` or a Solid modal — match existing patterns in `GitActions.tsx`) before firing.

### File row

```
[icon] src/foo/bar.ts                [open] [+] [×]   +12 -3   M
```

- File icon (existing `getFileIcon`).
- Path (truncated with ellipsis).
- Hover-revealed action icons, in order: `Open File`, primary action (`+` to stage / `−` to unstage), `×` to discard. Discard appears only on unstaged and untracked rows.
- Diff stats (`+12 -3`), tabular, omitted segments hidden when zero.
- Status letter/color from the shared taxonomy.

Click row → opens scoped diff in main editor (see Section 3 for scope).
Double-click → opens diff pinned.
Right-click → existing context menu, extended with `Stage` / `Unstage` / `Discard` items.

The `Open File` icon button is on every row in every section. It calls `openFilePinned(taskId, path, name)`.

#### Inline discard confirmation

Single-row Discard uses the same pattern as `GitActions.tsx`:
1. First `×` click swaps the icon to a red "Confirm?" pill, sets a `confirming(path)` signal with a 3s timeout.
2. Second click on the same pill within 3s fires `discard_files`.
3. Timeout or click elsewhere cancels.

Bulk Discard uses a real modal because the blast radius is larger.

#### Conflict row stage flow

Clicking `+` (Stage) on a conflict row does not call `stage_files` directly. Instead it opens `ConflictStageDialog` with three buttons:

- **Accept ours** — calls `resolve_conflict(taskId, path, 'ours')`.
- **Accept theirs** — calls `resolve_conflict(taskId, path, 'theirs')`.
- **Stage as-is (keep conflict markers)** — calls `stage_files(taskId, [path])`.

Each closes the dialog, applies optimistic patch (move the file's `conflict` to `null` and bump its `index_status` to `'M'` for the resolve choices, or mark it staged for "as-is"), and refreshes.

### Commit composer

Bottom-fixed, peer to Branch Commits. Fixed (does not require scrolling). Layout:

```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ Commit message...                   │ │  ← textarea, auto-grow 1→6 rows
│ └─────────────────────────────────────┘ │
│ [ Commit ▾ ]                       ⌘↵   │  ← split button + shortcut hint
└─────────────────────────────────────────┘
```

- Textarea: auto-grow 1→6 rows, vertical scroll past 6.
- Cmd+Enter (Mac) / Ctrl+Enter (other) submits.
- "Commit" button:
  - Disabled when `conflicts.length === 0 && staged.length === 0 && unstaged.length === 0` (worktree fully clean) OR when message is empty.
  - **Not** disabled when only unstaged/untracked exist — clicking in that state runs `stage_all` then `commit` ("smart commit").
- `▾` kebab opens a small menu:
  - **Amend last commit** — pre-fills textarea with last commit message (if textarea empty), then calls `commit_amend` on submit. Visual indicator on the button: "Commit (amend) ▾".
  - **Commit & Push** — runs `commit` then `push_branch`.
  - **Stage All & Commit** — runs `stage_all` then `commit` (explicit version of the smart-commit fallback).

Composer message persists per-task in `localStorage` (`verun:changes:msg:{taskId}`) so switching tasks does not lose drafts. Cleared after a successful commit.

### Component decomposition

| File | Responsibility |
|---|---|
| `CodeChanges.tsx` | Orchestrator. Owns the fan-out memo. Wires sections to store. |
| `ChangesHeader.tsx` | Header line — counts, pulse, refresh button. |
| `FileSection.tsx` | One collapsible section. Props: `kind`, `entries`, `bulkActions`. Owns its localStorage open/closed state. |
| `FileRow.tsx` | One row. Owns `confirming` state for inline discard. |
| `CommitComposer.tsx` | Textarea + split button + kebab. |
| `ConflictStageDialog.tsx` | Modal for the three-choice conflict-stage flow. |
| `BranchCommits.tsx` | Extracted from current `CodeChanges.tsx`, no behavior change. |
| `lib/gitStatus.ts` | Status taxonomy (letter, color, label, conflict mapping). |

Existing virtualization (`@tanstack/solid-virtual`) is used inside `FileSection.tsx`. Each section virtualizes independently. Bottom panels (composer + branch commits) remain non-scrolling.

---

## Section 3 — IPC + Actions Wiring

### New Tauri commands (`src-tauri/src/ipc.rs`)

| Command | Args | Returns | Implementation |
|---|---|---|---|
| `discard_files` | `task_id: String, paths: Vec<String>` | `()` | For tracked paths → `git checkout HEAD -- <paths>`. For untracked → `std::fs::remove_file`. Single Tauri call; under the hood may run two git invocations (one for tracked, one for fs). |
| `discard_all_unstaged` | `task_id: String` | `()` | `git checkout HEAD -- .` then `git clean -fd`. Single call. |
| `unstage_all` | `task_id: String` | `()` | `git reset HEAD --` (works even on initial commit when paired with `git rm --cached -r .` fallback). Single call. |
| `resolve_conflict` | `task_id: String, path: String, choice: String` | `()` | `git checkout --ours <path>` or `git checkout --theirs <path>`, then `git add <path>`. |
| `commit_amend` | `task_id: String, message: String` | `String` | `git commit --amend -m <msg>`. Returns new HEAD hash. |
| `get_staged_diff` | `task_id: String, file_path: String, context_lines: Option<u32>, ignore_whitespace: Option<bool>` | `FileDiff` | `git diff --cached -- <path>` parsed into the existing `FileDiff` shape. |
| `get_unstaged_diff` | `task_id: String, file_path: String, context_lines: Option<u32>, ignore_whitespace: Option<bool>` | `FileDiff` | `git diff -- <path>` parsed into the existing `FileDiff` shape. |
| `get_staged_diff_contents` | `task_id: String, file_path: String` | `DiffContents` | `git show HEAD:<path>` vs `git show :<path>`. For side-by-side editor. |
| `get_unstaged_diff_contents` | `task_id: String, file_path: String` | `DiffContents` | `git show :<path>` vs worktree file on disk. For side-by-side editor. |

Existing `stage_files`, `stage_all`, `unstage_files`, `commit`, `push_branch`, `get_file_diff`, `get_file_diff_contents` are reused unchanged.

Each new command gets a typed wrapper in `src/lib/ipc.ts`.

### `DiffSource` extension (`src/store/editorView.ts`)

```ts
export type DiffSource =
  | { type: 'working' }                          // existing — HEAD vs worktree
  | { type: 'staged' }                           // new — HEAD vs index
  | { type: 'unstaged' }                         // new — index vs worktree
  | { type: 'commit', commitHash: string }       // existing
```

`diffTabKey` is updated to include the `type` discriminator so the same path can have multiple distinct tabs simultaneously.

`DiffEditor.tsx` switches on `source.type`:
- `working` → existing path (`get_file_diff_contents`)
- `staged` → new `get_staged_diff_contents` (similar pattern, `git show HEAD:path` vs `git show :path` from index)
- `unstaged` → new `get_unstaged_diff_contents` (`git show :path` from index vs worktree file)
- `commit` → existing path

The inline hunk-list view uses `get_file_diff` / `get_staged_diff` / `get_unstaged_diff`. The side-by-side full-text view uses `get_file_diff_contents` / `get_staged_diff_contents` / `get_unstaged_diff_contents`. Each pair is selected by `DiffSource.type`.

### Row click → diff scope

| Section | Click opens |
|---|---|
| Conflicts | `{ type: 'working' }` (combined HEAD vs worktree, shows conflict markers) |
| Staged | `{ type: 'staged' }` |
| Changes (modified/deleted) | `{ type: 'unstaged' }` |
| Changes (untracked) | `{ type: 'working' }` (no index entry yet, so unstaged scope is meaningless; combined view shows full file as additions) |

---

## Section 4 — Optimistic Updates, Commit Flows, Reactivity

### Optimistic section-membership patches

Per-row Stage / Unstage / Discard actions apply an immediate local patch to `gitStates` so the row moves between sections without waiting for the watcher round-trip.

```ts
// pseudocode in CodeChanges.tsx
async function stageRow(file: FileStatus) {
  setGitStates(produce(s => {
    const fs = s[taskId]?.status?.files.find(f => f.path === file.path)
    if (!fs) return
    fs.indexStatus = (fs.indexStatus === ' ' || fs.indexStatus === '?')
      ? (fs.worktreeStatus === '?' ? 'A' : (fs.worktreeStatus as string))
      : fs.indexStatus
    fs.worktreeStatus = ' '
  }))

  try {
    await ipc.stageFiles(taskId, [file.path])
  } catch (e) {
    addToast(`Failed to stage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
    return
  }
  // Watcher event will fire refreshTaskGit shortly; no explicit call needed.
}
```

Bulk actions skip the per-row patch (would write to the store N times) and instead set a `bulkInflight(kind)` signal that disables row interactions and shows a section-header spinner until the watcher refresh resolves.

Diff stats (`stats`, `totalInsertions`, `totalDeletions`) are not patched optimistically — they update when the authoritative refresh arrives. Brief drift (~150-300ms) on the `+N -N` numbers is acceptable; section membership is the part that matters for perceived snappiness.

### Smart-commit flow

```
1. User types message, clicks Commit.
2. If staged.length === 0 && (unstaged.length + untracked.length > 0):
     await ipc.stage_all(taskId)
3. await ipc.commit(taskId, message)
4. clear textarea, clear localStorage draft
5. Watcher refresh updates lists and Branch Commits.
```

If step 3 fails (hooks, no identity, etc.), surface the stderr in a toast — do not auto-revert step 2's staging, since the user probably wants to retry.

### Commit & Push (kebab option)

Steps 1-4 of smart-commit, then:

```
5. await ipc.push_branch(taskId)
6. addToast('Pushed', 'success')
7. Force-refresh remote git state.
```

If push fails, toast the error but keep the commit (it succeeded).

### Amend flow

```
1. User opens kebab → Amend.
2. If textarea is empty, prefill with the message of the last commit on the branch
   (read from gitStates.commits[0] if available).
3. Button label changes to "Commit (amend)".
4. On submit: ipc.commit_amend(taskId, message).
5. Refresh — Branch Commits will show the new hash.
```

Amend is enabled only when there is at least one commit on the branch. If the staged set is empty, amend just rewrites the message; if non-empty, it includes the staged hunks.

### Conflict-stage dialog flow

```
1. Click + on a conflict row → openConflictStageDialog(file).
2. User picks one of three buttons.
3. For 'ours' / 'theirs':
     await ipc.resolve_conflict(taskId, path, choice)
   For 'as-is':
     await ipc.stage_files(taskId, [path])
4. Optimistic patch: file.conflict = null, file.indexStatus = 'M' (resolve)
   or file.indexStatus = file.worktreeStatus (stage-as-is), worktreeStatus = ' '.
5. Close dialog; watcher refresh reconciles.
```

### Watcher integration

Existing `git-local-changed` listener in `src/store/git.ts` is unchanged. Optimistic patches sit on top of the same store and get overwritten when the authoritative refresh comes in. No new event types are needed.

---

## Testing strategy

### Rust (`cargo test`)

- `parse_porcelain_status_classifies_all_conflict_pairs` — verify `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD` each produce the right `ConflictKind`.
- `parse_porcelain_status_separates_index_and_worktree` — verify `MM`, `MD`, `AM` produce the expected dimensions.
- `parse_numstat_includes_untracked_line_counts` — create an untracked file with 5 lines, assert `insertions = 5, deletions = 0`.
- `parse_numstat_caps_pathological_files` — create an untracked file with > 50k lines, assert `0/0` returned.
- Integration tests for each new IPC: `discard_files`, `discard_all_unstaged`, `unstage_all`, `resolve_conflict_ours`, `resolve_conflict_theirs`, `commit_amend`, `get_staged_diff`, `get_unstaged_diff`, `get_staged_diff_contents`, `get_unstaged_diff_contents`. Each runs against a temp repo built by the existing `init_test_repo` helper.

### Frontend (`pnpm test`)

- `gitStatus.test.ts` — `badgeForEntry` returns the right letter/color for every documented case.
- `CodeChanges.test.tsx`:
  - File in `MM` state produces two rows (one in Staged, one in Changes).
  - Conflict file appears only in Conflicts section, gets red `!` badge.
  - Untracked file appears in Changes with `U` letter, has `+N` stats.
  - Header counts match section counts.
  - Clicking `+` on a Changes row calls `stageFiles` and patches the file optimistically.
  - Clicking `+` on a Conflict row opens `ConflictStageDialog`, does not call `stageFiles` directly.
  - Bulk Discard opens modal; per-row Discard uses inline 3s confirm.
  - Smart-commit: with only unstaged/untracked, Commit button is enabled and triggers `stage_all` then `commit`.
  - Empty pane: Commit button disabled.
- `CommitComposer.test.tsx`:
  - Textarea auto-grows 1→6 rows.
  - Cmd+Enter submits.
  - Draft persists in localStorage per taskId.
- `DiffEditor.test.ts` — `DiffSource` discriminator routes to the right IPC for each type.

### Manual QA (per CLAUDE.md "Definition of Done")

- Run `make check` — zero errors.
- `pnpm tauri dev`, manually:
  - Make a `MM` file: confirm two rows.
  - Create a real merge conflict via `git rebase`: confirm Conflicts section appears with red `!`.
  - Stage / unstage / discard each work and the row moves immediately.
  - Bulk Stage All / Unstage All / Discard All work in one IPC each.
  - Smart-commit with no staged files works.
  - Amend works, message prefills.
  - Commit & Push works end-to-end.

---

## Migration / rollout

This is a breaking change to the `FileStatus` wire format (`status` and `staging` removed; `indexStatus`, `worktreeStatus`, `conflict` added). Every consumer must be updated in the same PR. No compatibility shim — the codebase is the only consumer of these types.

Search for all consumers of the old fields:
- `src/components/CodeChanges.tsx` — primary, rewritten.
- `src/components/GitActions.tsx` — uses `git.status?.files.length` and `f.status`/`f.path` for PR message building. Update to use the new shape.
- `src/components/Sidebar.tsx` — uses `git.status` for badges. Update.
- `src/components/FileTree.tsx` — uses git status for file decoration. Update.
- Any other `.tsx` referencing `f.status` or `f.staging`. Audit via grep.

CHANGELOG.md gets a single entry under `## Unreleased`:
- `Changes pane: full overhaul — sections (Conflicts/Staged/Changes), inline stage/unstage/discard, commit composer, conflict-resolve dialog, fixed status taxonomy`.

---

## Open questions for review

- **Empty-state copy.** Today the pane shows "No changes yet · File modifications will appear here as the agent works." Should the new pane keep this when *all three* sections are empty? Proposed: yes, only when all sections are empty. Show nothing when at least one section has rows.
- **Section auto-collapse on count = 0.** Should sections be hidden entirely when their count is 0, or shown with `(0)` and a "no items" body? Proposed: **hidden** when 0 to reduce visual noise. Conflicts section in particular should never appear when there are no conflicts.

These can be resolved during implementation if no preference is given.
