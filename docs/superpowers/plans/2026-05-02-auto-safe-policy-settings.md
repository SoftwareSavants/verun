# Auto-safe Policy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Verun's auto-safe policy user-configurable: a new global "Auto-safe" Settings tab plus a per-project override section, with structured controls per category and an editable Bash deny-pattern list. Worktree-protection hard blocks remain non-disable-able.

**Architecture:** Backend stores a single global policy JSON in a new `global_settings` table and per-project sparse overrides in a new `projects.auto_safe_override` TEXT column. A new `auto_safe.rs` module merges global + project into an `EffectivePolicy` struct that `policy::evaluate` consumes. Live sessions hold the policy in an `ArcSwap` so edits propagate without restart. Frontend uses Solid components + a new `autoSafe` store, hydrated via typed Tauri IPC.

**Tech Stack:** Rust (sqlx, serde, yash_syntax, arc_swap), Tauri v2, Solid.js + TypeScript, UnoCSS, vitest.

**Spec:** `docs/superpowers/specs/2026-05-02-auto-safe-policy-settings-design.md`

---

## File structure

### New files

- `src-tauri/src/auto_safe.rs` — types (`ReadScope`, `WriteScope`, `WebSearchMode`, `WebFetchMode`, `McpMode`, `BashPattern`, `GlobalPolicy`, `ProjectOverride`, `EffectivePolicy`), defaults, and `resolve_effective`.
- `src/components/AutoSafeSettings.tsx` — global Auto-safe tab content.
- `src/components/AutoSafeProjectOverride.tsx` — per-project override section.
- `src/components/RadioCard.tsx` — shared card with radio options + optional inline child.
- `src/components/ChipList.tsx` — shared chip-style multi-string input.
- `src/components/AddPatternForm.tsx` — inline expanding form for adding a Bash pattern.
- `src/components/BashPatternList.tsx` — shared list-of-patterns renderer (global + project variants).
- `src/store/autoSafe.ts` — frontend store: hydrates global + per-project overrides, exposes mutators that call IPC and broadcast.
- Test files: `src-tauri/src/auto_safe.rs` inline `#[cfg(test)]`, `src/store/autoSafe.test.ts`, `src/components/RadioCard.test.tsx`, `src/components/ChipList.test.tsx`, `src/components/AddPatternForm.test.tsx`, `src/components/BashPatternList.test.tsx`, `src/components/AutoSafeSettings.test.tsx`, `src/components/AutoSafeProjectOverride.test.tsx`.

### Modified files

- `src-tauri/src/policy.rs` — rename `TrustLevel::Normal` → `AutoSafe`, add `EffectivePolicy` plumbing, refactor `evaluate` to consume it, add user-pattern matcher.
- `src-tauri/src/db.rs` — new migrations (24: rename trust strings; 25: `global_settings` + `auto_safe_override`), `DbWrite` variants, read helpers.
- `src-tauri/src/ipc.rs` — new IPC commands, update `set_trust_level` to accept `auto_safe`, extend `export_project_config` / `import_project_config`.
- `src-tauri/src/task.rs` — load + plumb `Arc<ArcSwap<EffectivePolicy>>` into sessions; live-update on policy edits.
- `src-tauri/src/lib.rs` — register `mod auto_safe;` and the new IPC commands.
- `src/types/index.ts` — rename `TrustLevel` value, add new types.
- `src/lib/ipc.ts` — typed wrappers for new commands.
- `src/components/SettingsPage.tsx` — new sidebar tab "Auto-safe", new per-project section render.
- `src/components/MessageInput.tsx` — update `TRUST_OPTIONS` to use `'auto_safe'` instead of `'normal'`.
- `CHANGELOG.md`, `ROADMAP.md`, `README.md`.

---

## Task 1: Rename `TrustLevel::Normal` → `AutoSafe` (Rust + DB)

**Files:**
- Modify: `src-tauri/src/policy.rs:9-58, 144, 745, 758` (and any other `TrustLevel::Normal` reference)
- Modify: `src-tauri/src/db.rs:55-81` (migration version 2 stays untouched), add new migration 24
- Modify: `src-tauri/src/ipc.rs:1038-1075` (`set_trust_level` validation)
- Modify: `src-tauri/src/task.rs` (any `TrustLevel::Normal` reference / string default)

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/policy.rs` (in the existing `#[cfg(test)] mod tests` block):

```rust
#[test]
fn trust_level_strings_use_auto_safe() {
    assert_eq!(TrustLevel::AutoSafe.as_str(), "auto_safe");
    assert_eq!(TrustLevel::from_str("auto_safe"), TrustLevel::AutoSafe);
    // Numeric encoding unchanged so live atomics survive the rename.
    assert_eq!(TrustLevel::AutoSafe.to_u8(), 0);
    assert_eq!(TrustLevel::from_u8(0), TrustLevel::AutoSafe);
}

#[test]
fn trust_level_unknown_string_falls_back_to_auto_safe() {
    assert_eq!(TrustLevel::from_str("nope"), TrustLevel::AutoSafe);
    // Old "normal" string must NOT round-trip; it now reads as the renamed variant.
    assert_eq!(TrustLevel::from_str("normal"), TrustLevel::AutoSafe);
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p verun --lib policy::tests::trust_level_strings_use_auto_safe -- --nocapture
```

Expected: FAIL with `no variant 'AutoSafe'`.

- [ ] **Step 3: Rename the enum and string handling**

In `src-tauri/src/policy.rs`, replace the `TrustLevel` enum + impls (lines 9-58):

```rust
/// Per-task trust level — controls how aggressively we auto-approve tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLevel {
    /// User-configurable auto-safe policy (the default). See `auto_safe`
    /// module + `EffectivePolicy` for what gets auto-allowed.
    AutoSafe,
    /// Auto-allow everything — user explicitly trusts this task.
    FullAuto,
    /// Require approval for every tool call.
    Supervised,
}

impl TrustLevel {
    pub fn from_str(s: &str) -> Self {
        match s {
            "full_auto" => Self::FullAuto,
            "supervised" => Self::Supervised,
            // "auto_safe" and any unknown value fall through to AutoSafe.
            _ => Self::AutoSafe,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AutoSafe => "auto_safe",
            Self::FullAuto => "full_auto",
            Self::Supervised => "supervised",
        }
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Self::AutoSafe => 0,
            Self::FullAuto => 1,
            Self::Supervised => 2,
        }
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::FullAuto,
            2 => Self::Supervised,
            _ => Self::AutoSafe,
        }
    }

    pub fn from_atomic(atom: &AtomicU8) -> Self {
        Self::from_u8(atom.load(Ordering::Relaxed))
    }
}
```

Replace every `TrustLevel::Normal` occurrence in the file (search: `TrustLevel::Normal`) with `TrustLevel::AutoSafe`. Use:

```
grep -rn "TrustLevel::Normal" src-tauri/src
```

and update each hit. Expect hits in `policy.rs` line ~144 (the match arm `TrustLevel::Normal => {}`), the test fixtures around lines 745 and 758, plus `task.rs`.

- [ ] **Step 4: Add DB migration 24 to convert existing rows**

In `src-tauri/src/db.rs`, append a new migration after the existing version 23 (lines 258-279):

```rust
,
Migration {
    version: 24,
    description: "rename trust_level 'normal' to 'auto_safe'",
    sql: "UPDATE task_trust_levels SET trust_level = 'auto_safe' WHERE trust_level = 'normal';",
    kind: MigrationKind::Up,
},
```

(The trailing `]` and closing `}` of the `migrations()` vec move down by the inserted migration.)

- [ ] **Step 5: Update IPC validation**

In `src-tauri/src/ipc.rs` `set_trust_level` (around lines 1038-1075), change the validation match arms:

```rust
match trust_level.as_str() {
    "auto_safe" | "full_auto" | "supervised" => {}
    _ => {
        return Err(format!(
            "Invalid trust level: {trust_level}. Must be auto_safe, full_auto, or supervised"
        ));
    }
}
```

- [ ] **Step 6: Update test fixtures + any string defaults**

Search and update:
```
grep -rn "\"normal\"" src-tauri/src | grep -i trust
```

Replace `"normal"` with `"auto_safe"` in all trust-level contexts. Most hits will be in policy.rs tests (already covered above) and possibly task.rs string literals.

- [ ] **Step 7: Run tests + clippy + check**

```
cargo test -p verun --lib policy
cargo clippy -p verun -- -D warnings
cargo check
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/policy.rs src-tauri/src/db.rs src-tauri/src/ipc.rs src-tauri/src/task.rs
git commit -m "refactor: rename TrustLevel::Normal to AutoSafe

Backend rename + DB migration to convert existing 'normal' rows to
'auto_safe'. Numeric encoding unchanged (AutoSafe = 0)."
```

---

## Task 2: Frontend `TrustLevel` rename

**Files:**
- Modify: `src/types/index.ts:222`
- Modify: `src/components/MessageInput.tsx:67-71, 445, 480`
- Test: `src/types/index.ts` (compile-time check via `pnpm check`)

- [ ] **Step 1: Write the failing assertion** (compile-time)

The test is whether `pnpm check` rejects the old `'normal'` literal once `TrustLevel` no longer permits it.

In `src/components/MessageInput.tsx`, do not edit yet. Run:

```
pnpm check
```

Expected: PASS (current code is internally consistent on `'normal'`).

Now flip the type, then run again to see the failures.

- [ ] **Step 2: Flip the TS type**

In `src/types/index.ts:222`:

```ts
export type TrustLevel = 'auto_safe' | 'full_auto' | 'supervised'
```

- [ ] **Step 3: Run typecheck to surface call sites**

```
pnpm check
```

Expected: errors at the `'normal'` literals in `MessageInput.tsx`.

- [ ] **Step 4: Update MessageInput**

In `src/components/MessageInput.tsx`:

- Line ~67: in `TRUST_OPTIONS`, change `value: 'normal'` to `value: 'auto_safe'`. Also update the title from `'Auto-approve safe'` to `'Auto-safe'` for consistency with the new feature name. Subtitle stays as today.
- Line ~445: `createSignal<TrustLevel>('normal')` → `createSignal<TrustLevel>('auto_safe')`.
- Line ~480: comment `/* default to normal */` → `/* default to auto_safe */`.

The pill label rendering (lines ~2278-2287) currently renders `'Auto-safe'` only when `trustLevel() !== 'full_auto' && trustLevel() !== 'supervised'`. Update that fallback label string from `'Auto-approve safe'` if present, to `'Auto-safe'`. (Re-grep `Auto-approve safe` to be sure.)

- [ ] **Step 5: Run typecheck**

```
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/components/MessageInput.tsx
git commit -m "refactor: rename TrustLevel 'normal' to 'auto_safe' (frontend)"
```

---

## Task 3: New `auto_safe` module — types + defaults

**Files:**
- Create: `src-tauri/src/auto_safe.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod auto_safe;`)

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/auto_safe.rs` with the test scaffolding only:

```rust
//! Auto-safe policy: user-configurable defaults that drive `policy::evaluate`
//! when the task's trust level is `AutoSafe`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadScope { Repo, Any, Ask }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteScope { Worktree, Repo, Any, Ask }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchMode { Allow, Ask }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebFetchMode { Allow, Domains, Ask }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpMode { Allow, Servers, Ask }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashPattern {
    pub id: String,
    pub pattern: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadConfig { pub scope: ReadScope }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteConfig { pub scope: WriteScope }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSearchConfig { pub mode: WebSearchMode }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebFetchConfig {
    pub mode: WebFetchMode,
    #[serde(default)]
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpConfig {
    pub mode: McpMode,
    #[serde(default)]
    pub servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashConfig { pub patterns: Vec<BashPattern> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobalPolicy {
    pub version: u32,
    pub read: ReadConfig,
    pub write: WriteConfig,
    pub websearch: WebSearchConfig,
    pub webfetch: WebFetchConfig,
    pub mcp: McpConfig,
    pub bash: BashConfig,
}

/// IDs of built-in Bash deny patterns. Stable across versions so per-project
/// `disabled_global` lists keep working when the global list shrinks/grows.
pub const BUILTIN_PATTERN_IDS: &[(&str, &str)] = &[
    ("sudo", "sudo"),
    ("ssh-scp", "ssh / scp"),
    ("rsync", "rsync"),
    ("kill", "kill / pkill / killall"),
    ("chmod-chown", "chmod / chown"),
    ("docker-kubectl", "docker / kubectl"),
    ("git-push-force", "git push --force"),
    ("git-reset-hard", "git reset --hard"),
    ("git-clean-f", "git clean -f"),
    ("git-checkout-discard", "git checkout -- ."),
    ("git-branch-D", "git branch -D"),
    ("git-stash-drop", "git stash drop"),
    ("rm-rf", "rm -rf"),
    ("curl-pipe-sh", "curl | sh"),
];

pub fn defaults() -> GlobalPolicy {
    GlobalPolicy {
        version: 1,
        read: ReadConfig { scope: ReadScope::Repo },
        write: WriteConfig { scope: WriteScope::Worktree },
        websearch: WebSearchConfig { mode: WebSearchMode::Ask },
        webfetch: WebFetchConfig { mode: WebFetchMode::Ask, domains: vec![] },
        mcp: McpConfig { mode: McpMode::Ask, servers: vec![] },
        bash: BashConfig {
            patterns: BUILTIN_PATTERN_IDS
                .iter()
                .map(|(id, label)| BashPattern {
                    id: (*id).into(),
                    pattern: (*label).into(),
                    builtin: true,
                })
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_legacy_hardcoded_policy() {
        let p = defaults();
        assert_eq!(p.version, 1);
        assert_eq!(p.read.scope, ReadScope::Repo);
        assert_eq!(p.write.scope, WriteScope::Worktree);
        assert_eq!(p.websearch.mode, WebSearchMode::Ask);
        assert_eq!(p.webfetch.mode, WebFetchMode::Ask);
        assert_eq!(p.mcp.mode, McpMode::Ask);
        // sanity: built-in pattern list seeded
        assert!(p.bash.patterns.iter().any(|b| b.id == "sudo"));
        assert!(p.bash.patterns.iter().any(|b| b.id == "git-push-force"));
        assert!(p.bash.patterns.iter().all(|b| b.builtin));
    }

    #[test]
    fn global_policy_round_trips_through_json() {
        let p = defaults();
        let s = serde_json::to_string(&p).unwrap();
        let back: GlobalPolicy = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, add near the existing `mod policy;` line (~line 17):

```rust
mod auto_safe;
```

- [ ] **Step 3: Run tests**

```
cargo test -p verun --lib auto_safe::tests
```

Expected: PASS.

- [ ] **Step 4: Clippy**

```
cargo clippy -p verun -- -D warnings
```

Expected: no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/auto_safe.rs src-tauri/src/lib.rs
git commit -m "feat(auto-safe): add policy types + defaults module"
```

---

## Task 4: `auto_safe::resolve_effective` merge

**Files:**
- Modify: `src-tauri/src/auto_safe.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/auto_safe.rs` (above the existing tests block):

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverrideBash {
    #[serde(default)]
    pub disabled_global: Vec<String>,
    #[serde(default)]
    pub extra: Vec<BashPattern>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectOverride {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<WriteConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websearch: Option<WebSearchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webfetch: Option<WebFetchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<McpConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bash: Option<ProjectOverrideBash>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectivePolicy {
    pub read: ReadConfig,
    pub write: WriteConfig,
    pub websearch: WebSearchConfig,
    pub webfetch: WebFetchConfig,
    pub mcp: McpConfig,
    pub bash_patterns: Vec<BashPattern>,
}

pub fn resolve_effective(global: &GlobalPolicy, project: Option<&ProjectOverride>) -> EffectivePolicy {
    let mut bash_patterns = global.bash.patterns.clone();
    if let Some(po) = project {
        if !po.bash.as_ref().map(|b| b.disabled_global.is_empty()).unwrap_or(true) {
            let disabled: std::collections::HashSet<&str> = po
                .bash
                .as_ref()
                .unwrap()
                .disabled_global
                .iter()
                .map(|s| s.as_str())
                .collect();
            bash_patterns.retain(|bp| !disabled.contains(bp.id.as_str()));
        }
        if let Some(b) = po.bash.as_ref() {
            for extra in &b.extra {
                bash_patterns.push(extra.clone());
            }
        }
    }
    EffectivePolicy {
        read: project.and_then(|p| p.read.clone()).unwrap_or_else(|| global.read.clone()),
        write: project.and_then(|p| p.write.clone()).unwrap_or_else(|| global.write.clone()),
        websearch: project
            .and_then(|p| p.websearch.clone())
            .unwrap_or_else(|| global.websearch.clone()),
        webfetch: project
            .and_then(|p| p.webfetch.clone())
            .unwrap_or_else(|| global.webfetch.clone()),
        mcp: project.and_then(|p| p.mcp.clone()).unwrap_or_else(|| global.mcp.clone()),
        bash_patterns,
    }
}
```

Add tests inside the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn resolve_no_override_returns_global() {
    let g = defaults();
    let eff = resolve_effective(&g, None);
    assert_eq!(eff.read, g.read);
    assert_eq!(eff.write, g.write);
    assert_eq!(eff.bash_patterns, g.bash.patterns);
}

#[test]
fn resolve_override_read_scope_wins() {
    let g = defaults();
    let po = ProjectOverride {
        version: 1,
        read: Some(ReadConfig { scope: ReadScope::Any }),
        ..Default::default()
    };
    let eff = resolve_effective(&g, Some(&po));
    assert_eq!(eff.read.scope, ReadScope::Any);
    assert_eq!(eff.write, g.write); // unchanged
}

#[test]
fn resolve_disables_global_bash_pattern() {
    let g = defaults();
    let po = ProjectOverride {
        version: 1,
        bash: Some(ProjectOverrideBash {
            disabled_global: vec!["rsync".into()],
            extra: vec![],
        }),
        ..Default::default()
    };
    let eff = resolve_effective(&g, Some(&po));
    assert!(eff.bash_patterns.iter().any(|b| b.id == "sudo"));
    assert!(!eff.bash_patterns.iter().any(|b| b.id == "rsync"));
}

#[test]
fn resolve_appends_project_extras() {
    let g = defaults();
    let po = ProjectOverride {
        version: 1,
        bash: Some(ProjectOverrideBash {
            disabled_global: vec![],
            extra: vec![BashPattern {
                id: "user-npm-publish".into(),
                pattern: "npm publish".into(),
                builtin: false,
            }],
        }),
        ..Default::default()
    };
    let eff = resolve_effective(&g, Some(&po));
    assert!(eff.bash_patterns.iter().any(|b| b.id == "user-npm-publish"));
}

#[test]
fn project_override_round_trips_through_json_with_omitted_keys() {
    let po = ProjectOverride {
        version: 1,
        read: Some(ReadConfig { scope: ReadScope::Any }),
        ..Default::default()
    };
    let s = serde_json::to_string(&po).unwrap();
    // Omitted keys must NOT appear in JSON.
    assert!(!s.contains("\"write\""), "write key should be omitted: {s}");
    assert!(!s.contains("\"mcp\""), "mcp key should be omitted: {s}");
    let back: ProjectOverride = serde_json::from_str(&s).unwrap();
    assert_eq!(po, back);
}
```

- [ ] **Step 2: Run tests**

```
cargo test -p verun --lib auto_safe
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auto_safe.rs
git commit -m "feat(auto-safe): add ProjectOverride + resolve_effective merge"
```

---

## Task 5: DB schema migration — `global_settings` + `auto_safe_override`

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` block in `src-tauri/src/db.rs`:

```rust
#[tokio::test]
async fn migration_adds_global_settings_and_auto_safe_override() {
    let pool = make_test_pool().await;
    // Both shapes should exist after migrations have run.
    let cnt: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='global_settings'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cnt.0, 1);

    let cnt: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name='auto_safe_override'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cnt.0, 1);
}
```

(`make_test_pool` already runs all migrations — verify by searching `make_test_pool` in `db.rs` if needed.)

- [ ] **Step 2: Run test, expect FAIL**

```
cargo test -p verun --lib db::tests::migration_adds_global_settings_and_auto_safe_override
```

Expected: FAIL with `no such table: global_settings`.

- [ ] **Step 3: Add migration 25**

In `src-tauri/src/db.rs`, append after migration 24 (end of the `migrations()` vec, just before the closing `]`):

```rust
,
Migration {
    version: 25,
    description: "auto-safe policy: global settings table + per-project override column",
    sql: r#"
        CREATE TABLE IF NOT EXISTS global_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        ALTER TABLE projects ADD COLUMN auto_safe_override TEXT;
    "#,
    kind: MigrationKind::Up,
},
```

- [ ] **Step 4: Run test, expect PASS**

```
cargo test -p verun --lib db::tests::migration_adds_global_settings_and_auto_safe_override
```

Expected: PASS.

- [ ] **Step 5: Verify no other DB tests broke**

```
cargo test -p verun --lib db::tests
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): add global_settings + projects.auto_safe_override (migration 25)"
```

---

## Task 6: DB read/write helpers for auto-safe policy

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing test**

Append to `db::tests`:

```rust
#[tokio::test]
async fn global_auto_safe_policy_round_trip() {
    let pool = make_test_pool().await;
    // No row yet -> defaults seed via helper.
    let p = get_or_seed_global_auto_safe_policy(&pool).await.unwrap();
    assert_eq!(p, crate::auto_safe::defaults());

    // Mutate and store.
    let mut new_p = p.clone();
    new_p.websearch.mode = crate::auto_safe::WebSearchMode::Allow;
    process_write(&pool, DbWrite::SetGlobalAutoSafePolicy {
        json: serde_json::to_string(&new_p).unwrap(),
    })
    .await
    .unwrap();

    let read = get_or_seed_global_auto_safe_policy(&pool).await.unwrap();
    assert_eq!(read.websearch.mode, crate::auto_safe::WebSearchMode::Allow);
}

#[tokio::test]
async fn project_auto_safe_override_round_trip() {
    let pool = make_test_pool().await;
    process_write(&pool, DbWrite::InsertProject(make_project()))
        .await
        .unwrap();
    let none = get_project_auto_safe_override(&pool, "p-001").await.unwrap();
    assert!(none.is_none());

    let po = crate::auto_safe::ProjectOverride {
        version: 1,
        read: Some(crate::auto_safe::ReadConfig { scope: crate::auto_safe::ReadScope::Any }),
        ..Default::default()
    };
    process_write(&pool, DbWrite::SetProjectAutoSafeOverride {
        project_id: "p-001".into(),
        json: Some(serde_json::to_string(&po).unwrap()),
    })
    .await
    .unwrap();

    let some = get_project_auto_safe_override(&pool, "p-001").await.unwrap();
    assert_eq!(some, Some(po));

    // Clear override.
    process_write(&pool, DbWrite::SetProjectAutoSafeOverride {
        project_id: "p-001".into(),
        json: None,
    })
    .await
    .unwrap();
    let cleared = get_project_auto_safe_override(&pool, "p-001").await.unwrap();
    assert!(cleared.is_none());
}
```

- [ ] **Step 2: Run test, expect FAIL**

Expected: FAIL on missing functions / `DbWrite` variants.

- [ ] **Step 3: Add `DbWrite` variants**

In `src-tauri/src/db.rs`, in the `DbWrite` enum (search for `pub enum DbWrite`), add two variants near `SetTrustLevel`:

```rust
SetGlobalAutoSafePolicy {
    json: String,
},
SetProjectAutoSafeOverride {
    project_id: String,
    /// `None` clears the override (sets the column to NULL).
    json: Option<String>,
},
```

- [ ] **Step 4: Handle the writes**

In the `process_write` function (search the file for the existing `DbWrite::SetTrustLevel { ... }` branch), add new branches:

```rust
DbWrite::SetGlobalAutoSafePolicy { json } => {
    let now = crate::task::epoch_ms();
    sqlx::query(
        "INSERT INTO global_settings (key, value, updated_at) \
         VALUES ('auto_safe_policy', ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&json)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("write global auto-safe policy: {e}"))?;
}
DbWrite::SetProjectAutoSafeOverride { project_id, json } => {
    sqlx::query("UPDATE projects SET auto_safe_override = ? WHERE id = ?")
        .bind(json.as_deref())
        .bind(&project_id)
        .execute(pool)
        .await
        .map_err(|e| format!("write project auto-safe override: {e}"))?;
}
```

- [ ] **Step 5: Add read helpers**

Append to `db.rs` (near the existing `get_trust_level`):

```rust
pub async fn get_or_seed_global_auto_safe_policy(
    pool: &SqlitePool,
) -> Result<crate::auto_safe::GlobalPolicy, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM global_settings WHERE key = 'auto_safe_policy'")
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("read global_settings: {e}"))?;
    if let Some((json,)) = row {
        let parsed: crate::auto_safe::GlobalPolicy = serde_json::from_str(&json)
            .map_err(|e| format!("parse global auto-safe policy: {e}"))?;
        return Ok(parsed);
    }
    // Seed defaults.
    let defaults = crate::auto_safe::defaults();
    let json = serde_json::to_string(&defaults).map_err(|e| e.to_string())?;
    let now = crate::task::epoch_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO global_settings (key, value, updated_at) VALUES ('auto_safe_policy', ?, ?)",
    )
    .bind(&json)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("seed global auto-safe policy: {e}"))?;
    Ok(defaults)
}

pub async fn get_project_auto_safe_override(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Option<crate::auto_safe::ProjectOverride>, String> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT auto_safe_override FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("read project override: {e}"))?;
    let json = match row.and_then(|(j,)| j) {
        Some(j) if !j.is_empty() => j,
        _ => return Ok(None),
    };
    let parsed: crate::auto_safe::ProjectOverride =
        serde_json::from_str(&json).map_err(|e| format!("parse project override: {e}"))?;
    Ok(Some(parsed))
}
```

- [ ] **Step 6: Run tests, expect PASS**

```
cargo test -p verun --lib db::tests
cargo clippy -p verun -- -D warnings
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): add auto-safe policy read/write helpers"
```

---

## Task 7: Refactor `policy::evaluate` to consume `EffectivePolicy`

**Files:**
- Modify: `src-tauri/src/policy.rs`

- [ ] **Step 1: Write the failing test**

Append to `policy::tests`:

```rust
#[test]
fn auto_safe_websearch_allow_when_policy_says_allow() {
    let mut p = crate::auto_safe::defaults();
    p.websearch.mode = crate::auto_safe::WebSearchMode::Allow;
    let eff = crate::auto_safe::resolve_effective(&p, None);
    let result = evaluate(
        "WebSearch",
        &serde_json::json!({"query": "verun"}),
        "/tmp",
        "/tmp",
        TrustLevel::AutoSafe,
        &eff,
    );
    assert_eq!(result.decision, PolicyDecision::AutoAllow);
}

#[test]
fn auto_safe_webfetch_domain_match_is_dns_label_suffix() {
    let mut p = crate::auto_safe::defaults();
    p.webfetch.mode = crate::auto_safe::WebFetchMode::Domains;
    p.webfetch.domains = vec!["github.com".into()];
    let eff = crate::auto_safe::resolve_effective(&p, None);

    let allow_sub = evaluate(
        "WebFetch",
        &serde_json::json!({"url": "https://api.github.com/repos/foo"}),
        "/tmp", "/tmp",
        TrustLevel::AutoSafe,
        &eff,
    );
    assert_eq!(allow_sub.decision, PolicyDecision::AutoAllow);

    let deny_lookalike = evaluate(
        "WebFetch",
        &serde_json::json!({"url": "https://notgithub.com/x"}),
        "/tmp", "/tmp",
        TrustLevel::AutoSafe,
        &eff,
    );
    assert_eq!(deny_lookalike.decision, PolicyDecision::RequireApproval);
}

#[test]
fn auto_safe_mcp_server_allowlist() {
    let mut p = crate::auto_safe::defaults();
    p.mcp.mode = crate::auto_safe::McpMode::Servers;
    p.mcp.servers = vec!["atlassian".into()];
    let eff = crate::auto_safe::resolve_effective(&p, None);

    let allow = evaluate(
        "mcp__atlassian__search",
        &serde_json::json!({}),
        "/tmp", "/tmp",
        TrustLevel::AutoSafe,
        &eff,
    );
    assert_eq!(allow.decision, PolicyDecision::AutoAllow);

    let deny = evaluate(
        "mcp__apollo__people_match",
        &serde_json::json!({}),
        "/tmp", "/tmp",
        TrustLevel::AutoSafe,
        &eff,
    );
    assert_eq!(deny.decision, PolicyDecision::RequireApproval);
}
```

(All existing tests must keep their current expectations; we'll update each call site to pass `EffectivePolicy::default()` semantics — which equals `auto_safe::defaults()`-derived effective.)

- [ ] **Step 2: Run, expect FAIL**

```
cargo test -p verun --lib policy::tests::auto_safe_websearch_allow_when_policy_says_allow
```

Expected: FAIL — signature mismatch.

- [ ] **Step 3: Add a helper for tests + change `evaluate` signature**

Replace the `evaluate` signature (line 100) with:

```rust
pub fn evaluate(
    tool_name: &str,
    tool_input: &serde_json::Value,
    worktree_path: &str,
    repo_path: &str,
    trust_level: TrustLevel,
    policy: &crate::auto_safe::EffectivePolicy,
) -> PolicyResult {
    // Hard blocks first (unchanged).
    if tool_name == "ExitPlanMode" {
        return PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: "plan review always requires user approval".into(),
        };
    }
    if tool_name == "Bash" {
        let command = tool_input.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(pattern) = matches_hard_block(command) {
            return PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: format!("hard-blocked: {pattern}"),
            };
        }
    }

    match trust_level {
        TrustLevel::FullAuto => {
            return PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "trust level is full_auto".into(),
            };
        }
        TrustLevel::Supervised => {
            return PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "trust level is supervised".into(),
            };
        }
        TrustLevel::AutoSafe => {}
    }

    use crate::auto_safe::{ReadScope, WriteScope, WebSearchMode, WebFetchMode, McpMode};

    match tool_name {
        "Read" | "Glob" | "Grep" | "LSP" => match policy.read.scope {
            ReadScope::Any => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "read scope = any".into(),
            },
            ReadScope::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "read scope = ask".into(),
            },
            ReadScope::Repo => {
                if let Some(path) = extract_path(tool_input) {
                    if is_path_within(&path, repo_path) {
                        PolicyResult {
                            decision: PolicyDecision::AutoAllow,
                            reason: format!("read within project repo: {path}"),
                        }
                    } else {
                        PolicyResult {
                            decision: PolicyDecision::RequireApproval,
                            reason: format!("read outside project repo: {path}"),
                        }
                    }
                } else {
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("{tool_name} with no file path"),
                    }
                }
            }
        },

        "Edit" | "Write" | "NotebookEdit" => {
            let path = extract_path(tool_input);
            match policy.write.scope {
                WriteScope::Any => PolicyResult {
                    decision: PolicyDecision::AutoAllow,
                    reason: "write scope = any".into(),
                },
                WriteScope::Ask => PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: "write scope = ask".into(),
                },
                WriteScope::Repo => match path {
                    Some(p) if is_path_within(&p, repo_path) => PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("write within project repo: {p}"),
                    },
                    Some(p) => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("write outside project repo: {p}"),
                    },
                    None => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("{tool_name} with no file path"),
                    },
                },
                WriteScope::Worktree => match path {
                    Some(p) if is_path_within(&p, worktree_path) => PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("write within worktree: {p}"),
                    },
                    Some(p) => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("write outside worktree: {p}"),
                    },
                    None => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("{tool_name} with no file path"),
                    },
                },
            }
        }

        "Bash" => {
            let command = tool_input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(pattern_id) = matches_user_patterns(command, &policy.bash_patterns) {
                PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("bash matches deny pattern: {pattern_id}"),
                }
            } else {
                PolicyResult {
                    decision: PolicyDecision::AutoAllowLogged,
                    reason: "bash command not in deny list".into(),
                }
            }
        }

        "Agent" => PolicyResult {
            decision: PolicyDecision::AutoAllow,
            reason: "agent tool — sub-calls evaluated individually".into(),
        },

        name if name.starts_with("mcp__") => {
            let server = name
                .trim_start_matches("mcp__")
                .split("__")
                .next()
                .unwrap_or("");
            match policy.mcp.mode {
                McpMode::Allow => PolicyResult {
                    decision: PolicyDecision::AutoAllow,
                    reason: "mcp mode = allow".into(),
                },
                McpMode::Ask => PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("MCP tool: {name}"),
                },
                McpMode::Servers => {
                    if policy.mcp.servers.iter().any(|s| s == server) {
                        PolicyResult {
                            decision: PolicyDecision::AutoAllow,
                            reason: format!("mcp server '{server}' in allowlist"),
                        }
                    } else {
                        PolicyResult {
                            decision: PolicyDecision::RequireApproval,
                            reason: format!("mcp server '{server}' not in allowlist"),
                        }
                    }
                }
            }
        }

        "WebSearch" => match policy.websearch.mode {
            WebSearchMode::Allow => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "websearch = allow".into(),
            },
            WebSearchMode::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "websearch = ask".into(),
            },
        },

        "WebFetch" => match policy.webfetch.mode {
            WebFetchMode::Allow => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "webfetch = allow".into(),
            },
            WebFetchMode::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "webfetch = ask".into(),
            },
            WebFetchMode::Domains => {
                let url = tool_input.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let host = parse_host(url).unwrap_or_default();
                if !host.is_empty() && policy.webfetch.domains.iter().any(|d| host_matches(&host, d)) {
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("webfetch host '{host}' in allowlist"),
                    }
                } else {
                    PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("webfetch host '{host}' not in allowlist"),
                    }
                }
            }
        },

        _ => PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: format!("unknown tool: {tool_name}"),
        },
    }
}
```

Add helpers in the same file:

```rust
fn parse_host(url: &str) -> Option<String> {
    // Minimal scheme-aware host extraction: looks for '://' then the next '/' or end.
    let after_scheme = url.find("://").map(|i| &url[i + 3..]).unwrap_or(url);
    let host = after_scheme.split(['/', '?', '#']).next()?.to_string();
    let host = host.split('@').last().unwrap_or("").to_string();
    if host.is_empty() {
        None
    } else {
        // Strip any :port suffix.
        Some(host.split(':').next().unwrap_or("").to_string())
    }
}

/// DNS-label suffix match. `host_matches("api.github.com", "github.com")` = true,
/// `host_matches("notgithub.com", "github.com")` = false.
fn host_matches(host: &str, domain: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() { return false; }
    if h == d { return true; }
    h.ends_with(&format!(".{d}"))
}

/// Returns the id of the first matching pattern, if any.
fn matches_user_patterns(_command: &str, _patterns: &[crate::auto_safe::BashPattern]) -> Option<String> {
    // Implementation in Task 8. Stub for now.
    None
}
```

Update every existing internal test in `policy::tests` to pass an `EffectivePolicy`. Add a helper at the top of the test module:

```rust
fn default_policy() -> crate::auto_safe::EffectivePolicy {
    crate::auto_safe::resolve_effective(&crate::auto_safe::defaults(), None)
}
```

And add `&default_policy()` as the new sixth argument to every existing `evaluate(...)` call in tests. (Use `cargo build -p verun --lib` to surface every site; fix one by one.)

- [ ] **Step 4: Run tests**

```
cargo test -p verun --lib policy
```

Expected: PASS — including the three new ones. (Bash deny tests still pass via the existing `matches_hard_block` for hard-blocks. The user-pattern path is stubbed to always-None, which means existing tests like `bash_safe_command_auto_allowed_logged` keep passing, but tests like `deny_safe_commands` may now fail because the user-pattern matcher is empty. Update those to use `matches_user_patterns` directly with `auto_safe::defaults().bash.patterns` once Task 8 lands. For this task, **temporarily disable** any existing test that asserts user-pattern matches via `evaluate` by adding `#[ignore = "rewired in Task 8"]`. Document each ignore so Task 8 can re-enable.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/policy.rs
git commit -m "refactor(policy): evaluate now consumes EffectivePolicy

Reads/writes/web/mcp now read modes from the user-configured policy
instead of hardcoded branches. Bash deny matching stubbed out;
re-enabled in the next task."
```

---

## Task 8: User-pattern matcher for Bash deny

**Files:**
- Modify: `src-tauri/src/policy.rs`

- [ ] **Step 1: Write the failing tests**

Append to `policy::tests`:

```rust
#[test]
fn user_pattern_program_only_matches() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "sudo".into(),
        pattern: "sudo".into(),
        builtin: true,
    }];
    assert_eq!(
        matches_user_patterns("sudo apt update", &patterns).as_deref(),
        Some("sudo")
    );
    assert_eq!(matches_user_patterns("ls -la", &patterns), None);
}

#[test]
fn user_pattern_subcommand_match() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "user-npm-publish".into(),
        pattern: "npm publish".into(),
        builtin: false,
    }];
    assert_eq!(
        matches_user_patterns("npm publish --tag latest", &patterns).as_deref(),
        Some("user-npm-publish")
    );
    assert_eq!(matches_user_patterns("npm install", &patterns), None);
}

#[test]
fn user_pattern_required_flag_match() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "git-push-force".into(),
        pattern: "git push --force".into(),
        builtin: true,
    }];
    assert_eq!(
        matches_user_patterns("git push --force origin main", &patterns).as_deref(),
        Some("git-push-force")
    );
    // Plain push without --force does not match.
    assert_eq!(matches_user_patterns("git push origin main", &patterns), None);
    // Short flag equivalence: -f matches --force for `git push`.
    assert_eq!(
        matches_user_patterns("git push -f origin main", &patterns).as_deref(),
        Some("git-push-force")
    );
}

#[test]
fn user_pattern_curl_pipe_sh() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "curl-pipe-sh".into(),
        pattern: "curl | sh".into(),
        builtin: true,
    }];
    assert_eq!(
        matches_user_patterns("curl https://x.com/install.sh | sh", &patterns).as_deref(),
        Some("curl-pipe-sh")
    );
    assert_eq!(matches_user_patterns("curl https://x.com", &patterns), None);
}

#[test]
fn user_pattern_unknown_id_uses_generic_matcher() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "user-aws-rm".into(),
        pattern: "aws s3 rm".into(),
        builtin: false,
    }];
    assert_eq!(
        matches_user_patterns("aws s3 rm s3://bucket/key", &patterns).as_deref(),
        Some("user-aws-rm")
    );
    assert_eq!(
        matches_user_patterns("aws s3 ls s3://bucket", &patterns),
        None
    );
}

#[test]
fn user_pattern_does_not_match_inside_argument() {
    let patterns = vec![crate::auto_safe::BashPattern {
        id: "sudo".into(),
        pattern: "sudo".into(),
        builtin: true,
    }];
    // `echo sudo` mentions sudo as an argument, not as the program. No match.
    assert_eq!(matches_user_patterns("echo sudo", &patterns), None);
}
```

- [ ] **Step 2: Run, expect FAIL**

```
cargo test -p verun --lib policy::tests::user_pattern_program_only_matches
```

Expected: FAIL.

- [ ] **Step 3: Implement the matcher**

Replace the stub `matches_user_patterns` with a real implementation. Add helpers near the existing `walk_command_with` / `check_args` helpers:

```rust
/// Parsed form of a user pattern.
#[derive(Debug, Clone)]
struct ParsedPattern<'a> {
    id: &'a str,
    program: String,
    /// Subcommand words (positional args, in order) before any flags.
    subcommand: Vec<String>,
    /// Required flags (any leading-`-` token in the pattern).
    flags: Vec<String>,
    /// Special: pipe-to-shell (only `curl | sh` / `wget | sh` / `... | bash` / `... | zsh`).
    pipe_to_shell: bool,
}

fn parse_user_pattern<'a>(p: &'a crate::auto_safe::BashPattern) -> Option<ParsedPattern<'a>> {
    let text = p.pattern.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((left, right)) = text.split_once('|') {
        let left = left.trim();
        let right = right.trim();
        if matches!(right, "sh" | "bash" | "zsh") {
            // Capture the left program (curl/wget/...) as `program`; flags ignored.
            let lhs_first = left.split_whitespace().next().unwrap_or("");
            return Some(ParsedPattern {
                id: &p.id,
                program: lhs_first.to_string(),
                subcommand: vec![],
                flags: vec![],
                pipe_to_shell: true,
            });
        }
    }
    let mut tokens = text.split_whitespace();
    let program = tokens.next()?.to_string();
    let mut subcommand = Vec::new();
    let mut flags = Vec::new();
    for tok in tokens {
        if tok.starts_with('-') {
            flags.push(tok.to_string());
        } else {
            subcommand.push(tok.to_string());
        }
    }
    Some(ParsedPattern {
        id: &p.id,
        program,
        subcommand,
        flags,
        pipe_to_shell: false,
    })
}

fn matches_user_patterns(
    command: &str,
    patterns: &[crate::auto_safe::BashPattern],
) -> Option<String> {
    let parsed: Vec<ParsedPattern<'_>> = patterns.iter().filter_map(parse_user_pattern).collect();
    if parsed.is_empty() {
        return None;
    }
    let list: yash_syntax::syntax::List = command.parse().ok()?;
    walk_user_match(&list, &parsed)
}

fn walk_user_match(list: &yash_syntax::syntax::List, patterns: &[ParsedPattern]) -> Option<String> {
    for item in &list.0 {
        let aol = &*item.and_or;
        for pipeline in std::iter::once(&aol.first).chain(aol.rest.iter().map(|(_, p)| p)) {
            if let Some(r) = walk_pipeline_user_match(pipeline, patterns) {
                return Some(r);
            }
        }
    }
    None
}

fn walk_pipeline_user_match(
    pipeline: &yash_syntax::syntax::Pipeline,
    patterns: &[ParsedPattern],
) -> Option<String> {
    use yash_syntax::syntax::Command;
    if pipeline.commands.len() >= 2 {
        let first = pipeline.commands.first().unwrap();
        let last = pipeline.commands.last().unwrap();
        if let (Command::Simple(f), Command::Simple(l)) = (first.as_ref(), last.as_ref()) {
            let fp = f.words.first().map(|(w, _)| w.to_string()).unwrap_or_default();
            let lp = l.words.first().map(|(w, _)| w.to_string()).unwrap_or_default();
            if matches!(lp.as_str(), "sh" | "bash" | "zsh") {
                for p in patterns {
                    if p.pipe_to_shell && p.program == fp {
                        return Some(p.id.to_string());
                    }
                }
            }
        }
    }
    for cmd in &pipeline.commands {
        if let Some(r) = walk_command_user_match(cmd, patterns) {
            return Some(r);
        }
    }
    None
}

fn walk_command_user_match(
    cmd: &yash_syntax::syntax::Command,
    patterns: &[ParsedPattern],
) -> Option<String> {
    use yash_syntax::syntax::{Command, CompoundCommand};
    match cmd {
        Command::Simple(sc) => {
            let args: Vec<String> = sc.words.iter().map(|(w, _)| w.to_string()).collect();
            check_user_simple(&args, patterns)
        }
        Command::Compound(fcc) => match &fcc.command {
            CompoundCommand::Subshell { body, .. } => walk_user_match(body, patterns),
            CompoundCommand::Grouping(body) => walk_user_match(body, patterns),
            _ => None,
        },
        Command::Function(_) => None,
    }
}

fn check_user_simple(args: &[String], patterns: &[ParsedPattern]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let (program, rest) = skip_wrappers(args);
    let positional: Vec<&str> = rest.iter().filter(|a| !a.starts_with('-')).map(|s| s.as_str()).collect();
    let flags: Vec<&str> = rest.iter().filter(|a| a.starts_with('-')).map(|s| s.as_str()).collect();
    for p in patterns {
        if p.pipe_to_shell { continue; } // handled in pipeline walker
        if program != p.program { continue; }
        // subcommand words must appear in order at the start of positional args.
        if positional.len() < p.subcommand.len() { continue; }
        if !p.subcommand.iter().enumerate().all(|(i, w)| positional[i] == w.as_str()) {
            continue;
        }
        // every required flag must appear (long flag → also accept its short form for known git aliases).
        if p.flags.iter().all(|req| flag_present(&flags, req, &p.program)) {
            return Some(p.id.to_string());
        }
    }
    None
}

fn flag_present(present: &[&str], required: &str, program: &str) -> bool {
    if present.iter().any(|f| *f == required) { return true; }
    // Limited short-form aliases for git push: `--force` ↔ `-f`.
    if program == "git" && required == "--force" && present.iter().any(|f| *f == "-f") {
        return true;
    }
    false
}
```

Re-enable any tests that were `#[ignore]`d in Task 7. Confirm `bash_safe_command_auto_allowed_logged`, `deny_safe_commands`, and the other built-in pattern tests pass.

- [ ] **Step 4: Run tests**

```
cargo test -p verun --lib policy
```

Expected: PASS.

- [ ] **Step 5: Clippy**

```
cargo clippy -p verun -- -D warnings
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/policy.rs
git commit -m "feat(policy): user-configurable Bash deny pattern matcher"
```

---

## Task 9: Plumb `EffectivePolicy` into task.rs (live `ArcSwap`)

**Files:**
- Modify: `src-tauri/src/task.rs`
- Modify: `src-tauri/src/Cargo.toml` (add `arc-swap`)

- [ ] **Step 1: Add `arc-swap` dependency**

In `src-tauri/Cargo.toml` `[dependencies]` add:

```toml
arc-swap = "1"
```

Run:

```
cargo build -p verun --lib
```

Expected: builds, with `arc-swap` available.

- [ ] **Step 2: Write the failing test**

Append to `task::tests` (search for `mod tests` in `task.rs`, or create the block if absent):

```rust
#[tokio::test]
async fn live_policy_swap_changes_decisions_immediately() {
    use crate::auto_safe::{defaults, resolve_effective, WebSearchMode};
    use std::sync::Arc;
    use arc_swap::ArcSwap;

    let mut g = defaults();
    g.websearch.mode = WebSearchMode::Ask;
    let policy = Arc::new(ArcSwap::from_pointee(resolve_effective(&g, None)));

    let load_a = policy.load_full();
    let result = crate::policy::evaluate(
        "WebSearch",
        &serde_json::json!({"query": "x"}),
        "/tmp", "/tmp",
        crate::policy::TrustLevel::AutoSafe,
        &load_a,
    );
    assert_eq!(result.decision, crate::policy::PolicyDecision::RequireApproval);

    g.websearch.mode = WebSearchMode::Allow;
    policy.store(Arc::new(resolve_effective(&g, None)));

    let load_b = policy.load_full();
    let result = crate::policy::evaluate(
        "WebSearch",
        &serde_json::json!({"query": "x"}),
        "/tmp", "/tmp",
        crate::policy::TrustLevel::AutoSafe,
        &load_b,
    );
    assert_eq!(result.decision, crate::policy::PolicyDecision::AutoAllow);
}
```

- [ ] **Step 3: Run, expect PASS**

(This actually tests integration only — `evaluate` already accepts the policy ref.)

```
cargo test -p verun --lib task::tests::live_policy_swap_changes_decisions_immediately
```

Expected: PASS.

- [ ] **Step 4: Add the policy field to `SessionProcess`**

In `src-tauri/src/task.rs`, locate the `SessionProcess` struct (search `pub struct SessionProcess`). Add a field:

```rust
pub auto_safe_policy: std::sync::Arc<arc_swap::ArcSwap<crate::auto_safe::EffectivePolicy>>,
```

Update both spawn paths (Claude and any other agent) to compute and pass this Arc. At the call sites where you currently build `trust_level_atom`, add right next to it:

```rust
let global_policy = crate::db::get_or_seed_global_auto_safe_policy(pool).await?;
let project_override = crate::db::get_project_auto_safe_override(pool, &project_id).await?;
let effective = crate::auto_safe::resolve_effective(&global_policy, project_override.as_ref());
let auto_safe_policy = std::sync::Arc::new(arc_swap::ArcSwap::from_pointee(effective));
```

(Use the actual `pool` and `project_id` available at each call site.)

Where `policy::evaluate(...)` is called inside the stream loop, change the call to pass `&*policy.load_full()` (i.e. load the current snapshot from `auto_safe_policy.clone()` captured into the loop).

- [ ] **Step 5: Update IPC `set_auto_safe_policy` (placeholder)**

Add a public function in `task.rs`:

```rust
/// Live-broadcast a new global policy to every running session whose project
/// either has no override or has an override that depends on the new global.
pub fn broadcast_global_policy_change(
    sessions: &dashmap::DashMap<String, std::sync::Arc<SessionProcess>>,
    pool: &sqlx::SqlitePool,
) {
    // Implemented inline by the IPC layer when policy is updated; left as a
    // hook for ease of testing.
    let _ = (sessions, pool);
}
```

(IPC layer in Task 10 will iterate sessions and call `auto_safe_policy.store(...)` directly. We do not need to refactor the global state here.)

- [ ] **Step 6: Run all backend tests + clippy**

```
cargo test -p verun --lib
cargo clippy -p verun -- -D warnings
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/task.rs
git commit -m "feat(task): hold EffectivePolicy in ArcSwap per session"
```

---

## Task 10: IPC — global auto-safe policy commands

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs` (handler registration)

- [ ] **Step 1: Write the failing test**

Append to `ipc.rs` tests (find `mod tests` near the bottom):

```rust
#[tokio::test]
async fn ipc_get_set_global_auto_safe_policy_round_trip() {
    let (pool, db_tx, _join) = setup_test_runtime().await;
    // get_auto_safe_policy returns defaults on first call.
    let initial = crate::ipc::test_get_auto_safe_policy_inner(&pool).await.unwrap();
    assert_eq!(initial.global, crate::auto_safe::defaults());

    // set
    let mut p = initial.global.clone();
    p.websearch.mode = crate::auto_safe::WebSearchMode::Allow;
    crate::ipc::test_set_auto_safe_policy_inner(&pool, &db_tx, p.clone()).await.unwrap();

    let after = crate::ipc::test_get_auto_safe_policy_inner(&pool).await.unwrap();
    assert_eq!(after.global.websearch.mode, crate::auto_safe::WebSearchMode::Allow);
}
```

(Use `setup_test_runtime` if it exists in this file; otherwise mirror the helper from `db::tests`. The pattern follows the existing IPC tests for trust level.)

- [ ] **Step 2: Run, expect FAIL**

Expected: missing function names.

- [ ] **Step 3: Implement the IPC commands**

Append to `src-tauri/src/ipc.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSafePolicyResponse {
    pub global: crate::auto_safe::GlobalPolicy,
    pub defaults: crate::auto_safe::GlobalPolicy,
}

#[tauri::command]
pub async fn get_auto_safe_policy(
    pool: State<'_, SqlitePool>,
) -> Result<AutoSafePolicyResponse, String> {
    test_get_auto_safe_policy_inner(pool.inner()).await
}

#[tauri::command]
pub async fn set_auto_safe_policy(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    policy: crate::auto_safe::GlobalPolicy,
) -> Result<(), String> {
    test_set_auto_safe_policy_inner(pool.inner(), db_tx.inner(), policy).await
}

// Test-helpers shared between the Tauri command and unit tests.
pub(crate) async fn test_get_auto_safe_policy_inner(
    pool: &SqlitePool,
) -> Result<AutoSafePolicyResponse, String> {
    let global = crate::db::get_or_seed_global_auto_safe_policy(pool).await?;
    Ok(AutoSafePolicyResponse {
        global,
        defaults: crate::auto_safe::defaults(),
    })
}

pub(crate) async fn test_set_auto_safe_policy_inner(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    policy: crate::auto_safe::GlobalPolicy,
) -> Result<(), String> {
    if policy.version != 1 {
        return Err(format!("unsupported policy version {}", policy.version));
    }
    let json = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    db_tx
        .send(crate::db::DbWrite::SetGlobalAutoSafePolicy { json })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    // Live-update every running session whose project doesn't have an override
    // that pins this category. Simplest correct approach: recompute effective
    // for each session based on its own project override + the new global.
    crate::ipc::reapply_policy_to_all_sessions(pool).await?;
    Ok(())
}

pub(crate) async fn reapply_policy_to_all_sessions(pool: &SqlitePool) -> Result<(), String> {
    use std::sync::Arc;
    let global = crate::db::get_or_seed_global_auto_safe_policy(pool).await?;
    let sessions_map = crate::SESSIONS.clone();
    for entry in sessions_map.iter() {
        let session = entry.value();
        let project_id = session.project_id.clone();
        let po = crate::db::get_project_auto_safe_override(pool, &project_id).await?;
        let eff = crate::auto_safe::resolve_effective(&global, po.as_ref());
        session.auto_safe_policy.store(Arc::new(eff));
    }
    Ok(())
}
```

(Adjust the global sessions map reference based on actual code: search `pub static SESSIONS` or `pub static ref SESSIONS` in the project. If sessions live behind a different mechanism, mirror its iteration pattern.)

In `src-tauri/src/lib.rs`, register the commands in `tauri::generate_handler![...]` (line ~256):

```rust
ipc::get_auto_safe_policy,
ipc::set_auto_safe_policy,
```

- [ ] **Step 4: Run tests + clippy**

```
cargo test -p verun --lib ipc
cargo clippy -p verun -- -D warnings
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): get/set global auto-safe policy"
```

---

## Task 11: IPC — project override commands

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Append to `ipc::tests`:

```rust
#[tokio::test]
async fn ipc_project_override_round_trip() {
    let (pool, db_tx, _join) = setup_test_runtime().await;
    crate::db::process_write(&pool, crate::db::DbWrite::InsertProject(crate::db::tests::make_project()))
        .await.unwrap();

    let none = crate::ipc::test_get_project_override_inner(&pool, "p-001").await.unwrap();
    assert!(none.is_none());

    let po = crate::auto_safe::ProjectOverride {
        version: 1,
        websearch: Some(crate::auto_safe::WebSearchConfig { mode: crate::auto_safe::WebSearchMode::Allow }),
        ..Default::default()
    };
    crate::ipc::test_set_project_override_inner(&pool, &db_tx, "p-001".into(), Some(po.clone())).await.unwrap();
    let some = crate::ipc::test_get_project_override_inner(&pool, "p-001").await.unwrap();
    assert_eq!(some, Some(po));

    crate::ipc::test_set_project_override_inner(&pool, &db_tx, "p-001".into(), None).await.unwrap();
    assert!(crate::ipc::test_get_project_override_inner(&pool, "p-001").await.unwrap().is_none());
}
```

- [ ] **Step 2: Run, expect FAIL**.

- [ ] **Step 3: Implement**

Append to `ipc.rs`:

```rust
#[tauri::command]
pub async fn get_project_auto_safe_override(
    pool: State<'_, SqlitePool>,
    project_id: String,
) -> Result<Option<crate::auto_safe::ProjectOverride>, String> {
    test_get_project_override_inner(pool.inner(), &project_id).await
}

#[tauri::command]
pub async fn set_project_auto_safe_override(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    project_id: String,
    override_value: Option<crate::auto_safe::ProjectOverride>,
) -> Result<(), String> {
    test_set_project_override_inner(pool.inner(), db_tx.inner(), project_id, override_value).await
}

pub(crate) async fn test_get_project_override_inner(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Option<crate::auto_safe::ProjectOverride>, String> {
    crate::db::get_project_auto_safe_override(pool, project_id).await
}

pub(crate) async fn test_set_project_override_inner(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    project_id: String,
    override_value: Option<crate::auto_safe::ProjectOverride>,
) -> Result<(), String> {
    if let Some(po) = &override_value {
        if po.version != 1 {
            return Err(format!("unsupported override version {}", po.version));
        }
    }
    let json = match override_value {
        Some(po) => Some(serde_json::to_string(&po).map_err(|e| e.to_string())?),
        None => None,
    };
    db_tx
        .send(crate::db::DbWrite::SetProjectAutoSafeOverride {
            project_id: project_id.clone(),
            json,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    crate::ipc::reapply_policy_to_project_sessions(pool, &project_id).await?;
    Ok(())
}

pub(crate) async fn reapply_policy_to_project_sessions(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<(), String> {
    use std::sync::Arc;
    let global = crate::db::get_or_seed_global_auto_safe_policy(pool).await?;
    let po = crate::db::get_project_auto_safe_override(pool, project_id).await?;
    let eff = crate::auto_safe::resolve_effective(&global, po.as_ref());
    let sessions_map = crate::SESSIONS.clone();
    for entry in sessions_map.iter() {
        let session = entry.value();
        if session.project_id == project_id {
            session.auto_safe_policy.store(Arc::new(eff.clone()));
        }
    }
    Ok(())
}
```

Register in `lib.rs`:

```rust
ipc::get_project_auto_safe_override,
ipc::set_project_auto_safe_override,
```

- [ ] **Step 4: Run tests + clippy + commit**

```
cargo test -p verun --lib ipc
cargo clippy -p verun -- -D warnings
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): get/set project auto-safe override"
```

---

## Task 12: IPC — `parse_bash_pattern` validation command

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Append to `ipc::tests`:

```rust
#[test]
fn ipc_parse_bash_pattern_valid() {
    let r = crate::ipc::parse_bash_pattern_inner("git push --force").unwrap();
    assert_eq!(r.program, "git");
    assert_eq!(r.subcommand, vec!["push".to_string()]);
    assert_eq!(r.flags, vec!["--force".to_string()]);
    assert!(!r.pipe_to_shell);
}

#[test]
fn ipc_parse_bash_pattern_curl_pipe_sh() {
    let r = crate::ipc::parse_bash_pattern_inner("curl | sh").unwrap();
    assert_eq!(r.program, "curl");
    assert!(r.pipe_to_shell);
}

#[test]
fn ipc_parse_bash_pattern_empty_is_error() {
    assert!(crate::ipc::parse_bash_pattern_inner("   ").is_err());
}
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Append to `ipc.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBashPattern {
    pub program: String,
    pub subcommand: Vec<String>,
    pub flags: Vec<String>,
    /// Renamed to `pipeToShell` on the wire (camelCase for TS).
    pub pipe_to_shell: bool,
}

#[tauri::command]
pub fn parse_bash_pattern(text: String) -> Result<ParsedBashPattern, String> {
    parse_bash_pattern_inner(&text)
}

pub(crate) fn parse_bash_pattern_inner(text: &str) -> Result<ParsedBashPattern, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("pattern must not be empty".into());
    }
    if let Some((left, right)) = trimmed.split_once('|') {
        let right = right.trim();
        if matches!(right, "sh" | "bash" | "zsh") {
            let program = left
                .split_whitespace()
                .next()
                .ok_or_else(|| "pipe pattern missing program".to_string())?
                .to_string();
            return Ok(ParsedBashPattern {
                program,
                subcommand: vec![],
                flags: vec![],
                pipe_to_shell: true,
            });
        }
        return Err("only `<program> | sh|bash|zsh` pipe patterns are supported".into());
    }
    let mut tokens = trimmed.split_whitespace();
    let program = tokens.next().unwrap().to_string();
    let mut subcommand = Vec::new();
    let mut flags = Vec::new();
    for tok in tokens {
        if tok.starts_with('-') {
            flags.push(tok.to_string());
        } else {
            subcommand.push(tok.to_string());
        }
    }
    Ok(ParsedBashPattern {
        program,
        subcommand,
        flags,
        pipe_to_shell: false,
    })
}
```

Register in `lib.rs`:

```rust
ipc::parse_bash_pattern,
```

- [ ] **Step 4: Run + commit**

```
cargo test -p verun --lib ipc
cargo clippy -p verun -- -D warnings
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): parse_bash_pattern validation command"
```

---

## Task 13: Extend `.verun.json` import/export with `auto_safe_override`

**Files:**
- Modify: `src-tauri/src/task.rs` (`parse_verun_config_file`)
- Modify: `src-tauri/src/ipc.rs` (`export_project_config`, `import_project_config`)

- [ ] **Step 1: Write the failing tests**

Append to `task::tests`:

```rust
#[test]
fn parse_verun_config_includes_auto_safe_override() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.json");
    std::fs::write(
        &path,
        r#"{
          "hooks": { "setup": "echo s", "destroy": "" },
          "startCommand": "",
          "autoSafeOverride": {
            "version": 1,
            "websearch": { "mode": "allow" }
          }
        }"#,
    ).unwrap();
    let parsed = crate::task::parse_verun_config_extended(path.to_str().unwrap()).unwrap();
    assert_eq!(parsed.setup, "echo s");
    assert!(parsed.auto_safe_override.is_some());
    assert_eq!(
        parsed.auto_safe_override.unwrap().websearch.unwrap().mode,
        crate::auto_safe::WebSearchMode::Allow
    );
}
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement extended parse**

In `src-tauri/src/task.rs`, add (just below the existing `parse_verun_config_file`):

```rust
#[derive(Debug, Clone, Default)]
pub struct ParsedVerunConfig {
    pub setup: String,
    pub destroy: String,
    pub start: String,
    pub auto_safe_override: Option<crate::auto_safe::ProjectOverride>,
}

pub fn parse_verun_config_extended(path: &str) -> Option<ParsedVerunConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;

    let hooks = v.get("hooks");
    let setup = hooks.and_then(|h| h.get("setup")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let destroy = hooks.and_then(|h| h.get("destroy")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let start = v.get("startCommand").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let auto_safe_override: Option<crate::auto_safe::ProjectOverride> =
        v.get("autoSafeOverride").and_then(|node| serde_json::from_value(node.clone()).ok());

    if setup.is_empty() && destroy.is_empty() && start.is_empty() && auto_safe_override.is_none() {
        return None;
    }
    Some(ParsedVerunConfig { setup, destroy, start, auto_safe_override })
}
```

Keep the existing `parse_verun_config_file` as a thin wrapper that calls `parse_verun_config_extended` and ignores `auto_safe_override` (so old call sites continue to work).

```rust
pub fn parse_verun_config_file(path: &str) -> Option<(String, String, String)> {
    parse_verun_config_extended(path).map(|p| (p.setup, p.destroy, p.start))
}
```

- [ ] **Step 4: Update IPC export**

In `src-tauri/src/ipc.rs::export_project_config` (around lines 230-262), include the override in the JSON when present:

```rust
let override_db = db::get_project_auto_safe_override(pool.inner(), &project.id).await?;
let mut config = serde_json::json!({
    "hooks": {
        "setup": &project.setup_hook,
        "destroy": &project.destroy_hook,
    },
    "startCommand": &project.start_command,
});
if let Some(po) = &override_db {
    config["autoSafeOverride"] = serde_json::to_value(po).map_err(|e| e.to_string())?;
}
let pretty = serde_json::to_string_pretty(&config).unwrap_or_default();
```

In `import_project_config` (around lines 274-310), use the extended parser and persist the override:

```rust
let parsed = task::parse_verun_config_extended(&config_path)
    .ok_or_else(|| "No .verun.json found or file is empty".to_string())?;

db_tx.send(db::DbWrite::UpdateProjectHooks {
    id: project_id.clone(),
    setup_hook: parsed.setup.clone(),
    destroy_hook: parsed.destroy.clone(),
    start_command: parsed.start.clone(),
    auto_start: project.auto_start,
}).await.map_err(|e| format!("DB write failed: {e}"))?;

if let Some(po) = parsed.auto_safe_override {
    let json = serde_json::to_string(&po).map_err(|e| e.to_string())?;
    db_tx.send(db::DbWrite::SetProjectAutoSafeOverride {
        project_id: project_id.clone(),
        json: Some(json),
    }).await.map_err(|e| format!("DB write failed: {e}"))?;
    ipc::reapply_policy_to_project_sessions(pool.inner(), &project_id).await?;
}
```

(Mirror the existing return shape — `ImportedHooks` doesn't need to change for this slice.)

- [ ] **Step 5: Run tests + commit**

```
cargo test -p verun --lib
cargo clippy -p verun -- -D warnings
git add src-tauri/src/task.rs src-tauri/src/ipc.rs
git commit -m "feat: include auto_safe_override in .verun.json import/export"
```

---

## Task 14: Frontend types

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add the types**

Append to `src/types/index.ts`:

```ts
// Auto-safe policy
export type ReadScope  = 'repo' | 'any' | 'ask'
export type WriteScope = 'worktree' | 'repo' | 'any' | 'ask'
export type WebSearchMode = 'allow' | 'ask'
export type WebFetchMode  = 'allow' | 'domains' | 'ask'
export type McpMode       = 'allow' | 'servers' | 'ask'

export interface BashPattern {
  id: string
  pattern: string
  builtin?: boolean
}

export interface AutoSafePolicy {
  version: 1
  read:  { scope: ReadScope }
  write: { scope: WriteScope }
  websearch: { mode: WebSearchMode }
  webfetch:  { mode: WebFetchMode, domains: string[] }
  mcp:       { mode: McpMode, servers: string[] }
  bash:      { patterns: BashPattern[] }
}

export interface AutoSafeProjectOverride {
  version: 1
  read?:  { scope: ReadScope }
  write?: { scope: WriteScope }
  websearch?: { mode: WebSearchMode }
  webfetch?:  { mode: WebFetchMode, domains: string[] }
  mcp?:       { mode: McpMode, servers: string[] }
  bash?: { disabledGlobal: string[], extra: BashPattern[] }
}

export interface ParsedBashPattern {
  program: string
  subcommand: string[]
  flags: string[]
  pipeToShell: boolean
}

/**
 * Hard-blocked Bash patterns. Always evaluated regardless of user policy.
 * Surfaced in the UI as locked rows so users know what Verun protects.
 */
export const HARD_BLOCK_PATTERNS: ReadonlyArray<{ id: string, label: string }> = [
  { id: 'worktree-prune',  label: 'git worktree prune' },
  { id: 'worktree-remove', label: 'git worktree remove' },
  { id: 'rm-verun',        label: 'rm .verun/*' },
] as const
```

- [ ] **Step 2: Typecheck**

```
pnpm check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): auto-safe policy + project override types"
```

---

## Task 15: Frontend IPC wrappers

**Files:**
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/ipc.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import * as ipc from './ipc'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('auto-safe IPC wrappers', () => {
  it('getAutoSafePolicy invokes the right command', async () => {
    ;(invoke as any).mockResolvedValueOnce({ global: {}, defaults: {} })
    await ipc.getAutoSafePolicy()
    expect(invoke).toHaveBeenCalledWith('get_auto_safe_policy')
  })
  it('setAutoSafePolicy passes the policy', async () => {
    ;(invoke as any).mockResolvedValueOnce(null)
    const p = { version: 1 } as any
    await ipc.setAutoSafePolicy(p)
    expect(invoke).toHaveBeenCalledWith('set_auto_safe_policy', { policy: p })
  })
  it('setProjectAutoSafeOverride accepts null', async () => {
    ;(invoke as any).mockResolvedValueOnce(null)
    await ipc.setProjectAutoSafeOverride('p-1', null)
    expect(invoke).toHaveBeenCalledWith('set_project_auto_safe_override', {
      projectId: 'p-1',
      overrideValue: null,
    })
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement wrappers**

Append to `src/lib/ipc.ts`:

```ts
import type {
  AutoSafePolicy,
  AutoSafeProjectOverride,
  ParsedBashPattern,
} from '../types'

export interface AutoSafePolicyResponse {
  global: AutoSafePolicy
  defaults: AutoSafePolicy
}

export const getAutoSafePolicy = (): Promise<AutoSafePolicyResponse> =>
  invoke('get_auto_safe_policy')

export const setAutoSafePolicy = (policy: AutoSafePolicy): Promise<void> =>
  invoke('set_auto_safe_policy', { policy })

export const getProjectAutoSafeOverride = (
  projectId: string,
): Promise<AutoSafeProjectOverride | null> =>
  invoke('get_project_auto_safe_override', { projectId })

export const setProjectAutoSafeOverride = (
  projectId: string,
  overrideValue: AutoSafeProjectOverride | null,
): Promise<void> =>
  invoke('set_project_auto_safe_override', { projectId, overrideValue })

export const parseBashPattern = (text: string): Promise<ParsedBashPattern> =>
  invoke('parse_bash_pattern', { text })
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/lib/ipc.test.ts
pnpm check
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(ipc-ts): typed wrappers for auto-safe policy commands"
```

---

## Task 16: Frontend `autoSafe` store

**Files:**
- Create: `src/store/autoSafe.ts`
- Test: `src/store/autoSafe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/store/autoSafe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/ipc', () => ({
  getAutoSafePolicy: vi.fn(),
  setAutoSafePolicy: vi.fn(),
  getProjectAutoSafeOverride: vi.fn(),
  setProjectAutoSafeOverride: vi.fn(),
}))

import * as ipc from '../lib/ipc'
import { autoSafe, hydrateAutoSafe, updateGlobal, updateProjectOverride } from './autoSafe'
import type { AutoSafePolicy } from '../types'

const baseGlobal: AutoSafePolicy = {
  version: 1,
  read: { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch: { mode: 'ask', domains: [] },
  mcp: { mode: 'ask', servers: [] },
  bash: { patterns: [] },
}

describe('autoSafe store', () => {
  beforeEach(() => {
    ;(ipc.getAutoSafePolicy as any).mockResolvedValue({ global: baseGlobal, defaults: baseGlobal })
    ;(ipc.setAutoSafePolicy as any).mockResolvedValue(undefined)
    ;(ipc.setProjectAutoSafeOverride as any).mockResolvedValue(undefined)
  })

  it('hydrate populates global', async () => {
    await hydrateAutoSafe()
    expect(autoSafe.global).toEqual(baseGlobal)
  })

  it('updateGlobal optimistically swaps state', async () => {
    await hydrateAutoSafe()
    await updateGlobal({ ...baseGlobal, websearch: { mode: 'allow' } })
    expect(autoSafe.global.websearch.mode).toBe('allow')
    expect(ipc.setAutoSafePolicy).toHaveBeenCalled()
  })

  it('updateProjectOverride stores per-project override locally', async () => {
    await updateProjectOverride('p-1', {
      version: 1,
      websearch: { mode: 'allow' },
    })
    expect(autoSafe.overrides['p-1']?.websearch?.mode).toBe('allow')
    expect(ipc.setProjectAutoSafeOverride).toHaveBeenCalledWith('p-1', expect.any(Object))
  })

  it('updateProjectOverride with null clears entry', async () => {
    await updateProjectOverride('p-1', { version: 1, websearch: { mode: 'allow' } })
    await updateProjectOverride('p-1', null)
    expect(autoSafe.overrides['p-1']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the store**

Create `src/store/autoSafe.ts`:

```ts
import { createStore, produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'
import type { AutoSafePolicy, AutoSafeProjectOverride } from '../types'

interface AutoSafeState {
  hydrated: boolean
  global: AutoSafePolicy
  defaults: AutoSafePolicy
  overrides: Record<string, AutoSafeProjectOverride>
}

const EMPTY_POLICY: AutoSafePolicy = {
  version: 1,
  read: { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch: { mode: 'ask', domains: [] },
  mcp: { mode: 'ask', servers: [] },
  bash: { patterns: [] },
}

const [autoSafe, setAutoSafe] = createStore<AutoSafeState>({
  hydrated: false,
  global: EMPTY_POLICY,
  defaults: EMPTY_POLICY,
  overrides: {},
})

export { autoSafe }

export async function hydrateAutoSafe() {
  const r = await ipc.getAutoSafePolicy()
  setAutoSafe(produce((s) => {
    s.global = r.global
    s.defaults = r.defaults
    s.hydrated = true
  }))
}

export async function updateGlobal(next: AutoSafePolicy) {
  const previous = autoSafe.global
  setAutoSafe('global', next) // optimistic
  try {
    await ipc.setAutoSafePolicy(next)
  } catch (e) {
    setAutoSafe('global', previous) // rollback
    throw e
  }
}

export async function loadProjectOverride(projectId: string) {
  const v = await ipc.getProjectAutoSafeOverride(projectId)
  setAutoSafe('overrides', produce((o) => {
    if (v) o[projectId] = v
    else delete o[projectId]
  }))
}

export async function updateProjectOverride(
  projectId: string,
  next: AutoSafeProjectOverride | null,
) {
  const previous = autoSafe.overrides[projectId]
  setAutoSafe('overrides', produce((o) => {
    if (next) o[projectId] = next
    else delete o[projectId]
  }))
  try {
    await ipc.setProjectAutoSafeOverride(projectId, next)
  } catch (e) {
    setAutoSafe('overrides', produce((o) => {
      if (previous) o[projectId] = previous
      else delete o[projectId]
    }))
    throw e
  }
}
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/store/autoSafe.test.ts
pnpm check
git add src/store/autoSafe.ts src/store/autoSafe.test.ts
git commit -m "feat(store): autoSafe global + per-project override store"
```

---

## Task 17: Shared `RadioCard` component

**Files:**
- Create: `src/components/RadioCard.tsx`
- Create: `src/components/RadioCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/RadioCard.test.tsx`:

```tsx
import { render, fireEvent } from '@solidjs/testing-library'
import { describe, it, expect, vi } from 'vitest'
import { RadioCard } from './RadioCard'

describe('RadioCard', () => {
  it('renders title, description, and options', () => {
    const { getByText, getByLabelText } = render(() => (
      <RadioCard
        title="Read tools"
        description="Where Claude can read files."
        value="repo"
        options={[
          { value: 'repo', label: 'Anywhere in the repo' },
          { value: 'any',  label: 'Anywhere on disk' },
          { value: 'ask',  label: 'Always ask' },
        ]}
        onChange={() => {}}
      />
    ))
    expect(getByText('Read tools')).toBeTruthy()
    expect(getByText('Where Claude can read files.')).toBeTruthy()
    const repoRadio = getByLabelText('Anywhere in the repo') as HTMLInputElement
    expect(repoRadio.checked).toBe(true)
  })

  it('calls onChange when an option is selected', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(() => (
      <RadioCard
        title="x"
        value="a"
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
        onChange={onChange}
      />
    ))
    fireEvent.click(getByLabelText('B'))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/RadioCard.tsx`:

```tsx
import { For, JSX, Show } from 'solid-js'

export interface RadioCardOption<V extends string> {
  value: V
  label: string
  /** Optional inline child rendered under the option when it is selected. */
  child?: JSX.Element
}

export interface RadioCardProps<V extends string> {
  title: string
  description?: string
  value: V
  options: ReadonlyArray<RadioCardOption<V>>
  onChange: (value: V) => void
}

export function RadioCard<V extends string>(props: RadioCardProps<V>) {
  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
      <h3 class="text-sm font-medium text-text-primary">{props.title}</h3>
      <Show when={props.description}>
        <p class="text-xs text-text-dim mt-1">{props.description}</p>
      </Show>
      <div class="mt-3 flex flex-col gap-2">
        <For each={props.options}>
          {(opt) => (
            <div>
              <label class="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  class="mt-0.5"
                  checked={props.value === opt.value}
                  onChange={() => props.onChange(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
              <Show when={props.value === opt.value && opt.child}>
                <div class="ml-6 mt-2">{opt.child}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/components/RadioCard.test.tsx
pnpm check
git add src/components/RadioCard.tsx src/components/RadioCard.test.tsx
git commit -m "feat(ui): shared RadioCard component"
```

---

## Task 18: Shared `ChipList` component

**Files:**
- Create: `src/components/ChipList.tsx`
- Create: `src/components/ChipList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, fireEvent } from '@solidjs/testing-library'
import { describe, it, expect, vi } from 'vitest'
import { ChipList } from './ChipList'

describe('ChipList', () => {
  it('renders chips and removes them via the × button', () => {
    const onChange = vi.fn()
    const { getByText, getByLabelText } = render(() => (
      <ChipList values={['github.com', 'npmjs.com']} onChange={onChange} placeholder="Add domain" />
    ))
    expect(getByText('github.com')).toBeTruthy()
    fireEvent.click(getByLabelText('Remove github.com'))
    expect(onChange).toHaveBeenCalledWith(['npmjs.com'])
  })

  it('adds a value on Enter and clears the input', () => {
    const onChange = vi.fn()
    const { getByPlaceholderText } = render(() => (
      <ChipList values={[]} onChange={onChange} placeholder="Add" />
    ))
    const input = getByPlaceholderText('Add') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'x.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['x.com'])
  })

  it('rejects duplicates', () => {
    const onChange = vi.fn()
    const { getByPlaceholderText } = render(() => (
      <ChipList values={['a.com']} onChange={onChange} placeholder="Add" />
    ))
    const input = getByPlaceholderText('Add') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'a.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/ChipList.tsx`:

```tsx
import { For, createSignal } from 'solid-js'

export interface ChipListProps {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function ChipList(props: ChipListProps) {
  const [draft, setDraft] = createSignal('')
  const commit = () => {
    const v = draft().trim()
    if (!v) return
    if (props.values.includes(v)) { setDraft(''); return }
    props.onChange([...props.values, v])
    setDraft('')
  }
  const remove = (v: string) => props.onChange(props.values.filter(x => x !== v))
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      <For each={props.values}>
        {(v) => (
          <span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-surface-2 ring-1 ring-border-subtle">
            <span>{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              class="text-text-dim hover:text-text-primary"
              onClick={() => remove(v)}
            >×</button>
          </span>
        )}
      </For>
      <input
        class="bg-transparent text-xs px-2 py-0.5 outline-none border border-transparent focus:border-border-subtle rounded-md"
        placeholder={props.placeholder ?? 'Add'}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        onBlur={commit}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/components/ChipList.test.tsx
pnpm check
git add src/components/ChipList.tsx src/components/ChipList.test.tsx
git commit -m "feat(ui): shared ChipList component"
```

---

## Task 19: `AddPatternForm` component

**Files:**
- Create: `src/components/AddPatternForm.tsx`
- Create: `src/components/AddPatternForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, fireEvent, waitFor } from '@solidjs/testing-library'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/ipc', () => ({ parseBashPattern: vi.fn() }))
import * as ipc from '../lib/ipc'
import { AddPatternForm } from './AddPatternForm'

describe('AddPatternForm', () => {
  beforeEach(() => {
    ;(ipc.parseBashPattern as any).mockResolvedValue({ program: 'sudo', subcommand: [], flags: [], pipeToShell: false })
  })

  it('shows suggestions and inserts on click', () => {
    const onAdd = vi.fn()
    const { getByText } = render(() => (
      <AddPatternForm
        suggestions={[{ id: 'sudo', label: 'sudo' }]}
        onAdd={onAdd}
        onCancel={() => {}}
      />
    ))
    fireEvent.click(getByText('+ sudo'))
    expect(onAdd).toHaveBeenCalledWith({ id: 'sudo', pattern: 'sudo' })
  })

  it('parses and adds a free-form pattern', async () => {
    const onAdd = vi.fn()
    const { getByPlaceholderText, getByText } = render(() => (
      <AddPatternForm suggestions={[]} onAdd={onAdd} onCancel={() => {}} />
    ))
    fireEvent.input(getByPlaceholderText('e.g. npm publish') as HTMLInputElement, {
      target: { value: 'sudo' },
    })
    fireEvent.click(getByText('Add'))
    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    expect(onAdd.mock.calls[0][0].pattern).toBe('sudo')
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/AddPatternForm.tsx`:

```tsx
import { For, Show, createSignal } from 'solid-js'
import { parseBashPattern } from '../lib/ipc'
import type { BashPattern } from '../types'

export interface AddPatternSuggestion {
  id: string
  label: string
}

export interface AddPatternFormProps {
  suggestions: ReadonlyArray<AddPatternSuggestion>
  onAdd: (pattern: BashPattern) => void
  onCancel: () => void
}

function userIdFor(text: string): string {
  return 'user-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function AddPatternForm(props: AddPatternFormProps) {
  const [text, setText] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)

  const submit = async () => {
    const t = text().trim()
    if (!t) { setError('pattern must not be empty'); return }
    try {
      await parseBashPattern(t) // validation only
      props.onAdd({ id: userIdFor(t), pattern: t })
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-3 bg-surface-2">
      <label class="text-xs text-text-dim">Command pattern</label>
      <input
        class="w-full mt-1 bg-transparent ring-1 ring-border-subtle rounded-md px-2 py-1 text-sm outline-none focus:ring-accent/40"
        placeholder="e.g. npm publish"
        value={text()}
        onInput={(e) => { setText(e.currentTarget.value); setError(null) }}
      />
      <p class="mt-1 text-xs text-text-dim">
        Type the command as you would run it. The first word is the program; words starting with - are required flags.
      </p>
      <Show when={error()}>
        <p class="mt-1 text-xs text-danger">{error()}</p>
      </Show>
      <Show when={props.suggestions.length > 0}>
        <p class="mt-2 text-xs text-text-dim">Suggestions:</p>
        <div class="mt-1 flex flex-wrap gap-1">
          <For each={props.suggestions}>
            {(s) => (
              <button
                type="button"
                class="px-2 py-0.5 text-xs ring-1 ring-border-subtle rounded-md hover:bg-surface-3"
                onClick={() => props.onAdd({ id: s.id, pattern: s.label })}
              >+ {s.label}</button>
            )}
          </For>
        </div>
      </Show>
      <div class="mt-3 flex justify-end gap-2">
        <button class="px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md" onClick={props.onCancel}>Cancel</button>
        <button class="px-2.5 py-1 text-xs ring-1 ring-accent/40 bg-accent/10 rounded-md" onClick={submit}>Add</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/components/AddPatternForm.test.tsx
pnpm check
git add src/components/AddPatternForm.tsx src/components/AddPatternForm.test.tsx
git commit -m "feat(ui): AddPatternForm with inline parser validation"
```

---

## Task 20: `BashPatternList` component

**Files:**
- Create: `src/components/BashPatternList.tsx`
- Create: `src/components/BashPatternList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, fireEvent } from '@solidjs/testing-library'
import { describe, it, expect, vi } from 'vitest'
import { BashPatternList } from './BashPatternList'
import { HARD_BLOCK_PATTERNS } from '../types'

describe('BashPatternList (global mode)', () => {
  it('renders locked rows + user-removable rows', () => {
    const { getByText, container } = render(() => (
      <BashPatternList
        mode="global"
        patterns={[
          { id: 'sudo', pattern: 'sudo', builtin: true },
        ]}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onChange={() => {}}
      />
    ))
    expect(getByText('git worktree prune')).toBeTruthy()
    expect(getByText('sudo')).toBeTruthy()
    expect(container.querySelectorAll('[data-locked="true"]').length).toBe(HARD_BLOCK_PATTERNS.length)
  })

  it('removes a non-locked pattern', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(() => (
      <BashPatternList
        mode="global"
        patterns={[{ id: 'sudo', pattern: 'sudo', builtin: true }]}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onChange={onChange}
      />
    ))
    fireEvent.click(getByLabelText('Remove sudo'))
    expect(onChange).toHaveBeenCalledWith([])
  })
})

describe('BashPatternList (project mode)', () => {
  it('toggles a global pattern on/off', () => {
    const onProjectBashChange = vi.fn()
    const { getByLabelText } = render(() => (
      <BashPatternList
        mode="project"
        global={[{ id: 'sudo', pattern: 'sudo', builtin: true }]}
        projectBash={{ disabledGlobal: [], extra: [] }}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onProjectBashChange={onProjectBashChange}
      />
    ))
    fireEvent.click(getByLabelText('Toggle sudo'))
    expect(onProjectBashChange).toHaveBeenCalledWith({ disabledGlobal: ['sudo'], extra: [] })
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/BashPatternList.tsx`:

```tsx
import { For, Show, createSignal } from 'solid-js'
import { Lock } from 'lucide-solid'
import type { BashPattern } from '../types'
import { HARD_BLOCK_PATTERNS } from '../types'
import { AddPatternForm, type AddPatternSuggestion } from './AddPatternForm'

type HardBlocks = ReadonlyArray<{ id: string, label: string }>

export type BashPatternListProps =
  | {
      mode: 'global'
      patterns: BashPattern[]
      hardBlocks?: HardBlocks
      onChange: (next: BashPattern[]) => void
      builtinSuggestions?: ReadonlyArray<AddPatternSuggestion>
    }
  | {
      mode: 'project'
      global: BashPattern[]
      projectBash: { disabledGlobal: string[], extra: BashPattern[] }
      hardBlocks?: HardBlocks
      onProjectBashChange: (next: { disabledGlobal: string[], extra: BashPattern[] }) => void
      builtinSuggestions?: ReadonlyArray<AddPatternSuggestion>
    }

function LockedRow(props: { label: string }) {
  return (
    <div class="flex items-center gap-2 py-1 text-sm" data-locked="true">
      <Lock size={12} class="text-text-dim" />
      <span class="text-text-primary">{props.label}</span>
      <span class="ml-auto text-xs text-text-dim">Worktree protection</span>
    </div>
  )
}

export function BashPatternList(props: BashPatternListProps) {
  const [adding, setAdding] = createSignal(false)
  const hardBlocks = () => props.hardBlocks ?? HARD_BLOCK_PATTERNS

  if (props.mode === 'global') {
    const remove = (id: string) =>
      props.onChange(props.patterns.filter(p => p.id !== id))
    const add = (p: BashPattern) => {
      props.onChange([...props.patterns, p])
      setAdding(false)
    }
    const suggestions = () => (props.builtinSuggestions ?? [])
      .filter(s => !props.patterns.some(p => p.id === s.id))
    return (
      <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
        <h3 class="text-sm font-medium">Bash deny patterns</h3>
        <p class="text-xs text-text-dim mt-1">
          Bash commands matching these patterns will require approval. Everything else is auto-allowed.
        </p>
        <div class="mt-3">
          <For each={hardBlocks()}>{(h) => <LockedRow label={h.label} />}</For>
          <For each={props.patterns}>
            {(p) => (
              <div class="flex items-center gap-2 py-1 text-sm">
                <span class="text-text-primary">{p.pattern}</span>
                <button
                  type="button"
                  aria-label={`Remove ${p.pattern}`}
                  class="ml-auto text-text-dim hover:text-text-primary"
                  onClick={() => remove(p.id)}
                >×</button>
              </div>
            )}
          </For>
        </div>
        <Show when={!adding()} fallback={
          <div class="mt-3"><AddPatternForm
            suggestions={suggestions()}
            onAdd={add}
            onCancel={() => setAdding(false)}
          /></div>
        }>
          <button
            class="mt-3 px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md"
            onClick={() => setAdding(true)}
          >+ Add pattern</button>
        </Show>
      </div>
    )
  }

  // mode === 'project'
  const toggle = (id: string) => {
    const isDisabled = props.projectBash.disabledGlobal.includes(id)
    props.onProjectBashChange({
      ...props.projectBash,
      disabledGlobal: isDisabled
        ? props.projectBash.disabledGlobal.filter(x => x !== id)
        : [...props.projectBash.disabledGlobal, id],
    })
  }
  const removeExtra = (id: string) =>
    props.onProjectBashChange({
      ...props.projectBash,
      extra: props.projectBash.extra.filter(p => p.id !== id),
    })
  const addExtra = (p: BashPattern) => {
    props.onProjectBashChange({
      ...props.projectBash,
      extra: [...props.projectBash.extra, p],
    })
    setAdding(false)
  }
  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
      <h3 class="text-sm font-medium">Bash deny patterns</h3>
      <p class="text-xs text-text-dim mt-1">
        Toggle off a global pattern to allow it in this project. Add project-only patterns at the bottom.
      </p>

      <For each={hardBlocks()}>{(h) => <LockedRow label={h.label} />}</For>

      <p class="mt-3 text-xs text-text-dim">From global config:</p>
      <For each={props.global}>
        {(p) => {
          const disabled = () => props.projectBash.disabledGlobal.includes(p.id)
          return (
            <div class="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                aria-label={`Toggle ${p.pattern}`}
                checked={!disabled()}
                onChange={() => toggle(p.id)}
              />
              <span classList={{ 'text-text-primary': !disabled(), 'text-text-dim line-through': disabled() }}>
                {p.pattern}
              </span>
            </div>
          )
        }}
      </For>

      <p class="mt-3 text-xs text-text-dim">Project-only patterns:</p>
      <For each={props.projectBash.extra}>
        {(p) => (
          <div class="flex items-center gap-2 py-1 text-sm">
            <span class="text-text-primary">{p.pattern}</span>
            <button
              type="button"
              aria-label={`Remove ${p.pattern}`}
              class="ml-auto text-text-dim hover:text-text-primary"
              onClick={() => removeExtra(p.id)}
            >×</button>
          </div>
        )}
      </For>

      <Show when={!adding()} fallback={
        <div class="mt-3"><AddPatternForm
          suggestions={[]}
          onAdd={addExtra}
          onCancel={() => setAdding(false)}
        /></div>
      }>
        <button
          class="mt-3 px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md"
          onClick={() => setAdding(true)}
        >+ Add pattern</button>
      </Show>
    </div>
  )
}
```

- [ ] **Step 4: Run + commit**

```
pnpm test -- src/components/BashPatternList.test.tsx
pnpm check
git add src/components/BashPatternList.tsx src/components/BashPatternList.test.tsx
git commit -m "feat(ui): BashPatternList shared component (global + project modes)"
```

---

## Task 21: `AutoSafeSettings` (global tab) + register tab

**Files:**
- Create: `src/components/AutoSafeSettings.tsx`
- Create: `src/components/AutoSafeSettings.test.tsx`
- Modify: `src/components/SettingsPage.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, fireEvent, waitFor } from '@solidjs/testing-library'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/ipc', () => ({
  getAutoSafePolicy: vi.fn(),
  setAutoSafePolicy: vi.fn(),
}))

import * as ipc from '../lib/ipc'
import { AutoSafeSettings } from './AutoSafeSettings'
import { hydrateAutoSafe } from '../store/autoSafe'
import type { AutoSafePolicy } from '../types'

const base: AutoSafePolicy = {
  version: 1,
  read:  { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch:  { mode: 'ask', domains: [] },
  mcp:       { mode: 'ask', servers: [] },
  bash:      { patterns: [{ id: 'sudo', pattern: 'sudo', builtin: true }] },
}

describe('AutoSafeSettings', () => {
  beforeEach(() => {
    ;(ipc.getAutoSafePolicy as any).mockResolvedValue({ global: base, defaults: base })
    ;(ipc.setAutoSafePolicy as any).mockResolvedValue(undefined)
  })

  it('switching websearch to allow persists via IPC', async () => {
    await hydrateAutoSafe()
    const { getByLabelText } = render(() => <AutoSafeSettings />)
    fireEvent.click(getByLabelText('Auto-allow'))
    await waitFor(() =>
      expect(ipc.setAutoSafePolicy).toHaveBeenCalledWith(expect.objectContaining({
        websearch: { mode: 'allow' },
      }))
    )
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/AutoSafeSettings.tsx`:

```tsx
import { Show } from 'solid-js'
import { autoSafe, updateGlobal } from '../store/autoSafe'
import { RadioCard } from './RadioCard'
import { ChipList } from './ChipList'
import { BashPatternList } from './BashPatternList'
import { HARD_BLOCK_PATTERNS } from '../types'
import type { AutoSafePolicy, BashPattern, ReadScope, WriteScope, WebSearchMode, WebFetchMode, McpMode } from '../types'

const READ_OPTS = [
  { value: 'repo', label: 'Anywhere in the repo' },
  { value: 'any',  label: 'Anywhere on disk' },
  { value: 'ask',  label: 'Always ask' },
] as const
const WRITE_OPTS = [
  { value: 'worktree', label: 'Inside the worktree only' },
  { value: 'repo',     label: 'Anywhere in the repo' },
  { value: 'any',      label: 'Anywhere on disk' },
  { value: 'ask',      label: 'Always ask' },
] as const

export function AutoSafeSettings() {
  const set = (next: Partial<AutoSafePolicy>) => updateGlobal({ ...autoSafe.global, ...next })

  return (
    <Show when={autoSafe.hydrated} fallback={<div class="p-4 text-sm text-text-dim">Loading…</div>}>
      <div class="flex flex-col gap-4 p-4">
        <header>
          <h2 class="text-base font-medium">Auto-safe policy</h2>
          <p class="text-xs text-text-dim">Controls which tool calls Claude can run without asking. Project settings can override these.</p>
        </header>

        <RadioCard<ReadScope>
          title="Read tools"
          description="Read, Glob, Grep, LSP — where Claude is allowed to read files without asking."
          value={autoSafe.global.read.scope}
          options={READ_OPTS as any}
          onChange={(scope) => set({ read: { scope } })}
        />

        <RadioCard<WriteScope>
          title="Write tools"
          description="Edit, Write, NotebookEdit — where Claude is allowed to modify files without asking."
          value={autoSafe.global.write.scope}
          options={WRITE_OPTS as any}
          onChange={(scope) => set({ write: { scope } })}
        />

        <RadioCard<WebSearchMode>
          title="Web search"
          description="WebSearch — searching the web without asking."
          value={autoSafe.global.websearch.mode}
          options={[
            { value: 'allow', label: 'Auto-allow' },
            { value: 'ask',   label: 'Always ask' },
          ]}
          onChange={(mode) => set({ websearch: { mode } })}
        />

        <RadioCard<WebFetchMode>
          title="Web fetch"
          description="WebFetch — fetching URLs without asking."
          value={autoSafe.global.webfetch.mode}
          options={[
            { value: 'allow',   label: 'Auto-allow any URL' },
            {
              value: 'domains',
              label: 'Auto-allow these domains only:',
              child: (
                <ChipList
                  values={autoSafe.global.webfetch.domains}
                  onChange={(domains) => set({ webfetch: { mode: 'domains', domains } })}
                  placeholder="Add domain (e.g. github.com)"
                />
              ),
            },
            { value: 'ask',     label: 'Always ask' },
          ]}
          onChange={(mode) => set({
            webfetch: { mode, domains: autoSafe.global.webfetch.domains },
          })}
        />

        <RadioCard<McpMode>
          title="MCP tools"
          description="Tools provided by MCP servers."
          value={autoSafe.global.mcp.mode}
          options={[
            { value: 'allow',   label: 'Auto-allow any server' },
            {
              value: 'servers',
              label: 'Auto-allow these servers only:',
              child: (
                <ChipList
                  values={autoSafe.global.mcp.servers}
                  onChange={(servers) => set({ mcp: { mode: 'servers', servers } })}
                  placeholder="Add server (e.g. atlassian)"
                />
              ),
            },
            { value: 'ask',     label: 'Always ask' },
          ]}
          onChange={(mode) => set({
            mcp: { mode, servers: autoSafe.global.mcp.servers },
          })}
        />

        <BashPatternList
          mode="global"
          patterns={autoSafe.global.bash.patterns}
          hardBlocks={HARD_BLOCK_PATTERNS}
          builtinSuggestions={autoSafe.defaults.bash.patterns.map(p => ({ id: p.id, label: p.pattern }))}
          onChange={(patterns) => set({ bash: { patterns } })}
        />
      </div>
    </Show>
  )
}
```

- [ ] **Step 4: Register the new tab in SettingsPage**

In `src/components/SettingsPage.tsx`:

1. Add to the `SettingsSection` type (line 28):
   ```ts
   type SettingsSection = 'general' | 'appearance' | 'auto-safe' | string // project id
   ```
2. Import `AutoSafeSettings` and `hydrateAutoSafe`:
   ```ts
   import { AutoSafeSettings } from './AutoSafeSettings'
   import { hydrateAutoSafe } from '../store/autoSafe'
   ```
3. In `selectSettingsSection` and the page body, add a new sidebar button between General and Appearance — copy the existing pattern (around lines 175-192), e.g.:
   ```tsx
   <button
     class={
       'flex items-center gap-2 px-3 py-2 text-sm rounded-md ' +
       (activeSection() === 'auto-safe' ? 'bg-surface-3 text-text-primary' : 'text-text-dim hover:bg-surface-2')
     }
     onClick={() => { setActiveSection('auto-safe'); void hydrateAutoSafe() }}
   >
     <ShieldCheck size={14} /> Auto-safe
   </button>
   ```
   (Use `import { ShieldCheck } from 'lucide-solid'`. Add to the existing `lucide-solid` import.)
4. Update the section title (line 233) to include `'auto-safe'`:
   ```tsx
   {activeSection() === 'general'
     ? 'General'
     : activeSection() === 'appearance'
     ? 'Appearance'
     : activeSection() === 'auto-safe'
     ? 'Auto-safe'
     : selectedProject()?.name ?? 'Settings'}
   ```
5. Render the section:
   ```tsx
   <Show when={activeSection() === 'auto-safe'}>
     <AutoSafeSettings />
   </Show>
   ```
   Place this between the existing General and Appearance `<Show>` blocks.
6. Update the per-project condition that previously checked `activeSection() !== 'general' && activeSection() !== 'appearance'` to also exclude `'auto-safe'`.

- [ ] **Step 5: Run tests + typecheck**

```
pnpm test -- src/components/AutoSafeSettings.test.tsx
pnpm check
```

- [ ] **Step 6: Commit**

```bash
git add src/components/AutoSafeSettings.tsx src/components/AutoSafeSettings.test.tsx src/components/SettingsPage.tsx
git commit -m "feat(ui): Auto-safe settings tab"
```

---

## Task 22: `AutoSafeProjectOverride` + render in project settings

**Files:**
- Create: `src/components/AutoSafeProjectOverride.tsx`
- Create: `src/components/AutoSafeProjectOverride.test.tsx`
- Modify: `src/components/SettingsPage.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, fireEvent, waitFor } from '@solidjs/testing-library'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/ipc', () => ({
  getAutoSafePolicy: vi.fn(),
  setAutoSafePolicy: vi.fn(),
  getProjectAutoSafeOverride: vi.fn(),
  setProjectAutoSafeOverride: vi.fn(),
}))

import * as ipc from '../lib/ipc'
import { AutoSafeProjectOverride } from './AutoSafeProjectOverride'
import { hydrateAutoSafe } from '../store/autoSafe'
import type { AutoSafePolicy } from '../types'

const base: AutoSafePolicy = {
  version: 1,
  read:  { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch:  { mode: 'ask', domains: [] },
  mcp:       { mode: 'ask', servers: [] },
  bash:      { patterns: [{ id: 'sudo', pattern: 'sudo', builtin: true }] },
}

describe('AutoSafeProjectOverride', () => {
  beforeEach(() => {
    ;(ipc.getAutoSafePolicy as any).mockResolvedValue({ global: base, defaults: base })
    ;(ipc.getProjectAutoSafeOverride as any).mockResolvedValue(null)
    ;(ipc.setProjectAutoSafeOverride as any).mockResolvedValue(undefined)
  })

  it('starts on Use global and switches to override on radio click', async () => {
    await hydrateAutoSafe()
    const { getByLabelText } = render(() => <AutoSafeProjectOverride projectId="p-1" />)
    await waitFor(() => {
      const useGlobal = getByLabelText(/Use global setting/) as HTMLInputElement
      expect(useGlobal.checked).toBe(true)
    })
    fireEvent.click(getByLabelText('Anywhere on disk'))
    await waitFor(() =>
      expect(ipc.setProjectAutoSafeOverride).toHaveBeenCalledWith('p-1', expect.objectContaining({
        read: { scope: 'any' },
      }))
    )
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

Create `src/components/AutoSafeProjectOverride.tsx`:

```tsx
import { Show, createEffect } from 'solid-js'
import { autoSafe, loadProjectOverride, updateProjectOverride } from '../store/autoSafe'
import { RadioCard } from './RadioCard'
import { ChipList } from './ChipList'
import { BashPatternList } from './BashPatternList'
import type { AutoSafeProjectOverride as Override, ReadScope, WriteScope, WebSearchMode, WebFetchMode, McpMode } from '../types'

export interface AutoSafeProjectOverrideProps {
  projectId: string
}

type ReadKey = 'global' | ReadScope
type WriteKey = 'global' | WriteScope
type WebSearchKey = 'global' | WebSearchMode
type WebFetchKey = 'global' | WebFetchMode
type McpKey = 'global' | McpMode

export function AutoSafeProjectOverride(props: AutoSafeProjectOverrideProps) {
  createEffect(() => {
    void loadProjectOverride(props.projectId)
  })

  const ov = (): Override | undefined => autoSafe.overrides[props.projectId]
  const merge = async (patch: Partial<Override>) => {
    const next: Override = { version: 1, ...(ov() ?? { version: 1 }), ...patch }
    // Strip keys whose patch value is undefined to keep override sparse.
    for (const k of Object.keys(next) as Array<keyof Override>) {
      if (k !== 'version' && next[k] === undefined) delete next[k]
    }
    const isEmpty = Object.keys(next).filter(k => k !== 'version').length === 0
    await updateProjectOverride(props.projectId, isEmpty ? null : next)
  }

  const readValue: () => ReadKey = () => ov()?.read?.scope ?? 'global'
  const writeValue: () => WriteKey = () => ov()?.write?.scope ?? 'global'
  const websearchValue: () => WebSearchKey = () => ov()?.websearch?.mode ?? 'global'
  const webfetchValue: () => WebFetchKey = () => ov()?.webfetch?.mode ?? 'global'
  const mcpValue: () => McpKey = () => ov()?.mcp?.mode ?? 'global'

  return (
    <Show when={autoSafe.hydrated} fallback={<div class="text-sm text-text-dim">Loading…</div>}>
      <div class="flex flex-col gap-4">
        <header>
          <h3 class="text-sm font-medium">Auto-safe policy override</h3>
          <p class="text-xs text-text-dim">Override global auto-safe settings for this project.</p>
        </header>

        <RadioCard<ReadKey>
          title="Read tools"
          value={readValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.read.scope})` },
            { value: 'repo',   label: 'Anywhere in the repo' },
            { value: 'any',    label: 'Anywhere on disk' },
            { value: 'ask',    label: 'Always ask' },
          ]}
          onChange={(v) => merge({ read: v === 'global' ? undefined : { scope: v } })}
        />

        <RadioCard<WriteKey>
          title="Write tools"
          value={writeValue()}
          options={[
            { value: 'global',   label: `Use global setting (${autoSafe.global.write.scope})` },
            { value: 'worktree', label: 'Inside the worktree only' },
            { value: 'repo',     label: 'Anywhere in the repo' },
            { value: 'any',      label: 'Anywhere on disk' },
            { value: 'ask',      label: 'Always ask' },
          ]}
          onChange={(v) => merge({ write: v === 'global' ? undefined : { scope: v } })}
        />

        <RadioCard<WebSearchKey>
          title="Web search"
          value={websearchValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.websearch.mode})` },
            { value: 'allow',  label: 'Auto-allow' },
            { value: 'ask',    label: 'Always ask' },
          ]}
          onChange={(v) => merge({ websearch: v === 'global' ? undefined : { mode: v } })}
        />

        <RadioCard<WebFetchKey>
          title="Web fetch"
          value={webfetchValue()}
          options={[
            { value: 'global',  label: `Use global setting (${autoSafe.global.webfetch.mode})` },
            { value: 'allow',   label: 'Auto-allow any URL' },
            {
              value: 'domains',
              label: 'Auto-allow these domains only:',
              child: (
                <ChipList
                  values={ov()?.webfetch?.domains ?? []}
                  onChange={(domains) => merge({ webfetch: { mode: 'domains', domains } })}
                  placeholder="Add domain"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) => merge({
            webfetch: v === 'global' ? undefined : { mode: v, domains: ov()?.webfetch?.domains ?? [] },
          })}
        />

        <RadioCard<McpKey>
          title="MCP tools"
          value={mcpValue()}
          options={[
            { value: 'global',  label: `Use global setting (${autoSafe.global.mcp.mode})` },
            { value: 'allow',   label: 'Auto-allow any server' },
            {
              value: 'servers',
              label: 'Auto-allow these servers only:',
              child: (
                <ChipList
                  values={ov()?.mcp?.servers ?? []}
                  onChange={(servers) => merge({ mcp: { mode: 'servers', servers } })}
                  placeholder="Add server"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) => merge({
            mcp: v === 'global' ? undefined : { mode: v, servers: ov()?.mcp?.servers ?? [] },
          })}
        />

        <BashPatternList
          mode="project"
          global={autoSafe.global.bash.patterns}
          projectBash={ov()?.bash ?? { disabledGlobal: [], extra: [] }}
          onProjectBashChange={(bash) => merge({ bash })}
        />
      </div>
    </Show>
  )
}
```

- [ ] **Step 4: Render in SettingsPage per-project body**

In `src/components/SettingsPage.tsx`, find the per-project block (around line 313 — the `Show when={activeSection() !== 'general' && activeSection() !== 'appearance' && selectedProject()}`). After the existing `Start command` block + `<StorageSettings />` (or wherever the existing trailing content lives), append:

```tsx
<Show when={selectedProject()}>
  <div class="mt-6">
    <AutoSafeProjectOverride projectId={selectedProject()!.id} />
  </div>
</Show>
```

Make sure to add `import { AutoSafeProjectOverride } from './AutoSafeProjectOverride'` at the top of the file. Also call `void hydrateAutoSafe()` from the same effect that loads the project's other fields, so the global hint values render correctly.

- [ ] **Step 5: Run tests + typecheck**

```
pnpm test -- src/components/AutoSafeProjectOverride.test.tsx
pnpm check
```

- [ ] **Step 6: Commit**

```bash
git add src/components/AutoSafeProjectOverride.tsx src/components/AutoSafeProjectOverride.test.tsx src/components/SettingsPage.tsx
git commit -m "feat(ui): per-project Auto-safe override section"
```

---

## Task 23: Polish — full check, smoke test, docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md` (only if a relevant item exists; do not invent one)
- Modify: `README.md` (Features list)

- [ ] **Step 1: Run the full health check**

```
make check
```

Expected: green. Fix any clippy / typecheck / test failures inline before proceeding.

- [ ] **Step 2: Manual smoke test**

```
pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications
```

Run through every cell of the verification matrix and tick each one off:

- [ ] Open Settings → Auto-safe tab loads with the seeded defaults visible.
- [ ] Switch Web search to `Auto-allow`, start a fresh task, ask Claude to "search the web for X" — auto-allowed (no approval prompt).
- [ ] Switch Web fetch to `Allowed domains only`, add `github.com`, ask Claude to fetch `https://github.com/foo` — auto-allowed; fetching `https://example.com` requires approval.
- [ ] Add `npm publish` as a Bash deny pattern, run a task that tries `npm publish` — approval prompt.
- [ ] Remove `rsync` from the Bash list globally, observe Claude can run `rsync` without prompting.
- [ ] Open a project's Settings → Auto-safe override section. Switch Read tools to `Anywhere on disk`. Other projects still prompt for outside-repo reads.
- [ ] In a project override, uncheck `sudo` in the Bash list — `sudo` runs in this project but still prompts in others.
- [ ] Quit + relaunch the app. All of the above settings persist.
- [ ] Export `.verun.json` from a project that has overrides — the file contains an `autoSafeOverride` key. Wipe the override in the DB. Import the same `.verun.json` — override comes back.

- [ ] **Step 3: CHANGELOG**

Add a bullet to the `## Unreleased` section in `CHANGELOG.md`:

```
- Configurable auto-safe policy: new global Settings tab and per-project override section let you allow or deny tool categories (read, write, web search, web fetch, MCP) and edit Bash deny patterns. Renamed the `Normal` trust level to `Auto-safe`.
```

- [ ] **Step 4: README**

Update the Features list in `README.md` with one bullet:

```
- Configurable auto-safe policy: tune which tool calls Claude can run without approval, globally or per project.
```

- [ ] **Step 5: ROADMAP**

If `ROADMAP.md` has an existing item matching "configurable policy" or "permissions", check it off (`[X]`) and move under Shipped if appropriate. Otherwise leave the file alone.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md ROADMAP.md
git commit -m "docs: changelog + readme for configurable auto-safe policy"
```

- [ ] **Step 7: Done**

`make check` green, smoke test passes, docs updated. Ship it.

---

## Wire-format conventions (camelCase across the boundary)

The TS interfaces in Task 14 use camelCase (`disabledGlobal`, `pipeToShell`).
The Rust structs that cross the IPC or `.verun.json` boundary must mirror
that. Each task above applies `#[serde(rename_all = "camelCase")]` only where
needed:

- `ProjectOverrideBash` (for `disabled_global` → `disabledGlobal`).
- `ParsedBashPattern` (for `pipe_to_shell` → `pipeToShell`).
- `AutoSafePolicyResponse` (already annotated).

Other structs (`GlobalPolicy`, `ProjectOverride`, `BashPattern`,
`ReadConfig`, `WriteConfig`, `WebSearchConfig`, `WebFetchConfig`, `McpConfig`,
`BashConfig`, `EffectivePolicy`) have only single-word fields, so no rename
attribute is required.
