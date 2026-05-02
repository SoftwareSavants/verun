# Auto-safe Policy Settings

## Summary

Make Verun's auto-safe policy user-configurable. Today the rules in
`src-tauri/src/policy.rs` are hardcoded: read in repo, write in worktree, bash
deny-list, web/MCP require approval. Users have no way to widen the policy
(e.g. auto-allow `WebSearch`) or narrow it (e.g. block `npm publish`). This
spec adds a global "Auto-safe" settings tab plus a per-project override
section; per-project overrides win over globals at evaluation time.

## Goals

- Let the user change the auto-safe policy without rebuilding Verun.
- Provide structured controls per category - no free-form rule textarea.
- Global settings define the baseline; per-project overrides take precedence
  per-category and per-bash-pattern.
- Preserve the worktree-protection hard blocks (cannot be disabled).
- Rename the per-task `TrustLevel::Normal` to `TrustLevel::AutoSafe` (and the
  string value `"normal"` → `"auto_safe"`) for consistency with the new
  settings tab. The other levels (`full_auto`, `supervised`) are unchanged.
  User-configured policy only affects how `AutoSafe` evaluates.

## Non-goals

- Per-session policy tweaks. Policy is global + per-project only.
- Free-form rule patterns (textarea editor). Users get structured controls.
- Tweaking the per-task `TrustLevel` UI. Out of scope.
- Customizing what counts as an "MCP server" - the prefix split (`mcp__<server>__<tool>`) is fixed by the Claude Code MCP convention.
- Allowing user-defined hard blocks. Hard blocks remain a fixed Verun-internal
  list protecting `.verun` and worktree state.

## Current state

`policy.rs::evaluate` decides per tool category:

| Tool category                         | Default decision in `AutoSafe` trust level (was `Normal`)    |
| ------------------------------------- | ------------------------------------------------------------ |
| `Read` / `Glob` / `Grep` / `LSP`      | Auto-allow if path inside repo, else require approval        |
| `Edit` / `Write` / `NotebookEdit`     | Auto-allow if path inside worktree, else require approval    |
| `Bash`                                | Hard-block check, then deny-pattern check, else auto-allow logged |
| `WebSearch` / `WebFetch`              | Require approval                                             |
| `mcp__*`                              | Require approval                                             |
| `Agent`                               | Auto-allow (sub-calls evaluated individually)                |
| `ExitPlanMode`                        | Always require approval                                      |
| Unknown                               | Require approval                                             |

`TrustLevel::FullAuto` overrides everything to auto-allow (after hard blocks).
`TrustLevel::Supervised` overrides everything to require approval.

This spec only changes the `AutoSafe` (formerly `Normal`) path; `FullAuto`
and `Supervised` keep their current behavior (full auto and full approval
respectively).

## UX

### Settings sidebar - new tab

A new top-level "Auto-safe" tab is added to the Settings sidebar, alongside
"General" and "Appearance". Clicking it opens the global policy editor.

Per-project overrides live as a new section "Auto-safe policy override" inside
the existing per-project Settings tab, placed directly after the "Start
command" field.

### Global tab layout

```
┌─────────────────────────────────────────────────────────────┐
│ Auto-safe policy                                            │
│ Controls which tool calls Claude can run without asking.    │
│ Project settings can override these.                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ┌── Read tools ────────────────────────────────────────────┐│
│ │ Read, Glob, Grep, LSP                                    ││
│ │ Where Claude is allowed to read files without asking.    ││
│ │  (●) Anywhere in the repo                                ││
│ │  ( ) Anywhere on disk                                    ││
│ │  ( ) Always ask                                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                             │
│ ┌── Write tools ───────────────────────────────────────────┐│
│ │ Edit, Write, NotebookEdit                                ││
│ │ Where Claude is allowed to modify files without asking.  ││
│ │  (●) Inside the worktree only                            ││
│ │  ( ) Anywhere in the repo                                ││
│ │  ( ) Anywhere on disk                                    ││
│ │  ( ) Always ask                                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                             │
│ ┌── Web search ────────────────────────────────────────────┐│
│ │ WebSearch                                                ││
│ │ Searching the web without asking.                        ││
│ │  ( ) Auto-allow                                          ││
│ │  (●) Always ask                                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                             │
│ ┌── Web fetch ─────────────────────────────────────────────┐│
│ │ WebFetch                                                 ││
│ │ Fetching URLs without asking.                            ││
│ │  ( ) Auto-allow any URL                                  ││
│ │  (●) Auto-allow these domains only:                      ││
│ │       [github.com ×] [docs.anthropic.com ×] [+ Add]      ││
│ │  ( ) Always ask                                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                             │
│ ┌── MCP tools ─────────────────────────────────────────────┐│
│ │ Tools provided by MCP servers                            ││
│ │  ( ) Auto-allow any server                               ││
│ │  (●) Auto-allow these servers only:                      ││
│ │       [atlassian ×] [apollo ×] [+ Add]                   ││
│ │  ( ) Always ask                                          ││
│ └──────────────────────────────────────────────────────────┘│
│                                                             │
│ ┌── Bash deny patterns ────────────────────────────────────┐│
│ │ Bash commands matching these patterns will require       ││
│ │ approval. Everything else is auto-allowed.               ││
│ │  🔒 git worktree prune       Worktree protection         ││
│ │  🔒 git worktree remove      Worktree protection         ││
│ │  🔒 rm .verun/*              Worktree protection         ││
│ │  ─ sudo                                          [×]     ││
│ │  ─ ssh / scp                                     [×]     ││
│ │  ─ rsync                                         [×]     ││
│ │  ─ kill / pkill / killall                        [×]     ││
│ │  ─ chmod / chown                                 [×]     ││
│ │  ─ docker / kubectl                              [×]     ││
│ │  ─ git push --force                              [×]     ││
│ │  ─ git reset --hard                              [×]     ││
│ │  ─ git clean -f                                  [×]     ││
│ │  ─ git checkout -- .                             [×]     ││
│ │  ─ git branch -D                                 [×]     ││
│ │  ─ git stash drop                                [×]     ││
│ │  ─ rm -rf                                        [×]     ││
│ │  ─ curl | sh                                     [×]     ││
│ │                                                          ││
│ │  [+ Add pattern]                                         ││
│ └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Add pattern flow (global)

`[+ Add pattern]` expands inline directly under the Bash card:

```
┌── Add pattern ───────────────────────────────────────────┐
│ Command pattern                                          │
│ [ git push --force                                    ]  │
│                                                          │
│ Type the command as you would run it. The first word     │
│ is the program; words starting with - are required       │
│ flags. Examples: `sudo`, `npm publish`, `rm -rf`.        │
│                                                          │
│ Suggestions (built-ins you removed):                     │
│ [+ sudo] [+ ssh / scp] [+ rsync]                         │
│                                                          │
│           [Cancel]  [Add]                                │
└──────────────────────────────────────────────────────────┘
```

- One free-form input. Tokenized into program → subcommand path → required
  flags using the same shell tokenizer the policy already uses (`yash_syntax`).
- Suggestion chips show built-in patterns currently absent from the user's
  list. Clicking adds without typing.
- Special-case: `curl | sh` is recognized literally; it is the only pipe
  pattern Verun supports.
- No label field - the pattern itself is the display label.

### Per-project override section

Lives at the bottom of the existing per-project Settings page, after "Start
command":

```
┌── Auto-safe policy override ─────────────────────────────────┐
│ Override global auto-safe settings for this project.         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ┌── Read tools ────────────────────────────────────────────┐ │
│ │  (●) Use global setting (Anywhere in the repo)           │ │
│ │  ( ) Anywhere in the repo                                │ │
│ │  ( ) Anywhere on disk                                    │ │
│ │  ( ) Always ask                                          │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌── Write tools ───────────────────────────────────────────┐ │
│ │  (●) Use global setting (Inside the worktree only)       │ │
│ │  ( ) Inside the worktree only                            │ │
│ │  ( ) Anywhere in the repo                                │ │
│ │  ( ) Anywhere on disk                                    │ │
│ │  ( ) Always ask                                          │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ … (Web search, Web fetch, MCP same shape) …                  │
│                                                              │
│ ┌── Bash deny patterns ────────────────────────────────────┐ │
│ │ Toggle off a global pattern to allow it in this project. │ │
│ │ Add project-only patterns at the bottom.                 │ │
│ │                                                          │ │
│ │ From global config:                                      │ │
│ │  🔒 git worktree prune       Always blocked (locked)     │ │
│ │  🔒 git worktree remove      Always blocked (locked)     │ │
│ │  🔒 rm .verun/*              Always blocked (locked)     │ │
│ │  [✓] sudo                                                │ │
│ │  [✓] ssh / scp                                           │ │
│ │  [ ] rsync           ← off: allowed in this project      │ │
│ │  [✓] kill / pkill / killall                              │ │
│ │  …                                                       │ │
│ │                                                          │ │
│ │ Project-only patterns:                                   │ │
│ │  [✓] npm publish                            [×]          │ │
│ │  [+ Add pattern]                                         │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Mechanics:

- **Radio cards** (Read / Write / Web search / Web fetch / MCP): the first
  option is `Use global setting (currently: <X>)`. It is selected by default.
  Selecting any other option detaches the project from global; the project
  uses the chosen value. Selecting the first option again re-attaches and the
  project re-reflects whatever global is at the time of evaluation.
- **WebFetch / MCP chip lists** when the project picks "Auto-allow these
  domains/servers only": the project gets its own chip list, fully editable,
  not derived from global.
- **Bash list**: shows global patterns as a checked list. Locked rows
  (worktree protection) cannot be unchecked. Unchecking a global pattern
  records a project-level "exception" - the pattern still appears denied at
  the global level, but is allowed within this project. Below, a separate
  "Project-only patterns" list lets the project add additive denials that do
  not exist globally. Both lists support `[+ Add pattern]`.
- If the user removes a pattern from the global list later, it disappears
  from both the project's "From global" section and any matching exception
  the project had. Project-only patterns are unaffected.

## Data model

### Storage location

- **Global policy**: stored in SQLite as a single-row JSON blob in a new
  `global_settings` key/value table (one row keyed `auto_safe_policy`). This
  keeps the source of truth in the same place as the rest of the app and lets
  Rust read it synchronously at startup, avoiding localStorage + Tauri
  hopping.
- **Per-project override**: stored as a new TEXT column `auto_safe_override`
  on the existing `projects` table containing sparse JSON. NULL = inherit
  everything.

### Schema migration

A new `db.rs` migration:

```sql
CREATE TABLE IF NOT EXISTS global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE projects ADD COLUMN auto_safe_override TEXT;
```

The migration also seeds `global_settings` with the default policy JSON
(matching today's hardcoded defaults) if no row exists.

### JSON shape

```jsonc
// Global policy (stored at global_settings.auto_safe_policy):
{
  "version": 1,
  "read":  { "scope": "repo" | "any" | "ask" },
  "write": { "scope": "worktree" | "repo" | "any" | "ask" },
  "websearch": { "mode": "allow" | "ask" },
  "webfetch":  { "mode": "allow" | "domains" | "ask", "domains": ["github.com", "docs.anthropic.com"] },
  "mcp":       { "mode": "allow" | "servers"  | "ask", "servers": ["atlassian", "apollo"] },
  "bash": {
    "patterns": [
      { "id": "sudo",             "pattern": "sudo",             "builtin": true },
      { "id": "ssh-scp",          "pattern": "ssh|scp",          "builtin": true },
      { "id": "git-push-force",   "pattern": "git push --force", "builtin": true },
      { "id": "user-npm-publish", "pattern": "npm publish",      "builtin": false }
    ]
  }
}

// Per-project override (stored at projects.auto_safe_override). All keys
// optional; absent keys inherit from global.
{
  "version": 1,
  "read":  { "scope": "any" },              // override
  // "write" omitted -> inherit
  "websearch": { "mode": "allow" },          // override
  // "webfetch" omitted -> inherit
  // "mcp" omitted -> inherit
  "bash": {
    "disabled_global": ["rsync"],            // global pattern ids to disable
    "extra": [
      { "id": "user-npm-publish", "pattern": "npm publish" }
    ]
  }
}
```

Notes:

- Built-in patterns include both Verun-internal hard-blocks (`git worktree
  prune`, `git worktree remove`, `rm .verun/*`) and the optional defaults
  (`sudo`, `ssh|scp`, `git push --force`, etc.). Hard-blocks have `"locked":
  true` and cannot be removed or disabled at any level.
- The `id` is stable per pattern. Built-ins use known ids (`sudo`,
  `git-push-force`, `worktree-prune`, ...) so the per-project disable list is
  stable across global edits and across version upgrades.
- User-added patterns get `id` = `user-<slug>` derived from the pattern text.

## Resolution algorithm

Implemented in `policy.rs`. The evaluator now takes an effective policy
struct, computed once per session by merging global + project overrides:

```rust
pub struct EffectivePolicy {
    pub read:  ReadScope,        // Repo | Any | Ask
    pub write: WriteScope,       // Worktree | Repo | Any | Ask
    pub websearch: WebSearchMode, // Allow | Ask
    pub webfetch:  WebFetchMode,  // Allow | Domains(Vec<String>) | Ask
    pub mcp:       McpMode,       // AllowAll | Servers(Vec<String>) | Ask
    pub bash_patterns: Vec<BashPattern>, // resolved final set
}
```

Per-tool decision (after the existing hard-block check and `TrustLevel`
overrides):

| Tool                            | Decision based on EffectivePolicy                                   |
| ------------------------------- | ------------------------------------------------------------------- |
| `Read` / `Glob` / `Grep` / `LSP` | `Repo` → today's behavior; `Any` → auto-allow; `Ask` → approval     |
| `Edit` / `Write` / `NotebookEdit` | `Worktree` → today's behavior; `Repo` → in-repo allow; `Any` → auto-allow; `Ask` → approval |
| `Bash`                          | Hard blocks (worktree protection) → approval; else if any `bash_patterns` matches → approval; else auto-allow logged |
| `WebSearch`                     | `Allow` → auto-allow; `Ask` → approval                              |
| `WebFetch`                      | `Allow` → auto-allow; `Domains(D)` → auto-allow if the URL host equals or is a sub-domain of any entry in `D` (DNS-label suffix match - `api.github.com` matches `github.com`, `notgithub.com` does not), else approval; `Ask` → approval |
| `mcp__<server>__<tool>`         | `AllowAll` → auto-allow; `Servers(S)` → auto-allow if `<server>` ∈ `S`, else approval; `Ask` → approval |
| `Agent` / `ExitPlanMode` / unknown | Unchanged from today                                            |

Merge rules for computing `EffectivePolicy`:

- Each radio category: project value wins if present and non-null; else
  global value.
- WebFetch domain list / MCP server list: when the project chose `domains` /
  `servers`, the project provides its own list. When it inherits, global
  list applies.
- Bash patterns:
  ```
  effective = (global.patterns - project.disabled_global) ∪ project.extra
  ```
  Locked patterns are never removed regardless of `disabled_global`.

## TrustLevel rename

`TrustLevel::Normal` → `TrustLevel::AutoSafe`. Affects:

- `src-tauri/src/policy.rs`: enum variant, `from_str`, `as_str`, `from_u8`,
  `to_u8` (numeric value `0` stays the same to avoid re-encoding stored
  data), all match arms, all tests.
- `src-tauri/src/db.rs`: schema default `'normal'` → `'auto_safe'`. A new
  migration runs `UPDATE task_trust_levels SET trust_level = 'auto_safe'
  WHERE trust_level = 'normal';` for backwards compatibility with existing
  installs.
- `src-tauri/src/ipc.rs`: `set_trust_level` accepts `auto_safe` (and rejects
  the old `normal` string). The `get_trust_level` endpoint returns the new
  value.
- `src-tauri/src/task.rs`: any string defaults switched to `auto_safe`.
- `src/types/index.ts`: `TrustLevel = 'normal' | ...` → `'auto_safe' | ...`.
- All frontend call sites and UI labels updated. User-facing copy: "Auto-safe"
  replaces "Normal" wherever the trust level is shown.
- `policy_audit_log` rows already store decisions per call, not the trust
  level - no migration needed there.

The numeric encoding in the live `Arc<AtomicU8>` keeps `AutoSafe = 0`,
`FullAuto = 1`, `Supervised = 2`. Only the string serialization changes,
so live sessions across the upgrade keep evaluating correctly.

## Backend changes

### `policy.rs`

- Add the types above (`ReadScope`, `WriteScope`, `WebSearchMode`,
  `WebFetchMode`, `McpMode`, `BashPattern`, `EffectivePolicy`).
- Refactor `evaluate(...)` to take `&EffectivePolicy` instead of relying on
  the hardcoded category logic.
- Replace `matches_deny_pattern` with `matches_any(patterns, command)` that
  walks user-provided patterns plus the locked hard-block set.
- Pattern matching reuses the existing AST walk: parse the user's pattern
  text into `(program, subcommand_path, required_flags)` and check candidate
  commands in the same way the current built-in checks do. The existing
  per-category check functions (`check_git`, `check_rm`, `check_gh`, ...)
  become specializations called when a pattern targets that program; for
  generic patterns (e.g. `npm publish`) a generic matcher walks
  program + positional args + required flags.
- Hard blocks (`matches_hard_block`) stay exactly as today.

### `db.rs`

- Add the new schema migration (above).
- Add `DbWrite` variants: `SetGlobalAutoSafePolicy { json }`,
  `SetProjectAutoSafeOverride { project_id, json | None }`.
- Add reads: `get_global_auto_safe_policy()`, `get_project_auto_safe_override(id)`.

### Effective policy resolution

A new module `src-tauri/src/auto_safe.rs` (kept separate from `policy.rs` to
keep evaluation logic small and testable):

- `pub fn resolve_effective(global: &GlobalPolicy, project: Option<&ProjectOverride>) -> EffectivePolicy`
- `pub fn defaults() -> GlobalPolicy` - the seed values matching today's
  hardcoded behavior.
- Pure functions, easily unit-tested.

### Plumbing

`task.rs` currently passes `worktree_path`, `repo_path`, `trust_level` into
`policy::evaluate`. It now also resolves and passes an
`Arc<EffectivePolicy>`:

- On session start: load global policy + project override, resolve once,
  store on the session struct.
- On policy edits: re-resolve and update the `Arc` for any live session
  whose project is affected (already similar to how `trust_level` is updated
  via `AtomicU8`; here it's an `ArcSwap` of the policy).

## IPC

New typed IPC commands (with TS wrappers in `src/lib/ipc.ts`):

- `get_auto_safe_policy() -> { global: GlobalPolicy, defaults: GlobalPolicy }`
- `set_auto_safe_policy(policy: GlobalPolicy) -> ()`
- `get_project_auto_safe_override(project_id) -> ProjectOverride | null`
- `set_project_auto_safe_override(project_id, override: ProjectOverride | null) -> ()`
- `parse_bash_pattern(text: string) -> { program, subcommand: string[], flags: string[] } | { error }` - lets the UI validate user input live.

`.verun.json` import/export gains an optional `auto_safe_override` key so
project policy can be checked into the repo alongside hooks. (Backwards-
compatible - older `.verun.json` files without the key keep working.)

## Frontend changes

### Types

```ts
export type ReadScope  = 'repo' | 'any' | 'ask'
export type WriteScope = 'worktree' | 'repo' | 'any' | 'ask'
export type WebSearchMode = 'allow' | 'ask'
export type WebFetchMode  = 'allow' | 'domains' | 'ask'
export type McpMode       = 'allow' | 'servers' | 'ask'

export interface BashPattern {
  id: string
  pattern: string
  builtin: boolean
  locked?: boolean
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
  // Each radio category: present = override, absent = inherit from global.
  read?:  { scope: ReadScope }
  write?: { scope: WriteScope }
  websearch?: { mode: WebSearchMode }
  webfetch?:  { mode: WebFetchMode, domains: string[] }
  mcp?:       { mode: McpMode, servers: string[] }
  // bash override is always additive: list of global pattern ids to disable
  // here, plus project-only patterns to deny.
  bash?: { disabled_global: string[], extra: BashPattern[] }
}
```

### Components

- `src/components/AutoSafeSettings.tsx` - the global tab content. Pure
  presentational, drives a `createStore<AutoSafePolicy>`.
- `src/components/AutoSafeProjectOverride.tsx` - the per-project section.
  Receives global as prop so it can render the "(currently: X)" hint and the
  "From global config" Bash list.
- Shared sub-components:
  - `RadioCard` - title, description, list of radio options, optional inline
    chip list when an option needs sub-config.
  - `ChipList` - tag input that validates each entry (domain or server name).
  - `BashPatternList` - shared between global (rows + remove) and project
    (rows + checkbox + project-only sub-list).
  - `AddPatternForm` - inline expansion with one input, suggestion chips,
    Cancel/Add buttons. Calls `parse_bash_pattern` for validation as the
    user types.

### Wiring

- New tab entry in `SettingsPage.tsx` sidebar: `'auto-safe'` (between
  `'general'` and `'appearance'`). New `Show when={activeSection() === 'auto-safe'}` block renders `<AutoSafeSettings />`.
- The per-project tab body adds a new section after the existing "Start
  command" / hooks block, rendering `<AutoSafeProjectOverride project={p} />`.
- A new store module `src/store/autoSafe.ts` owns the policy signal,
  hydrates from IPC on app boot, and exposes `setGlobal()` /
  `setProjectOverride(projectId, ...)` that persist via IPC and emit local
  signal updates immediately.

## Testing

Following the project TDD rule:

- **`policy.rs` unit tests** for every cell of the resolution table:
  - Read scope: `Repo` denies outside-repo Read; `Any` allows it; `Ask`
    denies all.
  - Write scope: `Worktree` denies outside-worktree Write; `Repo` allows
    in-repo, denies outside-repo; `Any` allows; `Ask` denies.
  - WebSearch / WebFetch: each mode, including domain suffix-match
    (`api.github.com` matches `github.com` but not `notgithub.com`).
  - MCP: each mode plus the `mcp__<server>__<tool>` parsing.
  - Bash: locked patterns always block; disabled global patterns no longer
    block; project-extra patterns block; locked patterns ignore
    `disabled_global`.
- **`auto_safe.rs` unit tests** for `resolve_effective`:
  - Each individual override key wins.
  - `null` override means inherit.
  - Disabled global pattern is removed unless locked.
  - Extras are appended.
- **`db.rs` migration test**: existing rows survive the migration; defaults
  are seeded when `auto_safe_policy` row is absent.
- **IPC round-trip tests** in `src/lib/ipc.test.ts` to ensure the typed
  wrappers serialize correctly.
- **Frontend store tests** in `src/store/autoSafe.test.ts` covering
  inheritance: project override edits do not mutate global; toggling a
  global Bash pattern off in the project flips the disabled list correctly.
- **Manual end-to-end** in `pnpm tauri dev`:
  - Allow `WebSearch` globally, observe it auto-allows in a fresh task.
  - Add `npm publish` to global Bash patterns, observe approval prompt
    when Claude tries to run it.
  - Override Read scope to `Any` for one project, observe other projects
    still require approval for outside-repo reads.
  - Disable `rsync` global pattern in one project, observe rsync is
    auto-allowed there but still prompts elsewhere.

## Migration & defaults

- On first run after upgrade, the `global_settings` table is created and
  seeded with `auto_safe_policy` matching today's behavior (Read=`repo`,
  Write=`worktree`, WebSearch=`ask`, WebFetch=`ask`, MCP=`ask`, Bash patterns
  = the current hardcoded set with locked worktree-protection rows).
- Existing projects get `auto_safe_override = NULL` (full inherit). No user-
  visible behavior change until they open the new tab and edit something.
- `.verun.json` files without an `auto_safe_override` key continue to import
  cleanly.

## Risks and mitigations

- **Risk**: a user widens policy globally and gets surprised when a
  destructive command runs without prompting. **Mitigation**: the worktree
  hard-blocks remain non-disable-able; the Bash card copy explicitly says
  "Bash commands matching these patterns will require approval. Everything
  else is auto-allowed."; the locked rows make Verun's own protection
  visible.
- **Risk**: pattern parsing diverges between UI live-validation and Rust
  evaluation. **Mitigation**: parsing lives in Rust; UI calls
  `parse_bash_pattern` IPC for validation rather than re-implementing.
- **Risk**: per-project `Use global` tracks a moving target - global edits
  silently change project behavior. **Mitigation**: project radio shows
  `(currently: <X>)` hint with the live global value, and the Bash list
  re-fetches global on render so the user always sees the current state.

## Out of scope (future work)

- Audit-log UI showing recent auto-allow / require-approval decisions and
  which rule fired. Backend already has `policy_audit_log`; surfacing it is
  separate.
- Per-tool MCP allowlists (currently only per-server). The `mcp__<server>__<tool>`
  split lets us add tool-level rules later without a data-model change.
- Pattern import/export beyond what `.verun.json` already covers.
