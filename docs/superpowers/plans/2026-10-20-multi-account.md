# Multiple Accounts per Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users sign in to several accounts per coding-agent harness, bind each project to one account per harness, and run every session, side call and task shell for that project on the bound account.

**Architecture:** A new `accounts` Rust module owns the model: dir paths, keychain secrets, identity, env patches and a DB-backed service. Each harness describes its account support through new `Agent` trait methods, so no harness branches exist outside `agent/`. Every spawn site asks the service for an `EnvPatch` (vars to remove, vars to set) and applies it, and every Claude path goes through one `ClaudeHome` resolver. The frontend gets an accounts store fed by a snapshot command and an `accounts-changed` event, plus Settings, project, picker and session-tab UI.

**Tech Stack:** Rust (Tauri v2, sqlx SQLite with tauri-plugin-sql migrations, tokio, portable-pty, `keyring` 3.6, `unicode-normalization` 0.1), Solid.js + TypeScript, UnoCSS, vitest + @solidjs/testing-library.

**Spec:** `docs/superpowers/specs/2026-10-20-multi-account-design.md`

## Global Constraints

- Default account = today's behavior: no DB row, no env change, no path change. A user with no added accounts sees no difference.
- An account dir is normalized once at creation (expand `~`, resolve `.` and `..`, strip a trailing slash, never resolve symlinks), stored, and passed byte-identical on every spawn.
- Never override `HOME`.
- Never fall back to another account. A signed-out, removed or missing account fails with an `ACCOUNT_ERROR:` error that the UI turns into a toast with a fix action.
- Secrets live in the OS keychain through `keyring` (service `<bundle identifier>.accounts`, user `<account id>/<KEY>`). Never in SQLite, never in process arguments.
- Verun never writes into a dir the user brought in, except Claude worktree trust (and the onboarding flag written with it) in `<dir>/.claude.json`.
- One login terminal at a time.
- Rust does all file I/O and process work. Every command gets a typed wrapper in `src/lib/ipc.ts`. Events, never polling. `<For>`, not `<Index>`. UnoCSS `ring-1` for container outlines.
- macOS is the verified target. Per-OS `keyring` features keep the Windows and Linux builds compiling without libdbus.
- Main and detached task windows behave the same.
- UI copy uses plain hyphens, never em dashes.
- TDD: each task's tests are written and seen failing before the code changes.

## Review Focus

1. Account dirs with spaces, quotes or non-ASCII (`/Users/me/Client Accounts/o'brien`) must reach the CLI byte-identical in pipe, PTY and login spawns. Tests: Task 2 `normalize_keeps_spaces_and_unicode`, Task 6 `shell_wrap_runs_in_real_sh`.
2. Verun launched from a terminal with `ANTHROPIC_API_KEY` or `CLAUDE_CONFIG_DIR` exported: added-account sessions never see them, Default sessions keep them. Tests: Task 10 `agent_command_applies_account_env`, `agent_command_default_session_env_untouched`.
3. A shell profile that exports `CLAUDE_CONFIG_DIR`: terminal-mode sessions and login terminals still use the account dir. Test: Task 6 `shell_wrap_beats_profile_exports`.
4. A session created over MCP with an initial message starts on the project's account even though its row may not be written yet. Test: Task 7 `new_session_send_params_carry_account`.
5. Worktree paths over 200 characters or behind a symlink: transcript discovery still finds Claude's folder. Tests: Task 8 `encode_cwd_truncates_long_paths_with_hash`, `encode_cwd_resolves_symlinks`.

## File Map

New backend files:
- `src-tauri/src/accounts/mod.rs`: `AccountSelection`, `AccountError`, `account_key`, title-account rule, re-exports
- `src-tauri/src/accounts/paths.rs`: dir normalization and validation
- `src-tauri/src/accounts/secrets.rs`: `SecretStore`, keychain and memory stores
- `src-tauri/src/accounts/identity.rs`: `AccountIdentity`, JWT and JSON helpers
- `src-tauri/src/accounts/env.rs`: `EnvPatch`, account/project/session env, `shell_wrap`
- `src-tauri/src/accounts/service.rs`: DB-backed resolution and usability checks
- `src-tauri/src/accounts/manage.rs`: account CRUD, project binding, snapshot and `Turn::publish` (split out in Task 15's fix round)
- `src-tauri/src/accounts/login.rs`: login and logout terminals
- `src-tauri/src/claude_home.rs`: `ClaudeHome` and the transcript folder slug

New frontend files:
- `src/lib/accounts.ts` (pure helpers), `src/lib/accountErrors.ts`, `src/store/accounts.ts`
- `src/components/AccountsSettings.tsx`, `AccountDialog.tsx`, `AccountTerminalDialog.tsx`, `ProjectAccountsSettings.tsx`, `AccountDot.tsx`

Run Rust tests from `src-tauri/` (`cargo test <module path filter>`), frontend tests from the repo root (`pnpm test <file>`).

---

### Task 1: Schema, account rows and the session account column

**Files:**
- Modify: `src-tauri/src/db.rs` (migrations L298-303, structs L310-388, `DbWrite` L520, `process_write` L783, `DeleteProject` L870, session INSERTs L797 and L1058, tests L2008+)
- Modify: `src-tauri/src/task.rs` (`insert_session_row_tx` L3503-3508, `Session` literals L1291, L3376, L3727)
- Modify: `src-tauri/src/cloud_import.rs:588`, `src-tauri/src/mcp.rs:1957` (Session literals)
- Modify: `src/types/index.ts` (`Session`)

**Interfaces:**
- Produces:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct AccountEnvVar { pub key: String, pub value: Option<String>, pub secret: bool } // secret => value None in DB
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct Account { pub id: String, pub agent_type: String, pub label: String, pub color: String,
    pub config_dir: String, pub managed_dir: bool, pub env: Vec<AccountEnvVar>,
    pub removed_at: Option<i64>, pub created_at: i64 }
#[derive(Debug, Clone, Serialize, FromRow, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct ProjectAccount { pub project_id: String, pub agent_type: String, pub account_id: String }
// Session gains `#[sqlx(default)] pub account_id: Option<String>` (TS: accountId: string | null)
DbWrite::UpsertAccount { account: Account, done: oneshot::Sender<Result<(), String>> }
DbWrite::MarkAccountRemoved { id: String, removed_at: i64, done: oneshot::Sender<Result<(), String>> }
DbWrite::SetProjectAccount { project_id: String, agent_type: String, account_id: Option<String>, done: oneshot::Sender<Result<(), String>> }
pub async fn list_accounts(pool: &SqlitePool) -> Result<Vec<Account>, String>          // by created_at
pub async fn get_account(pool: &SqlitePool, id: &str) -> Result<Option<Account>, String>
pub async fn list_project_accounts(pool: &SqlitePool) -> Result<Vec<ProjectAccount>, String>
pub async fn project_account_ids(pool: &SqlitePool, project_id: &str) -> Result<HashMap<String, String>, String> // agent_type -> account_id
pub async fn projects_using_account(pool: &SqlitePool, account_id: &str) -> Result<Vec<String>, String>         // project names
```

- [ ] **Step 1: Write the failing tests** in the `db.rs` tests module (helpers `test_pool`, `make_project`, `make_task`, `make_session`):
```rust
// migration_versions_are_sequential: assert_eq!(m.len(), 26);
#[tokio::test] async fn account_round_trips_with_env_json()   // env [ANTHROPIC_BASE_URL="https://proxy" plain, ANTHROPIC_API_KEY secret value None]; get_account == upserted
#[tokio::test] async fn upsert_account_replaces_label_color_env()
#[tokio::test] async fn mark_account_removed_sets_removed_at()  // removed_at == Some(1700)
#[tokio::test] async fn set_project_account_inserts_replaces_and_clears() // a1 -> {"claude":"a1"}; a2 -> {"claude":"a2"}; None -> {}
#[tokio::test] async fn projects_using_account_lists_project_names()      // == vec!["My App"]
#[tokio::test] async fn delete_project_removes_project_accounts()
#[tokio::test] async fn session_account_id_persists_on_all_inserts()      // CreateSession and InsertTaskWithSession with Some("a1") read back Some("a1")
// session_serializes_as_camel_case: json["accountId"] == "a1"
```
- [ ] **Step 2: Run** `cargo test db::tests`. Expected: FAIL (does not compile: no `Account`, no `account_id`).
- [ ] **Step 3: Implement.** Append migration v26 (never edit earlier migrations; sqlx checksums them):
```sql
CREATE TABLE accounts (id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, label TEXT NOT NULL, color TEXT NOT NULL,
  config_dir TEXT NOT NULL, managed_dir INTEGER NOT NULL DEFAULT 0, env TEXT NOT NULL DEFAULT '[]',
  removed_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE project_accounts (project_id TEXT NOT NULL, agent_type TEXT NOT NULL, account_id TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_type));
ALTER TABLE sessions ADD COLUMN account_id TEXT;
```
  - Read accounts through a private `AccountRow` (`FromRow`, `env: String`) converted with `serde_json`. `UpsertAccount` is `INSERT ... ON CONFLICT(id) DO UPDATE` of label, color and env only. `SetProjectAccount` with `None` deletes the row. The three writes confirm through `done`, mirroring `InsertTaskWithSession` (L521-526 and its `process_write` arm).
  - `DeleteProject` also deletes the project's `project_accounts` rows (foreign keys are not enforced).
  - Add `account_id` to the three explicit session INSERTs (db.rs:797, db.rs:1058, task.rs:3508).
  - Session literals get `account_id: None`, except the forks (task.rs:3376, 3727), which copy `parent.account_id.clone()`: a fork keeps its source account.
- [ ] **Step 4: Run** `cargo test db::tests`, `cargo check`, `pnpm check`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(accounts): schema for accounts, project bindings and session account`

---

### Task 2: Account dir normalization and validation

**Files:**
- Create: `src-tauri/src/accounts/mod.rs`, `src-tauri/src/accounts/paths.rs`
- Modify: `src-tauri/src/lib.rs` (`mod accounts;`)

**Interfaces:**
- Produces:
```rust
#[derive(Debug, Clone, PartialEq)]
pub enum AccountDirError { Empty, NotAbsolute, StandardHome, Duplicate, Missing, NotADirectory } // impl Display with user-facing copy
pub fn normalize_account_dir(input: &str, user_home: &Path) -> Result<String, AccountDirError>
pub fn validate_account_dir(dir: &str, standard_home: Option<&Path>, taken: &[String], require_existing: bool) -> Result<(), AccountDirError>
pub fn managed_account_dir(app_data_dir: &Path, account_id: &str) -> String // <app data>/accounts/<id>
```

- [ ] **Step 1: Write the failing tests** in `paths.rs`:
```rust
#[test] fn normalize_expands_tilde()               // ("~/.claude-acme", "/Users/me") -> "/Users/me/.claude-acme"
#[test] fn normalize_strips_trailing_slash()       // "/x/home1/" -> "/x/home1"
#[test] fn normalize_resolves_dot_segments()       // "/x/./home1", "/x/home1/../home1", "/x//home1" -> "/x/home1"
#[test] fn normalize_rejects_relative_and_empty()  // "rel/dir" -> NotAbsolute; "  " -> Empty
#[test] fn normalize_keeps_symlinks_unresolved()   // tempdir link -> real: result is the link path string
#[test] fn normalize_keeps_spaces_and_unicode()    // "/Users/me/Client Accounts/o'brien-é" unchanged
#[test] fn validate_rejects_standard_home()        // "/Users/me/.claude" vs Some("/Users/me/.claude") -> StandardHome
#[test] fn validate_rejects_duplicate()            // taken ["/a/b"] -> Duplicate
#[test] fn validate_requires_existing_dir_when_asked() // missing -> Missing; a file -> NotADirectory; a dir -> Ok
#[test] fn managed_dir_is_under_app_data_accounts()    // ("/L/App Support/com.verun", "abc") -> "/L/App Support/com.verun/accounts/abc"
```
- [ ] **Step 2: Run** `cargo test accounts::paths`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** with lexical normalization only (`Path::components`, no `canonicalize`). Only a leading `~` or `~/` expands.
- [ ] **Step 4: Run** `cargo test accounts::paths`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): normalize and validate account dirs`

---

### Task 3: Keychain secret store

**Files:**
- Create: `src-tauri/src/accounts/secrets.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (`.setup()`, next to `app.manage(db_tx)` ~L207)

**Interfaces:**
- Produces:
```rust
pub trait SecretStore: Send + Sync {
    fn get(&self, account_id: &str, key: &str) -> Result<Option<String>, String>;
    fn set(&self, account_id: &str, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account_id: &str, key: &str) -> Result<(), String>; // missing entry is Ok
}
#[derive(Default)] pub struct MemorySecretStore { entries: Mutex<HashMap<(String, String), String>> }
pub struct KeychainSecretStore { service: String } impl KeychainSecretStore { pub fn new(service: String) -> Self }
pub fn keychain_service(bundle_identifier: &str) -> String // "<id>.accounts"
pub fn keychain_user(account_id: &str, key: &str) -> String // "<account id>/<KEY>"
pub struct Secrets(pub Arc<dyn SecretStore>);              // Tauri managed state
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn memory_store_set_get_delete()
#[test] fn memory_store_missing_is_none_and_delete_missing_is_ok()
#[test] fn keychain_user_format()            // ("a1", "ANTHROPIC_API_KEY") -> "a1/ANTHROPIC_API_KEY"
#[test] fn keychain_service_is_per_bundle()  // "com.verun.dev" -> "com.verun.dev.accounts"
#[test] #[ignore] fn keychain_round_trip_real() // manual: set, get, delete against the real keychain
```
- [ ] **Step 2: Run** `cargo test accounts::secrets`. Expected: FAIL.
- [ ] **Step 3: Implement.** Cargo, per OS so Linux needs no libdbus:
```toml
[target.'cfg(target_os = "macos")'.dependencies]   # existing table: add the line
keyring = { version = "3.6", features = ["apple-native"] }
[target.'cfg(target_os = "windows")'.dependencies]
keyring = { version = "3.6", features = ["windows-native"] }
[target.'cfg(target_os = "linux")'.dependencies]
keyring = { version = "3.6", features = ["linux-native"] }
```
  - `KeychainSecretStore` maps `keyring::Error::NoEntry` to `Ok(None)` / `Ok(())`. Callers run it inside `spawn_blocking`.
  - In `.setup()`: `app.manage(accounts::Secrets(Arc::new(KeychainSecretStore::new(keychain_service(&app.config().identifier)))))`. Dev and prod bundle ids keep separate secrets.
- [ ] **Step 4: Run** `cargo test accounts::secrets`, `cargo check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): keychain-backed secret store`

---

### Task 4: Harness account profiles, identity, and Claude support

**Files:**
- Create: `src-tauri/src/accounts/identity.rs`
- Modify: `src-tauri/src/agent/mod.rs` (trait at L397), `src-tauri/src/agent/claude.rs`
- Modify: `src-tauri/src/ipc.rs` (`AgentInfo` L2851, `detect_all_agents` L2783-2807, test sample L3864)
- Modify: `src/types/index.ts` (`AgentInfo`)

**Interfaces:**
- Produces:
```rust
// accounts/identity.rs
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)] #[serde(rename_all = "camelCase")]
pub enum SignInStatus { SignedIn, SignedOut, ApiKey, #[default] Unknown }
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)] #[serde(rename_all = "camelCase")]
pub struct AccountIdentity { pub status: SignInStatus, pub email: Option<String>, pub org_name: Option<String>,
    pub plan: Option<String>, pub providers: Vec<String> }
pub fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> // middle segment, base64url without padding
pub fn read_json_with_retry(path: &Path) -> Option<serde_json::Value> // None if missing; 3 parse attempts 50 ms apart
pub fn with_api_key_overlay(identity: AccountIdentity, profile: &AccountProfile, env: &[AccountEnvVar]) -> AccountIdentity
    // SignedOut/Unknown + env defines one of profile.api_key_vars or profile.required_secret -> ApiKey

// agent/mod.rs
pub struct AccountProfile {
    pub scrub_vars: &'static [&'static str], pub fixed_env: &'static [(&'static str, &'static str)],
    pub api_key_vars: &'static [&'static str],
    pub login_args: Option<&'static [&'static str]>, pub logout_args: Option<&'static [&'static str]>,
    pub login_hint: Option<&'static str>, pub logout_hint: Option<&'static str>,
    pub allows_existing_dir: bool, pub required_secret: Option<&'static str>,
    pub in_project_env: bool, pub min_cli_version: Option<&'static str>,
}
pub enum AccountHome<'a> { Default { user_home: &'a Path }, Dir(&'a Path) }
// new trait methods, all defaulted:
fn account_profile(&self) -> Option<AccountProfile> { None }          // None = no added accounts
fn account_home_env(&self, _dir: &Path) -> Vec<(String, String)> { Vec::new() }
fn account_standard_home(&self, _user_home: &Path) -> Option<PathBuf> { None }
fn prepare_account_dir(&self, dir: &Path) -> std::io::Result<()> { std::fs::create_dir_all(dir) } // managed dirs only
fn read_account_identity(&self, _home: AccountHome<'_>) -> AccountIdentity { AccountIdentity::default() }
fn account_blocked_reason(&self) -> Option<String> { None }

// ipc.rs
#[derive(Debug, Clone, Serialize, PartialEq)] #[serde(rename_all = "camelCase")]
pub struct AccountSupportInfo { pub login: bool, pub logout: bool, pub existing_dir: bool,
    pub required_secret: Option<String>, pub login_hint: Option<String>, pub logout_hint: Option<String>,
    pub min_cli_version: Option<String>, pub blocked_reason: Option<String> }
pub fn account_support_info(agent: &dyn Agent) -> Option<AccountSupportInfo>
// AgentInfo gains `account_support: Option<AccountSupportInfo>`
```
```ts
export interface AccountSupport { login: boolean; logout: boolean; existingDir: boolean; requiredSecret: string | null;
  loginHint: string | null; logoutHint: string | null; minCliVersion: string | null; blockedReason: string | null }
// AgentInfo gains accountSupport: AccountSupport | null
```

- [ ] **Step 1: Write the failing tests:**
```rust
// identity.rs
#[test] fn decode_jwt_payload_reads_middle_segment() // header.<b64url {"email":"a@b.c"}>.sig -> payload["email"] == "a@b.c"
#[test] fn decode_jwt_payload_rejects_garbage()
#[test] fn api_key_overlay_marks_signed_out_account_with_key()
#[test] fn read_json_with_retry_missing_is_none()
// claude.rs
#[test] fn claude_account_profile_values() // scrub == ["CLAUDE_CONFIG_DIR","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"];
                                           // api_key_vars == the last three; login ["auth","login"]; logout ["auth","logout"];
                                           // allows_existing_dir; in_project_env; no required secret
#[test] fn claude_home_env_sets_config_dir_verbatim() // "/x/Client Accounts/acme" -> [("CLAUDE_CONFIG_DIR", same)]
#[test] fn claude_standard_home_is_dot_claude()
#[test] fn claude_identity_reads_oauth_account()      // <dir>/.claude.json oauthAccount {emailAddress:"dev@acme.com", organizationName:"Acme",
                                                      // organizationType:"claude_max"} -> SignedIn, email, org "Acme", plan "Max"
#[test] fn claude_identity_signed_out_without_oauth_account() // "{}" -> SignedOut; missing file -> SignedOut
#[test] fn claude_identity_default_reads_home_claude_json()   // AccountHome::Default { user_home } reads <home>/.claude.json
// ipc.rs
#[test] fn account_support_info_only_for_supporting_harnesses() // Claude -> Some(login true, existing_dir true); Codex -> None
```
- [ ] **Step 2: Run** `cargo test identity` and `cargo test claude_`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Claude identity reads `.claude.json` with `read_json_with_retry`. A Dir home reads `<dir>/.claude.json`. Default reads `$CLAUDE_CONFIG_DIR/.claude.json` when Verun inherited a non-empty value, else `<user_home>/.claude.json`. `organizationType` maps `claude_max` → "Max", `claude_pro` → "Pro", `claude_team` → "Team", `claude_enterprise` → "Enterprise", and anything else is passed through as-is.
  - Fill `account_support` in `detect_all_agents` and in the test sample.
- [ ] **Step 4: Run** `cargo test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): harness account profiles and Claude identity`

---

### Task 5: Env patches and account errors

**Files:**
- Create: `src-tauri/src/accounts/env.rs`
- Modify: `src-tauri/src/accounts/mod.rs`

**Interfaces:**
- Consumes: `Account`, `AccountEnvVar` (Task 1), `SecretStore` (Task 3), `AccountProfile` (Task 4).
- Produces:
```rust
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvPatch { pub remove: Vec<String>, pub set: Vec<(String, String)> }
impl EnvPatch {
    pub fn from_vars(vars: Vec<(String, String)>) -> Self;
    pub fn is_empty(&self) -> bool;
    pub fn merge(&mut self, other: EnvPatch); // other's set wins per key; a key set by other is dropped from remove
    pub fn apply_to_command(&self, cmd: &mut tokio::process::Command);   // env_remove each, then env each
    pub fn apply_to_std_command(&self, cmd: &mut std::process::Command);
}
pub fn account_env(agent: &dyn Agent, account: &Account, secrets: &dyn SecretStore) -> Result<EnvPatch, AccountError>
    // remove = profile.scrub_vars; set = home_env(config_dir) ++ fixed_env ++ account.env (secret values from the store)
pub fn project_env(project_accounts: &[Account], secrets: &dyn SecretStore) -> Result<EnvPatch, AccountError>
    // merges account_env of each account whose profile.in_project_env is true
pub fn session_env(session_agent_type: &str, session_account: Option<&Account>, project_accounts: &[Account],
    secrets: &dyn SecretStore) -> Result<EnvPatch, AccountError>
    // project accounts of OTHER harnesses (in_project_env only), then the session's own account (always included)

// accounts/mod.rs
pub const ACCOUNT_ERROR_PREFIX: &str = "ACCOUNT_ERROR:";
#[derive(Debug, Clone, PartialEq)]
pub enum AccountError { Removed { account_id: String, label: String }, SignedOut { account_id: String, label: String },
    Missing { account_id: String }, WrongHarness { account_id: String },
    Secret { account_id: String, label: String, message: String }, Busy,
    InUse { account_id: String, projects: Vec<String> }, Invalid { message: String } }
impl AccountError { pub fn to_ipc(&self) -> String } // PREFIX + JSON {kind, accountId, label, projects, message}; kind is the camelCase variant name
```

- [ ] **Step 1: Write the failing tests** (Claude accounts only; cross-harness cases arrive in Tasks 23 and 26):
```rust
#[test] fn account_env_scrubs_inherited_auth_vars()      // remove contains "ANTHROPIC_API_KEY" and "CLAUDE_CONFIG_DIR"
#[test] fn account_env_sets_home_then_custom_vars()      // set == [("CLAUDE_CONFIG_DIR","/acc/a1"),("ANTHROPIC_BASE_URL","https://proxy")]
#[test] fn account_env_reads_secret_values_from_store()
#[test] fn account_env_errors_when_secret_missing()      // Err(AccountError::Secret { .. })
#[test] fn default_session_env_is_empty()                // session_env("claude", None, &[], ..) == EnvPatch::default()
#[test] fn session_env_session_account_overrides_project_account()     // project a1, session a2 -> CLAUDE_CONFIG_DIR == a2's dir only
#[test] fn session_env_default_session_drops_project_account_for_same_harness() // project a1, session None -> empty
#[test] fn merge_later_set_wins_and_unremoves()
#[test] fn account_error_to_ipc_is_prefixed_json()       // starts with "ACCOUNT_ERROR:"; kind "signedOut"; accountId "a1"; label "Acme"
```
- [ ] **Step 2: Run** `cargo test accounts::env`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. `account_env` looks the agent up with `AgentKind::parse(&account.agent_type).implementation()` and returns `Invalid` if `account_profile()` is `None`.
- [ ] **Step 4: Run** `cargo test accounts::env`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): env patches for account, project and session`

---

### Task 6: Account env that wins inside login shells

**Files:**
- Modify: `src-tauri/src/accounts/env.rs`
- Modify: `src-tauri/src/claude_terminal.rs:721` (`shell_quote` becomes `pub(crate)`)

**Interfaces:**
- Produces:
```rust
pub const ACCOUNT_SCRIPT_VAR: &str = "VERUN_ACCOUNT_SCRIPT";
pub fn shell_wrap(command: &str, env: &EnvPatch) -> (String, Vec<(String, String)>)
// empty env -> (command unchanged, vec![])
// else -> ("exec /bin/sh -c 'eval \"$VERUN_ACCOUNT_SCRIPT\"'", vec![(ACCOUNT_SCRIPT_VAR, script)])  (ruling: eval keeps values out of argv)
// script = "unset VERUN_ACCOUNT_SCRIPT <remove...>; export K1='v1' K2='v2'; <command>"  (values via shell_quote)
```
The outer string runs under the user's `$SHELL -lic` after their profile has loaded, so the exports win. Values reach the child only through its environment, never its argv. The outer string is plain enough to parse the same way in zsh, bash and fish.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn shell_wrap_is_identity_for_empty_env()
#[test] fn shell_wrap_outer_command_contains_no_values()   // a secret "sk-ant-secret" does not appear in the outer string
#[test] fn shell_wrap_script_unsets_then_exports_then_runs()
// == "unset VERUN_ACCOUNT_SCRIPT ANTHROPIC_API_KEY; export CLAUDE_CONFIG_DIR='/x/Client Accounts/o'\\''brien'; exec claude --model 'opus'"
#[test] fn shell_wrap_runs_in_real_sh()
// std::process::Command::new("/bin/sh").args(["-c", &outer]) with env ANTHROPIC_API_KEY=leak and the script var;
// inner command `printf '%s|%s' "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}"` prints "/x/Client Accounts/o'brien|unset"
#[test] fn shell_wrap_beats_profile_exports()
// same, but run `sh -c "export CLAUDE_CONFIG_DIR=/wrong; <outer>"`: still prints the account dir
```
- [ ] **Step 2: Run** `cargo test shell_wrap`. Expected: FAIL.
- [ ] **Step 3: Implement** `shell_wrap`.
- [ ] **Step 4: Run** `cargo test shell_wrap`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): wrap PTY commands so account env beats the shell profile`

---

### Task 7: Bind an account when a session is created

**Files:**
- Modify: `src-tauri/src/accounts/mod.rs`; Create: `src-tauri/src/accounts/service.rs`
- Modify: `src-tauri/src/task.rs` (`CreateTaskParams` L920, `create_task` L1020, `new_session` L1290, `create_session` L1313, `SendMessageParams` L1381, `SpawnSessionParams` L1963, forwarding at L1766)
- Modify: `src-tauri/src/ipc.rs` (`create_task` L510, `create_session` L800, `send_message` L920, `prewarm_session` L991)
- Modify: `src-tauri/src/wakeup.rs:193`, `src-tauri/src/mcp.rs` (L1303, `perform_spawn_task` L1327-1412, `perform_create_session` L1529-1592)
- Modify: `src/types/index.ts`, `src/lib/ipc.ts` (`createTask` L69, `createSession` L105), `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: `db::project_account_ids`, `db::get_account` (Task 1), `AccountError` (Task 5).
- Produces:
```rust
#[derive(Debug, Clone, Deserialize, PartialEq)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccountSelection { ProjectDefault, Default, Account { id: String } }
pub fn resolve_session_account(selection: Option<&AccountSelection>, agent_type: &str,
    project_accounts: &HashMap<String, String>) -> Option<String>
// service.rs
pub async fn resolve_new_session_account(pool: &SqlitePool, project_id: &str, agent_type: &str,
    selection: Option<&AccountSelection>) -> Result<Option<String>, AccountError> // explicit id must exist, match harness, not be removed
// task.rs
fn new_session(task_id: String, agent_type: String, model: Option<String>, account_id: Option<String>) -> Session
pub async fn create_session(app: &AppHandle, db_tx: &DbWriteTx, task_id: String, agent_type: String,
    model: Option<String>, account_id: Option<String>) -> Result<Session, String>
// CreateTaskParams, SendMessageParams and SpawnSessionParams gain `account_id: Option<String>`
// mcp.rs
fn send_params_for_new_session(task: &Task, session: &Session, repo_path: String, message: String) -> SendMessageParams
// IPC: create_task(.., account: Option<AccountSelection>), create_session(.., account: Option<AccountSelection>)
```
```ts
export type AccountSelection = { kind: 'projectDefault' } | { kind: 'default' } | { kind: 'account'; id: string }
export const createTask = (projectId: string, baseBranch?: string, agentType?: string, directory?: string, account?: AccountSelection) =>
  invoke<TaskWithSession>('create_task', { projectId, baseBranch, agentType, directory, account: account ?? null })
export const createSession = (taskId: string, agentType: string, model?: string, account?: AccountSelection) =>
  invoke<Session>('create_session', { taskId, agentType, model, account: account ?? null })
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn resolve_uses_project_default_when_unspecified()  // (None, "claude", {claude:a1}) -> Some("a1"); ProjectDefault gives the same
#[test] fn resolve_explicit_default_ignores_project_account() // -> None
#[test] fn resolve_explicit_account_wins()                    // Account{a2} -> Some("a2")
#[test] fn resolve_other_harness_binding_not_used()           // ("codex", {claude:a1}) -> None
#[tokio::test] async fn resolve_new_session_account_validates_explicit_id() // codex account for claude -> WrongHarness; removed -> Removed; unknown -> Missing
#[test] fn new_session_send_params_carry_account()            // mcp seam: params.account_id == session.account_id == Some("a1")
```
```ts
it('createSession passes the account selection', ...) // invoke('create_session', { taskId:'t1', agentType:'claude', model:undefined, account:{kind:'account', id:'a1'} })
it('createTask sends account null by default', ...)
```
- [ ] **Step 2: Run** `cargo test resolve_` and `cargo test new_session_send_params`, then `pnpm test src/lib/ipc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The IPC commands and both MCP paths resolve with `resolve_new_session_account`. MCP passes `None`, which means the project default. Errors return `to_ipc()`.
  - Every `SendMessageParams` / `SpawnSessionParams` construction copies `session.account_id`. The MCP paths use the in-memory session through `send_params_for_new_session`, never a DB read: the row may not be written yet.
- [ ] **Step 4: Run** the same commands plus `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): bind sessions to an account at creation`

---

### Task 8: One resolver for Claude paths, with Claude's exact folder slug

**Files:**
- Create: `src-tauri/src/claude_home.rs`
- Modify: `src-tauri/src/claude_jsonl.rs` (remove `session_path`, `projects_dir`, `encode_cwd` at L54-81; move their tests)
- Modify: `src-tauri/src/claude_terminal.rs` (`ValidatedTerminalSession` L283-292 gains `account_id`, L127-138, L706)
- Modify: `src-tauri/src/stream.rs` (`snapshot_turn_best_effort` L1356-1375, `stream_and_capture` L1532-1547)
- Modify: `src-tauri/src/task.rs` (`stream_and_capture` call L2721-2736, forks L3355-3357 and L3711-3713)
- Modify: `src-tauri/src/cloud_import.rs` (L537, L564)
- Modify: `src-tauri/Cargo.toml` (`unicode-normalization = "0.1"`), `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `SpawnSessionParams.account_id` (Task 7).
- Produces:
```rust
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeHome { /* root, config_json, account_home: bool */ }
impl ClaudeHome {
    pub fn default_home(user_home: &Path, inherited_config_dir: Option<&str>) -> Self // root ~/.claude + ~/.claude.json, or the inherited dir; account_home false
    pub fn for_config_dir(dir: &str) -> Self // root dir, config_json <dir>/.claude.json; account_home true
    pub fn root(&self) -> &Path;
    pub fn config_json(&self) -> &Path;
    pub fn is_account_home(&self) -> bool;
    pub fn projects_dir(&self, cwd: &Path) -> PathBuf;              // <root>/projects/<encode_cwd(cwd)>
    pub fn session_path(&self, cwd: &Path, session_id: &str) -> PathBuf;
}
pub fn encode_cwd(cwd: &Path) -> String
pub fn process_default() -> Option<ClaudeHome>                       // HOME plus inherited CLAUDE_CONFIG_DIR
pub async fn for_account(pool: &SqlitePool, account_id: Option<&str>) -> Result<ClaudeHome, String>
// stream_and_capture gains `claude_home: ClaudeHome` (process default for non-Claude sessions)
```
`encode_cwd` mirrors Claude Code 2.1.304:
1. Take `canonicalize(cwd)`, falling back to the raw path, then NFC-normalize it into `s`.
2. Replace every UTF-16 unit of `s` that is not ASCII alphanumeric with `-`.
3. If the result is longer than 200, keep its first 200 units, then append `-` and the hash of `s` (not of the slug): `h = h.wrapping_shl(5).wrapping_sub(h).wrapping_add(unit as i32)` over `s.encode_utf16()`, then `(h as i64).abs()` in lowercase base 36.
4. Keep the existing leading `-` for paths that don't start with `/`.

- [ ] **Step 1: Write the failing tests** (move `encode_cwd_replaces_slashes_and_dots` and `encode_cwd_matches_claude_for_macos_temp_paths_and_spaces` here):
```rust
#[test] fn encode_cwd_truncates_long_paths_with_hash() // "/" + "a"*250 (nonexistent) -> format!("-{}-feo44x", "a".repeat(199))
#[test] fn encode_cwd_counts_utf16_units()             // "/tmp/😀x" -> "-tmp---x"
#[test] fn encode_cwd_nfc_normalizes()                 // "/tmp/e\u{301}" -> "-tmp--"
#[test] fn encode_cwd_resolves_symlinks()              // encode(tempdir link) == encode(canonical real dir)
#[test] fn default_home_uses_dot_claude_and_home_claude_json()
#[test] fn default_home_honors_inherited_config_dir()  // Some("/inh") -> root "/inh", config "/inh/.claude.json", not an account home
#[test] fn for_config_dir_puts_claude_json_inside()    // "/acc/a1" -> "/acc/a1/.claude.json"
#[tokio::test] async fn for_account_reads_account_dir() // None -> process default; Some(id) -> that account's dir
```
- [ ] **Step 2: Run** `cargo test claude_home`. Expected: FAIL.
- [ ] **Step 3: Implement and migrate every caller.**
  - Terminal mode uses `for_account(pool, validated.account_id)`. L706 becomes `projects_dir.join(format!("{new_id}.jsonl"))`.
  - `spawn_session_process` resolves the home from `params.account_id` and passes it to `stream_and_capture`, which hands it to `snapshot_turn_best_effort`.
  - Both forks resolve the parent's account home.
  - Cloud import uses `process_default()` here; Task 14 switches it.
  - Update the comments that still say `~/.claude`: task.rs:3317, agent/mod.rs:474, claude_terminal.rs:8 and 612, claude_transcript_tail.rs:5.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): resolve Claude paths per account and match Claude's folder slug`

---

### Task 9: Trust, read policy and skills follow the account's Claude home

**Files:**
- Modify: `src-tauri/src/claude_terminal.rs` (`pre_trust_worktree` L531-604, call L171)
- Modify: `src-tauri/src/policy.rs` (`evaluate` L100, `is_within_claude_home` L268, `is_path_within` L281-302, tests)
- Modify: `src-tauri/src/stream.rs` (`handle_control_request` L2108-2171)
- Modify: `src-tauri/src/ipc.rs` (`list_agent_skills` L2697), `src-tauri/src/agent/mod.rs` (`discover_skills` doc), `src-tauri/src/agent/claude.rs` (L229-284 and tests)
- Modify: `src/lib/ipc.ts` (L428), `src/store/commands.ts`, `src/store/commands.test.ts`, `src/components/MessageInput.tsx:423-435`, `src/components/GitActions.tsx:184-196`

**Interfaces:**
- Consumes: `ClaudeHome`, `claude_home::for_account` (Task 8).
- Produces:
```rust
pub(crate) async fn pre_trust_worktree(home: &ClaudeHome, worktree_path: &str) -> Result<(), String>
fn pre_trust_worktree_at(config_path: &Path, worktree_path: &str, mark_onboarding: bool) -> Result<(), String>
    // mark_onboarding: also set top-level hasCompletedOnboarding = true if absent; true only for account homes
pub fn evaluate(tool_name: &str, tool_input: &serde_json::Value, worktree_path: &str, repo_path: &str,
    trust_level: TrustLevel, claude_home: &Path) -> PolicyResult
fn discover_skills(&self, scan_root: Option<&Path>, agent_home: &Path) -> Vec<AgentSkill>
    // agent_home = the harness config root (Claude: ~/.claude or the account dir)
// IPC list_agent_skills(agent_kind: String, scan_root: Option<String>, account_id: Option<String>)
```
```ts
export const listAgentSkills = (agentKind: AgentType, scanRoot?: string, accountId?: string | null) =>
  invoke<AgentSkill[]>('list_agent_skills', { agentKind, scanRoot: scanRoot ?? null, accountId: accountId ?? null })
// SkillContext gains accountId?: string | null; cache keys `${agent}|${accountId ?? 'default'}|${projectRoot}` and `${taskId}|${agent}|${accountId ?? 'default'}`
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[tokio::test] async fn pre_trust_writes_inside_account_dir()     // for_config_dir(tmp/acc): tmp/acc/.claude.json has trust and hasCompletedOnboarding; tmp/.claude.json untouched
#[tokio::test] async fn pre_trust_default_home_leaves_onboarding_alone()
#[test] fn read_in_claude_home_auto_allowed()       // rewritten: claude_home "/tmp/claude-home", Read "/tmp/claude-home/settings.json" -> Allow (no real HOME)
#[test] fn read_in_sibling_account_dir_not_auto_allowed() // claude_home "/tmp/acc/a1", Read "/tmp/acc/a1x/secret" -> not allowed by the home rule
#[test] fn discover_skills_reads_account_dir_layout()     // agent_home tmp/acc with skills/x/SKILL.md (no .claude level) -> finds "x"
```
```ts
it('skills cache is keyed by account', ...) // two contexts differing only in accountId -> listAgentSkills called twice, with 'a1' and null
```
- [ ] **Step 2: Run** `cargo test pre_trust`, `cargo test policy`, `cargo test discover_skills`, `pnpm test src/store/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Update every existing `evaluate` test call with a `Path::new(CLAUDE_HOME)` argument, `const CLAUDE_HOME: &str = "/tmp/claude-home"`.
  - `stream_and_capture` passes `claude_home.root()` to the policy check.
  - `is_path_within`'s string fallback becomes component-wise `Path::starts_with`. That fixes the sibling bug where `~/.claude` matched `~/.claude-x`.
  - Claude's `discover_skills` scans `<agent_home>/skills`, `<agent_home>/commands` and `<agent_home>/plugins/installed_plugins.json`; existing tests pass `home.join(".claude")`.
  - The terminal-mode call passes the session's `ClaudeHome`.
- [ ] **Step 4: Run** the same commands plus `cargo test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): trust, read policy and skills use the account's Claude home`

---

### Task 10: Chat sessions spawn on their account

**Files:**
- Modify: `src-tauri/src/accounts/service.rs`
- Modify: `src-tauri/src/task.rs` (`spawn_rpc_session` env block L2046-2056, `spawn_session_process` env block L2565-2577)

**Interfaces:**
- Consumes: `session_env`, `EnvPatch` (Task 5), `read_account_identity`, `with_api_key_overlay` (Task 4), `Secrets` (Task 3).
- Produces:
```rust
pub async fn load_project_accounts(pool: &SqlitePool, project_id: &str) -> Result<Vec<Account>, AccountError>
pub fn check_usable(account: &Account, agent: &dyn Agent) -> Result<(), AccountError>
    // removed -> Removed; identity (with api-key overlay) SignedOut -> SignedOut; Unknown/ApiKey/SignedIn -> Ok
pub async fn session_env_for(pool: &SqlitePool, secrets: &dyn SecretStore, project_id: &str, agent_type: &str,
    account_id: Option<&str>) -> Result<EnvPatch, AccountError> // Missing if the id is unknown; identity read in spawn_blocking
pub async fn project_env_for(pool: &SqlitePool, secrets: &dyn SecretStore, project_id: &str) -> Result<EnvPatch, AccountError>
// task.rs: one builder replaces both duplicated env blocks
pub(crate) fn build_agent_command(binary: &str, args: &[String], worktree_path: &str,
    verun_vars: Vec<(String, String)>, account_env: &EnvPatch) -> tokio::process::Command
    // verun vars, account env, env_remove("CLAUDECODE"), CLAUDE_CODE_ENTRYPOINT=verun, piped stdio, cwd
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[tokio::test] async fn session_env_for_default_is_empty()
#[tokio::test] async fn session_env_for_signed_out_account_errors()   // dir .claude.json "{}" -> SignedOut { label: "Acme" }
#[tokio::test] async fn session_env_for_api_key_account_is_usable()   // secret ANTHROPIC_API_KEY stored -> Ok, set contains it
#[tokio::test] async fn session_env_for_removed_or_missing_account_errors()
#[test] fn agent_command_applies_account_env() // get_envs: CLAUDE_CONFIG_DIR=Some("/acc/a1"), ANTHROPIC_API_KEY=None (removed),
                                               // CLAUDECODE=None, CLAUDE_CODE_ENTRYPOINT=Some("verun"), VERUN_PORT_0 present
#[test] fn agent_command_default_session_env_untouched() // empty patch: ANTHROPIC_API_KEY absent from get_envs
```
- [ ] **Step 2: Run** `cargo test session_env_for` and `cargo test agent_command`. Expected: FAIL.
- [ ] **Step 3: Implement.** Both spawn paths get the pool and secrets with `app.state::<SqlitePool>()` / `app.state::<accounts::Secrets>()`. They call `session_env_for(params.project_id, params.agent_type, params.account_id)` and return `Err(e.to_ipc())` on failure, then build through `build_agent_command`. Live processes keep their spawn-time env, so the fast paths don't change.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): chat sessions spawn with their account env`

---

### Task 11: Project env for task shells, hooks and the start command

**Files:**
- Modify: `src-tauri/src/pty.rs` (`spawn_pty` L150-230), `src-tauri/src/accounts/env.rs`
- Modify: `src-tauri/src/worktree.rs` (`run_hook` L157-178 and its tests)
- Modify: `src-tauri/src/ipc.rs` (`pty_spawn` L2424-2453; `run_hook` L572-595; hook callers L246, L485, L660, L691, L756, L854)
- Modify: `src-tauri/src/task.rs` (`spawn_hook_pty` L640-666, `spawn_setup_hook` L778-793, `create_task` L1057, `delete_task` L1137-1140, `archive_task` L1257-1264)
- Modify: `src-tauri/src/mcp.rs` (`perform_app_start` L1428-1469), `src-tauri/src/claude_terminal.rs:120-176`, `src-tauri/src/cloud_import.rs:452-460`

**Interfaces:**
- Consumes: `project_env_for` (Task 10).
- Produces:
```rust
impl EnvPatch { pub fn apply_to_pty(&self, c: &mut portable_pty::CommandBuilder) } // env_remove each, then env each
pub fn spawn_pty(app: AppHandle, map: ActivePtyMap, task_id: String, cwd: String, rows: u16, cols: u16,
    initial_command: Option<String>, env: EnvPatch, direct_command: bool, name_override: Option<String>,
    is_start_command: bool, hook_type: Option<String>) -> Result<SpawnResult, String> // `env_vars` param replaced
pub fn run_hook(cwd: &str, command: &str, env: &EnvPatch) -> Result<(), String>
// spawn_setup_hook / spawn_hook_pty gain `project_env: EnvPatch`; delete_task / archive_task gain `project_env: &EnvPatch`
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn env_patch_applies_to_pty_builder() // CommandBuilder::new("sh"); remove HOME, set FOO=bar -> get_env("HOME") None, get_env("FOO") Some("bar")
#[test] fn run_hook_applies_env_patch()       // remove HOME, set FOO=bar; hook `printf '%s|%s' "${HOME-unset}" "$FOO" > out` -> "unset|bar"
#[tokio::test] async fn project_env_for_project_without_accounts_is_empty()
#[tokio::test] async fn project_env_for_includes_bound_claude_account()
```
- [ ] **Step 2: Run** `cargo test env_patch_applies`, `cargo test run_hook`, `cargo test project_env_for`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each caller builds `EnvPatch::from_vars(verun_env_vars(..))` and merges `project_env_for(task.project_id)`.
  - Shells, setup hooks, manual hook runs and the start command return the account error.
  - Destroy hooks run during delete and archive are the one exception: they log a warning and run with the Verun vars only, so a keychain failure can never block deleting a task.
  - Terminal mode and the cloud teleport keep their current env for now (Tasks 12 and 14).
  - Update the `run_hook` tests to the new signature.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): task shells, hooks and start command use the project's accounts`

---

### Task 12: Claude terminal mode on the session's account

**Files:**
- Modify: `src-tauri/src/claude_terminal.rs` (`open_claude_terminal` L90-192, `validate_session_for_terminal` L298-322, tests)

**Interfaces:**
- Consumes: `session_env_for` (Task 10), `shell_wrap` (Task 6), `pre_trust_worktree(home, ..)` (Task 9).
- Produces:
```rust
fn terminal_command_and_env(base_cmd: String, verun_vars: Vec<(String, String)>, account_env: &EnvPatch) -> (String, EnvPatch)
// empty account env -> (base_cmd, verun vars) exactly as today
// else -> (shell_wrap outer string, verun vars + VERUN_ACCOUNT_SCRIPT); the scrub list travels inside the script
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn terminal_command_unchanged_for_default()  // "exec claude --resume 'r1'" stays byte-identical
#[test] fn terminal_command_wraps_for_account()      // outer == "exec /bin/sh -c 'eval \"$VERUN_ACCOUNT_SCRIPT\"'"; script exports CLAUDE_CONFIG_DIR
#[tokio::test] async fn validate_session_for_terminal_returns_account_id()
```
- [ ] **Step 2: Run** `cargo test terminal_command` and `cargo test validate_session_for_terminal`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `open_claude_terminal` resolves the session env with `session_env_for(task.project_id, "claude", validated.account_id)` and returns `to_ipc()` errors.
  - Wrap after the `--settings` suffix is appended (L157-162), so the whole command runs inside the script.
  - Pass the session's `ClaudeHome` to `pre_trust_worktree`.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Claude terminal mode runs on the session's account`

---

### Task 13: Title naming never leaks to another login

**Files:**
- Modify: `src-tauri/src/accounts/mod.rs`, `src-tauri/src/accounts/service.rs`
- Modify: `src-tauri/src/task.rs` (`generate_session_title` L3229-3257, `spawn_session_title_generation` L1860-1890 and its three callers L1567, L1646, L1734, `name_terminal_task` L3212-3225)

**Interfaces:**
- Produces:
```rust
#[derive(Debug, Clone, PartialEq)]
pub enum TitleAccount { Use(Option<String>), Skip } // Use(None) = the Default Claude login
pub fn title_account(session_agent_type: &str, session_account_id: Option<&str>, project_claude_account_id: Option<&str>) -> TitleAccount
    // Claude session -> Use(session account)
    // non-Claude on Default -> Use(project Claude binding)
    // non-Claude on an added account -> Use(project Claude account) only if it is Some, else Skip
pub async fn title_env_for(pool: &SqlitePool, secrets: &dyn SecretStore, title: &TitleAccount) -> Option<EnvPatch>
    // Use(None) -> Some(empty); Use(Some(id)) -> account_env of that Claude account, None on any error; Skip -> None
pub fn fallback_title(message: &str) -> Option<String>
    // first non-empty line, whitespace collapsed, cut at a word boundary to at most 50 chars plus "…"; None if empty
async fn generate_session_title(first_message: &str, worktree_path: &str, env: &EnvPatch) -> Option<String>
// spawn_session_title_generation gains project_id, agent_type, account_id
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn title_account_claude_session_uses_its_account()
#[test] fn title_account_default_non_claude_uses_project_claude()
#[test] fn title_account_added_non_claude_uses_added_project_claude()
#[test] fn title_account_added_non_claude_without_added_claude_skips()
#[test] fn fallback_title_cuts_at_word_boundary()
// "Refactor the authentication middleware so that tokens refresh before expiry" -> "Refactor the authentication middleware so that…"
#[test] fn fallback_title_uses_first_line_and_none_when_empty()
```
- [ ] **Step 2: Run** `cargo test title_account` and `cargo test fallback_title`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - When `title_env_for` returns `None`, write `fallback_title(message)` through the existing `UpdateSessionName` / `UpdateTaskName` path instead of calling the model.
  - `name_terminal_task` uses the session's own account (terminal sessions are always Claude).
  - Keep the `title_generation_args_*` tests passing.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): title naming follows the session's account or falls back to a plain title`

---

### Task 14: Cloud import on the project's Claude account

**Files:**
- Modify: `src-tauri/src/cloud_import.rs` (`CloudImport` L19-27, `availability` L265, `auth_status` L282-296, `begin` L388-469, `finish` L500-606)
- Modify: `src-tauri/src/ipc.rs` (`claude_cloud_availability` L419, `begin_cloud_import` L425)
- Modify: `src/lib/ipc.ts` (`claudeCloudAvailability`), `src/components/NewTaskView.tsx:42`, `src/components/NewTaskView.cloud.test.tsx`

**Interfaces:**
- Produces:
```rust
fn auth_status_command(env: &EnvPatch) -> tokio::process::Command // cli_binary(), ["auth","status"], remove CLAUDECODE, env applied
pub async fn availability(env: &EnvPatch) -> Availability
// CloudImport gains `claude_home: ClaudeHome` and `account_id: Option<String>`; the IPC takes project_id
```
```ts
export const claudeCloudAvailability = (projectId: string) =>
  invoke<{ available: boolean; reason: string | null }>('claude_cloud_availability', { projectId })
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn auth_status_command_applies_account_env() // get_envs has CLAUDE_CONFIG_DIR="/acc/a1", ANTHROPIC_API_KEY=None
```
```ts
it('checks cloud availability for the selected project', ...) // claudeCloudAvailability called with 'p1'
```
- [ ] **Step 2: Run** `cargo test auth_status_command` and `pnpm test src/components/NewTaskView.cloud.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `begin` resolves the project's `"claude"` binding. It builds the env with `session_env_for(project.id, "claude", binding)` and resolves `claude_home::for_account(binding)`, then stores both on `CloudImport`.
  - The teleport PTY runs `shell_wrap("exec claude --safe-mode --teleport", &env)`.
  - `finish` uses the stored home for its transcript paths and sets `session.account_id = binding`.
- [ ] **Step 4: Run** `cargo test`, `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): cloud import runs on the project's Claude account`

---

### Task 15: Account service and IPC commands

**Files:**
- Modify: `src-tauri/src/accounts/service.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs` (`generate_handler!` L330-516)
- Modify: `src/types/index.ts`, `src/lib/ipc.ts`, `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct AccountView { #[serde(flatten)] pub account: Account, pub identity: AccountIdentity }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct DefaultAccountView { pub agent_type: String, pub identity: AccountIdentity }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct AccountsSnapshot { pub accounts: Vec<AccountView>,
    pub defaults: Vec<DefaultAccountView>, pub project_accounts: Vec<ProjectAccount> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct AccountEnvInput { pub key: String, pub value: Option<String>, pub secret: bool }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct NewAccountInput { pub agent_type: String, pub label: String,
    pub color: String, pub existing_dir: Option<String>, pub env: Vec<AccountEnvInput> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct UpdateAccountInput { pub id: String, pub label: String,
    pub color: String, pub env: Vec<AccountEnvInput> }
pub fn validate_env_key(key: &str) -> bool // ^[A-Za-z_][A-Za-z0-9_]*$
pub async fn snapshot(pool: &SqlitePool, user_home: &Path) -> Result<AccountsSnapshot, String>
pub async fn create_account(pool: &SqlitePool, db_tx: &DbWriteTx, secrets: &dyn SecretStore, app_data_dir: &Path,
    user_home: &Path, input: NewAccountInput, id: String, now: i64) -> Result<Account, AccountError>
pub async fn update_account(pool: &SqlitePool, db_tx: &DbWriteTx, secrets: &dyn SecretStore, input: UpdateAccountInput) -> Result<Account, AccountError>
pub async fn remove_account(pool: &SqlitePool, db_tx: &DbWriteTx, secrets: &dyn SecretStore, account_id: &str,
    delete_dir: bool, now: i64) -> Result<(), AccountError>
pub async fn set_project_account(pool: &SqlitePool, db_tx: &DbWriteTx, project_id: &str, agent_type: &str,
    account_id: Option<String>) -> Result<(), AccountError>
// IPC: list_accounts() ; create_account(input) ; update_account(input) ; remove_account(account_id, delete_dir) ;
//      set_project_account(project_id, agent_type, account_id: Option<String>)  -> all return AccountsSnapshot.
//      Mutations emit "accounts-changed" with the snapshot to every window.
```
```ts
export type SignInStatus = 'signedIn' | 'signedOut' | 'apiKey' | 'unknown'
export interface AccountIdentity { status: SignInStatus; email: string | null; orgName: string | null; plan: string | null; providers: string[] }
export interface AccountEnvVar { key: string; value: string | null; secret: boolean }
export interface Account { id: string; agentType: AgentType; label: string; color: string; configDir: string; managedDir: boolean;
  env: AccountEnvVar[]; removedAt: number | null; createdAt: number; identity: AccountIdentity }
export interface DefaultAccount { agentType: AgentType; identity: AccountIdentity }
export interface ProjectAccount { projectId: string; agentType: AgentType; accountId: string }
export interface AccountsSnapshot { accounts: Account[]; defaults: DefaultAccount[]; projectAccounts: ProjectAccount[] }
export interface AccountEnvInput { key: string; value: string | null; secret: boolean }
export interface NewAccountInput { agentType: AgentType; label: string; color: string; existingDir: string | null; env: AccountEnvInput[] }
export interface UpdateAccountInput { id: string; label: string; color: string; env: AccountEnvInput[] }
export const listAccounts = () => invoke<AccountsSnapshot>('list_accounts')   // DEMO mode: empty snapshot
export const createAccount = (input: NewAccountInput) => invoke<AccountsSnapshot>('create_account', { input })
export const updateAccount = (input: UpdateAccountInput) => invoke<AccountsSnapshot>('update_account', { input })
export const removeAccount = (accountId: string, deleteDir: boolean) => invoke<AccountsSnapshot>('remove_account', { accountId, deleteDir })
export const setProjectAccount = (projectId: string, agentType: AgentType, accountId: string | null) =>
  invoke<AccountsSnapshot>('set_project_account', { projectId, agentType, accountId })
```
The rules:
- **Create.**
  - A harness without a profile is `Invalid`.
  - `existing_dir` needs `allows_existing_dir`. The dir is normalized and validated against the standard home, the dirs already used by live accounts of the same harness, and existence. It is never prepared or written.
  - Otherwise the account gets `managed_account_dir(app_data_dir, id)` and `prepare_account_dir` runs in `spawn_blocking`.
  - `required_secret` must be present as a secret with a value.
  - Env keys must pass `validate_env_key`.
  - Secret values go to the store; the row keeps `value: None`.
- **Update.** The env list is replaced. A secret with `value: None` keeps its stored value. A secret key that is gone is deleted from the store.
- **Remove.** Projects that use the account make it `InUse { projects }`. Otherwise mark it removed, delete all of its secrets, and `remove_dir_all` only if `delete_dir && managed_dir`.
- **Set project account.** The account must exist, be live and match the harness. `None` clears the binding.
- **Snapshot.** Identities are read in `spawn_blocking` with the api-key overlay, fresh on every snapshot; nothing about identity is stored in the DB. Removed accounts get the default identity. Defaults cover every harness whose `account_profile()` is `Some`.

- [ ] **Step 1: Write the failing tests** (`test_pool`, `MemorySecretStore`, tempdirs for app data and user home):
```rust
#[tokio::test] async fn create_managed_claude_account_creates_dir()     // <app>/accounts/<id> exists; managed_dir; row stored
#[tokio::test] async fn create_existing_dir_account_normalizes_and_does_not_write() // "<tmp>/x/" stored as "<tmp>/x"; dir still empty
#[tokio::test] async fn create_rejects_standard_home()                  // existing_dir "~/.claude" -> Invalid
#[tokio::test] async fn create_rejects_duplicate_dir()
#[tokio::test] async fn create_stores_secret_in_store_not_db()          // row env value None; store has "sk-1"
#[tokio::test] async fn create_rejects_invalid_env_key()                // "BAD-KEY" -> Invalid
#[tokio::test] async fn update_keeps_omitted_secret_and_deletes_removed_secret()
#[tokio::test] async fn remove_blocked_while_project_uses_account()     // InUse { projects: ["My App"] }
#[tokio::test] async fn remove_deletes_secrets_and_managed_dir_when_asked()
#[tokio::test] async fn remove_never_deletes_user_dir()
#[tokio::test] async fn set_project_account_rejects_wrong_harness_and_removed()
#[tokio::test] async fn snapshot_includes_identities_and_claude_default()
```
```ts
it('account wrappers invoke the right commands', ...) // list_accounts; create_account {input}; remove_account {accountId, deleteDir}; set_project_account {projectId, agentType, accountId:null}
```
- [ ] **Step 2: Run** `cargo test accounts::service` and `pnpm test src/lib/ipc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, then thin `#[tauri::command]` wrappers that read `HOME`, `blob::AppDataDir` and `Secrets`, use `uuid::Uuid::new_v4()` and `task::epoch_ms()`, map errors with `to_ipc()`, and emit `accounts-changed`. Register all five commands.
- [ ] **Step 4: Run** `cargo test`, `pnpm test src/lib/ipc.test.ts`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): account CRUD, project binding and snapshot commands`

---

### Task 16: Login and logout terminals

**Files:**
- Create: `src-tauri/src/accounts/login.rs`
- Modify: `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs` (`.manage`, `.setup`, handler list)
- Modify: `src/types/index.ts`, `src/lib/ipc.ts`

**Interfaces:**
- Consumes: `account_env` (Task 5), `accounts::env::pty_command_and_env` (the shared PTY wrapper, Task 14 fix), `spawn_pty` with `EnvPatch` (Task 11), the snapshot publishing in `accounts::manage` (Task 15: publish while holding the account-changes turn, e.g. through `Turn::publish`).
- Produces:
```rust
#[derive(Default)] pub struct LoginGuard(pub std::sync::Mutex<Option<String>>); // active terminal id
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)] #[serde(rename_all = "camelCase")] pub enum AccountTerminalAction { Login, Logout }
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")] pub struct AccountTerminal { pub terminal_id: String, pub hint: Option<String> }
pub fn terminal_command(cli_binary: &str, args: &[&str]) -> String // "exec <bin>" + " " + shell_quote(arg) per arg
pub fn claim(guard: &LoginGuard, terminal_alive: impl Fn(&str) -> bool) -> Result<(), AccountError> // Busy if a live terminal holds it
pub fn exited_terminal_id(payload: &str) -> Option<String>        // parses {"terminalId":..,"exitCode":..}
pub fn install_exit_listener(app: &AppHandle)                      // app.listen("pty-exited"): guarded id -> clear, publish a fresh "accounts-changed" snapshot through accounts::manage (under the account-changes turn)
// IPC start_account_terminal(account_id: String, action: AccountTerminalAction, rows: u16, cols: u16) -> AccountTerminal
```
```ts
export type AccountTerminalAction = 'login' | 'logout'
export interface AccountTerminal { terminalId: string; hint: string | null }
export const startAccountTerminal = (accountId: string, action: AccountTerminalAction, rows: number, cols: number) =>
  invoke<AccountTerminal>('start_account_terminal', { accountId, action, rows, cols })
```
How the command runs:
- It loads the live account and its profile's `login_args` / `logout_args` (`None` is `Invalid`).
- The env is `account_env`. There is no sign-in check here, because signing in is the point.
- It builds `(outer, pty_env) = pty_command_and_env(&terminal_command(..), Vec::new(), &env)` and runs `spawn_pty(app, pty_map, format!("account-{id}"), <user home>, rows, cols, Some(outer), pty_env, true, Some(format!("{label} login")), false, None)`.
- It stores the terminal id in the guard and returns the profile's hint for the action.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn terminal_command_quotes_args()       // ("claude", &["auth","login"]) -> "exec claude 'auth' 'login'"; ("gemini", &[]) -> "exec gemini"
#[test] fn claim_rejects_while_terminal_alive()  // Err(AccountError::Busy)
#[test] fn claim_frees_stale_terminal()
#[test] fn exited_terminal_id_parses_payload()
```
- [ ] **Step 2: Run** `cargo test accounts::login`. Expected: FAIL.
- [ ] **Step 3: Implement**, register `LoginGuard`, call `install_exit_listener(app.handle())` in `.setup()`, and register the command. `terminal_alive` checks the `ActivePtyMap`.
- [ ] **Step 4: Run** `cargo test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): login and logout terminals with one-at-a-time guard`

---

### Task 17: Rate limits per account

**Files:**
- Modify: `src-tauri/src/accounts/mod.rs`, `src-tauri/src/stream.rs` (`RateLimitInfoEvent` L253-263, emit L1665-1679, `stream_and_capture` params), `src-tauri/src/task.rs` (L2721-2736)
- Create: `src/lib/accounts.ts`
- Modify: `src/types/index.ts` (`RateLimitInfo`), `src/store/sessions.ts` (L29, L569), `src/store/sessions.test.ts`, `src/components/MessageInput.tsx` (L97-116)

**Interfaces:**
- Produces:
```rust
pub fn account_key(agent_type: &str, account_id: Option<&str>) -> String // id, or "default:<agent_type>"
// RateLimitInfoEvent gains `account_key: String`; stream_and_capture gains `account_key: String`
```
```ts
export function accountKey(agentType: AgentType, accountId: string | null): string // src/lib/accounts.ts
// RateLimitInfo gains accountKey: string
export const [rateLimitByAccount, setRateLimitByAccount] = createStore<Record<string, RateLimitInfo>>({}) // replaces rateLimitInfo
export function rateLimitFor(key: string): RateLimitInfo | null
```

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn account_key_default_and_added() // ("claude", None) -> "default:claude"; ("claude", Some("a1")) -> "a1"
```
```ts
it('stores rate limit events per account', ...) // fire 'rate-limit-info' {accountKey:'a1', resetsAt:1} and {accountKey:'default:claude', resetsAt:2}
                                                // -> rateLimitFor('a1').resetsAt === 1, rateLimitFor('default:claude').resetsAt === 2
```
- [ ] **Step 2: Run** `cargo test account_key` and `pnpm test src/store/sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `UsageChip` reads `rateLimitFor(accountKey(session.agentType, session.accountId))`.
- [ ] **Step 4: Run** `cargo test`, `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): rate limits tracked per account`

---

### Task 18: Frontend accounts store, error toasts and loading in both windows

**Files:**
- Create: `src/store/accounts.ts`, `src/store/accounts.test.ts`, `src/lib/accountErrors.ts`, `src/lib/accountErrors.test.ts`
- Modify: `src/store/ui.ts` (next to `showSettings` L181), `src/components/SettingsPage.tsx` (consume the section request)
- Modify: `src/lib/appInit.ts` (`initListeners` L44-55, `loadInitialData` L112-114), `src/components/TaskWindowShell.tsx:74-76`, `TaskWindowShell.test.tsx`, `TaskWindowShell.shortcuts.test.tsx`
- Modify: `src/store/sessions.ts` (`sendMessage` catch), `src/components/SessionTerminal.tsx:36-47` (open catch)

**Interfaces:**
- Consumes: `listAccounts`, `AccountsSnapshot` (Task 15).
- Produces:
```ts
// store/accounts.ts
export const [accountsState, setAccountsState] = createStore<AccountsSnapshot>({ accounts: [], defaults: [], projectAccounts: [] })
export function applySnapshot(s: AccountsSnapshot): void        // reconcile into the store
export async function loadAccounts(): Promise<void>
export async function initAccountListeners(): Promise<void>     // 'accounts-changed' -> applySnapshot
export function accountById(id: string | null | undefined): Account | undefined
export function liveAccountsFor(agentType: AgentType): Account[] // removedAt === null
export function projectAccountId(projectId: string, agentType: AgentType): string | null
export function defaultIdentity(agentType: AgentType): AccountIdentity | undefined
// ui.ts
export const [settingsSectionRequest, setSettingsSectionRequest] = createSignal<string | null>(null)
export function openSettings(section?: string): void // setShowSettings(true) + request; SettingsPage selects it and clears the request
// lib/accountErrors.ts
export interface AccountErrorPayload { kind: 'removed' | 'signedOut' | 'missing' | 'wrongHarness' | 'secret' | 'busy' | 'inUse' | 'invalid';
  accountId: string | null; label: string | null; projects: string[]; message: string | null }
export function parseAccountError(err: unknown): AccountErrorPayload | null // strips "ACCOUNT_ERROR:" and parses the JSON
export function notifyAccountError(err: unknown): boolean                  // shows the toast; true if it was an account error
```
Toast copy (title / message / actions):
- `signedOut`: "Account signed out" / "`<label>` is signed out." / **Log in** (primary) → `openSettings('accounts')`
- `removed`: "Account removed" / "`<label>` was removed. Start a new session on another account." / **Choose account** → `openSettings('accounts')`
- `inUse`: "Account in use" / "Used by `<projects>`. Change those projects first."
- `busy`: "Login already open" / "Finish or close the other login first."
- `secret`: "Keychain error" / "Couldn't read a secret for `<label>` from the keychain."
- Every other kind: "Account error" / `message`

Where errors are handled: `sendMessage` resets the status and returns quietly when `notifyAccountError` handles the error. `SessionTerminal` does the same before showing its normal error state.

- [ ] **Step 1: Write the failing tests:**
```ts
it('loadAccounts stores the snapshot', ...)
it('accounts-changed replaces the snapshot', ...)
it('liveAccountsFor hides removed accounts', ...)
it('projectAccountId reads the binding', ...)
it('parseAccountError reads prefixed JSON and ignores other errors', ...)
it('signedOut toast offers Log in', ...) // addToast mocked: actions[0].label === 'Log in'
it('sendMessage swallows account errors after the toast', ...) // in sessions.test.ts
```
- [ ] **Step 2: Run** `pnpm test src/store/accounts.test.ts src/lib/accountErrors.test.ts src/store/sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `initAccountListeners()` to the awaited `initListeners` array and `loadAccounts()` to both `loadInitialData` and the detached shell's `Promise.all`. Add the mocks to both TaskWindowShell tests.
- [ ] **Step 4: Run** `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): accounts store, actionable account errors, loaded in every window`

---

### Task 19: Settings → Accounts

**Files:**
- Create: `src/components/AccountsSettings.tsx`, `AccountDialog.tsx`, `AccountTerminalDialog.tsx`, and a `.test.tsx` for each, plus `src/components/SettingsPage.test.tsx`
- Modify: `src/components/SettingsPage.tsx` (nav L186-198, title L233, sections, `selectedProject` L84-88), `src/components/Layout.tsx:107-119`

**Interfaces:**
- Consumes: the store (Task 18), the account wrappers (Task 15), `startAccountTerminal` (Task 16), `meetsVersionReq` (`src/lib/agents.ts:44`), `ShellTerminal`, `Dialog`, `ConfirmDialog`, `ColorPicker`, `Select`, `Toggle`.
- Produces: `AccountsSettings: Component`, `AccountDialog: Component<{ open: boolean; agentType: AgentType; account?: Account; onClose: () => void }>`, `AccountTerminalDialog: Component<{ account: Account; action: AccountTerminalAction; onClose: () => void }>`, and `export function settingsSectionForShortcut(digit: number, projectIds: string[]): string | null` in `SettingsPage.tsx`. The section id is `'accounts'`.

Behavior:
- **Navigation.** The Accounts nav sits between Appearance and Projects. Layout's Cmd+digit handler calls `settingsSectionForShortcut`: 1 = General, 2 = Appearance, 3 = Accounts, 4 and up = projects. `selectedProject()` ignores `'accounts'`.
- **Fresh identities.** `AccountsSettings` calls `loadAccounts()` on mount, so opening Settings re-reads every identity.
- **Harness groups.** There is one group per installed agent whose `accountSupport` is set. Each group shows:
  - a Default row with its identity line (email · org · plan, or "Signed out" / "API key" / "Status unknown")
  - one card per live account: color dot, label, identity line, dir in a muted monospace line, and buttons for Log in / Log out (when supported), Edit and Remove
  - **Add account**, disabled with an explanation when `blockedReason` is set or `minCliVersion` is not met
- **AccountDialog.**
  - Fields: label, color (ColorPicker swatch), and when adding with `existingDir` support, a Select "New folder managed by Verun" / "Existing folder" plus a path input.
  - When `requiredSecret` is set, a password field labeled with that key.
  - An env editor: key, value and a Toggle "Secret" per row. When editing, a stored secret shows the placeholder "Stored - leave empty to keep".
  - Errors go through `notifyAccountError`, else `addToast(String(e), 'error')`.
- **AccountTerminalDialog.**
  - `Dialog width="44rem"` with the title "Log in to `<label>`" or "Log out of `<label>`".
  - The note: "Your browser signs in with whichever account it is already using. If that is the wrong one, copy the link from the terminal into the right browser profile." Then the backend hint, then `ShellTerminal`.
  - On `pty-exited` for its terminal it shows a Done button.
  - On close it calls `ptyClose` if the terminal is still running.
- **Remove.** A `ConfirmDialog` with `danger`: "Remove `<label>`? Sessions on this account keep their history but can't continue." It has an "Also delete its folder" Toggle when `managedDir`.

- [ ] **Step 1: Write the failing tests** (mock `../lib/ipc`, the stores, and `ShellTerminal` as a marker div, as `SessionTerminal.test.tsx` does):
```ts
it('lists the default row and live accounts per supported harness', ...)
it('Log in starts a login terminal', ...)            // startAccountTerminal('a1', 'login', 24, 80); marker data-terminal-id rendered
it('shows Done after the login terminal exits', ...)
it('remove in use shows the account toast', ...)     // removeAccount rejects with ACCOUNT_ERROR inUse
it('create sends a managed account', ...)            // createAccount({agentType:'claude', label:'Acme', color:'#7c3aed', existingDir:null, env:[]})
it('existing folder option only when supported', ...)
it('secret env rows are sent with secret true', ...)
it('maps settings shortcuts with Accounts third', ...) // SettingsPage.test.tsx: (3, ['p1']) -> 'accounts'; (4, ['p1']) -> 'p1'; (5, ['p1']) -> null
```
- [ ] **Step 2: Run** `pnpm test src/components/AccountsSettings.test.tsx src/components/AccountDialog.test.tsx src/components/AccountTerminalDialog.test.tsx src/components/SettingsPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** using the existing row pattern (`SettingsPage.tsx:251-257`) and section headings (`section-title`).
- [ ] **Step 4: Run** `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Settings section to add, log in, edit and remove accounts`

---

### Task 20: Project settings → Accounts

**Files:**
- Create: `src/components/ProjectAccountsSettings.tsx`, `ProjectAccountsSettings.test.tsx`
- Modify: `src/components/SettingsPage.tsx` (per-project block, after Repository L315-379)

**Interfaces:**
- Produces: `ProjectAccountsSettings: Component<{ projectId: string }>`.

Behavior:
- The heading is "Accounts", with the description "New sessions in this project use these accounts. Existing sessions keep theirs."
- There is one `Select` per harness that has at least one live account. Its options are `Default` (plus " · email" when known), then each account's label. The value is the binding or `'default'`.
- A change calls `setProjectAccount(projectId, agent, v === 'default' ? null : v)`, then `applySnapshot`, then a success toast. Errors go through `notifyAccountError`, else an error toast.

- [ ] **Step 1: Write the failing tests:**
```ts
it('renders a select only for harnesses with accounts', ...)
it('choosing an account binds it', ...)   // setProjectAccount('p1', 'claude', 'a1')
it('choosing Default clears the binding', ...) // setProjectAccount('p1', 'claude', null)
```
- [ ] **Step 2: Run** `pnpm test src/components/ProjectAccountsSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): per-project account bindings in Settings`

---

### Task 21: Session pickers carry an account

**Files:**
- Modify: `src/lib/accounts.ts`; Create: `src/lib/accounts.test.ts`
- Modify: `src/components/NewSessionMenu.tsx`, `TaskPanel.tsx` (L344-350, L709-718), `ModelPicker.tsx`, `src/store/modelPicker.ts`, `src/lib/useTaskShortcuts.ts:101-118`, `ActionsPanel.tsx:342-370`, `HarnessModelPicker.tsx`, `NewTaskView.tsx`, `src/store/draftTask.ts`, `src/store/sessions.ts` (`createSession` L68-76), `MessageInput.tsx:985-990`, `ChatView.tsx:823-831`
- Test: `ModelPicker.test.tsx`, `HarnessModelPicker.test.tsx`, `NewTaskView.test.tsx`, `TaskWindowShell.shortcuts.test.tsx`

**Interfaces:**
- Consumes: the store (Task 18), `createSession`/`createTask` with an account (Task 7).
- Produces:
```ts
export interface AccountChoice { key: string; agentType: AgentType; selection: AccountSelection; label: string; color: string | null; isProjectDefault: boolean }
export function accountChoicesFor(agentType: AgentType, projectId: string | null | undefined): AccountChoice[]
  // [] when the harness has no live accounts (pickers render exactly as today)
  // else Default + one per live account, the project's binding first (Default first when unbound)
export function inheritedSelection(accountId: string | null): AccountSelection // explicit: {kind:'account', id} or {kind:'default'}
// NewSessionMenu.onCreate, ModelPicker.onPick, ModelPickerRequest.onPick, HarnessModelPicker.onPick:
//   (agentType: AgentType, model?: string, account?: AccountSelection) => ...
// NewSessionMenu, ModelPicker / ModelPickerRequest and HarnessModelPicker gain projectId?: string
// store createSession(taskId, agentType, model?, account?); DraftTaskInput gains account?: AccountSelection
```
Behavior:
- When a harness has accounts, each choice becomes its own agent row (`<agent name> · <label>` plus the color dot), and its model submenu or group is keyed by agent and account. The trigger label of `HarnessModelPicker` gains ` · <label>` only for non-Default choices.
- New sessions from `MessageInput` "new-session" and `ChatView` retry inherit the current session's account through `inheritedSelection`.
- `ActionsPanel` and Cmd+T pass the picked selection through.
- `NewTaskView` resets its selection to `{kind:'projectDefault'}` when the project changes.

- [ ] **Step 1: Write the failing tests:**
```ts
it('no accounts gives no choices', ...)
it('project binding comes first', ...)
it('unbound project lists Default first', ...)
it('inheritedSelection is explicit', ...)              // null -> {kind:'default'}; 'a1' -> {kind:'account', id:'a1'}
it('account rows appear and pick passes the selection', ...) // ModelPicker; the existing 5-row test still passes with no accounts
it('picking an account row passes the selection', ...)       // HarnessModelPicker; the "Choose model: Opus" label is unchanged without accounts
it('send passes the account selection to startDraftTask', ...) // NewTaskView
```
- [ ] **Step 2: Run** `pnpm test src/lib/accounts.test.ts src/components/ModelPicker.test.tsx src/components/HarnessModelPicker.test.tsx src/components/NewTaskView.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the `openModelPicker` argument assertions in `TaskWindowShell.shortcuts.test.tsx`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): pick an account when starting a session`

---

### Task 22: Show the account on session tabs

**Files:**
- Create: `src/components/AccountDot.tsx`, `AccountDot.test.tsx`
- Modify: `src/components/TaskPanel.tsx:744-751` (tab), `NewSessionMenu.tsx:286` (Recent rows)

**Interfaces:**
- Produces: `AccountDot: Component<{ accountId: string | null; size?: number }>`.
  - `null` renders nothing.
  - A live account renders a dot in its color, titled `<label>` plus ` · <email>` when known.
  - A removed or unknown account renders a hollow `ring-1` dot, titled `<label> (removed)` or "Unknown account".

TaskPanel is shared by the main and detached windows, so one edit covers both.

- [ ] **Step 1: Write the failing tests:**
```ts
it('renders nothing for Default', ...)
it('uses the account color and tooltip', ...) // title === 'Acme · dev@acme.com'
it('marks removed accounts', ...)             // title === 'Acme (removed)'
```
- [ ] **Step 2: Run** `pnpm test src/components/AccountDot.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** and render it after the agent icon on tabs and Recent rows.
- [ ] **Step 4: Run** `pnpm test`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): account indicator on session tabs`

**Milestone:** Claude accounts work end to end. Run `make check` before continuing.

---

### Task 23: Codex accounts

**Files:** Modify `src-tauri/src/agent/codex.rs`, `src-tauri/src/accounts/env.rs` (test), `src-tauri/src/ipc.rs` (test from Task 4)

**Interfaces:** Codex implements the Task 4 trait methods:
- **Home env:** `[("CODEX_HOME", dir)]`.
- **Profile:**
  - scrub `["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","OPENAI_FEDERATION_RULE_ID","OPENAI_IDENTITY_TOKEN_FILE"]`, api keys `["CODEX_API_KEY"]`
  - login `["login"]`, logout `["logout"]`
  - existing dir allowed, in project env
- **Standard home:** `~/.codex`.
- **Prepare:** `create_dir_all`, then write `config.toml` as `mcp_oauth_credentials_store = "file"\n` only if it doesn't exist. Existing user dirs are never written.
- **Identity:**
  - Read `<home>/auth.json` with `read_json_with_retry`. Default reads `$CODEX_HOME` if inherited, else `~/.codex`.
  - `auth_mode == "chatgpt"`: decode `tokens.id_token`, take `email`, and take `chatgpt_plan_type` from `["https://api.openai.com/auth"]`. Status `SignedIn`.
  - `"apikey"`: `ApiKey`. A missing file or missing tokens: `SignedOut`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn codex_profile_values()
#[test] fn codex_prepare_dir_seeds_mcp_file_store_once() // existing config.toml is left as-is
#[test] fn codex_identity_reads_id_token_claims()         // fixture JWT email "dev@acme.com", plan "pro" -> SignedIn
#[test] fn codex_identity_api_key_mode()
#[test] fn codex_identity_missing_is_signed_out()
#[test] fn session_env_includes_project_codex_account_for_claude_session() // CODEX_HOME and CLAUDE_CONFIG_DIR both set
// account_support_info_only_for_supporting_harnesses: Codex is now Some; switch its "None" case to Cursor until Task 27
```
- [ ] **Step 2: Run** `cargo test codex_` and `cargo test session_env_includes_project_codex`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Codex accounts via CODEX_HOME`

---

### Task 24: Gemini accounts

**Files:** Modify `src-tauri/src/agent/gemini.rs`

**Interfaces:**
- **Home env:** `[("GEMINI_CLI_HOME", dir)]`.
- **Profile:**
  - scrub `["GEMINI_CLI_HOME","GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_GENAI_USE_VERTEXAI","NO_BROWSER","CI"]`, api keys `["GEMINI_API_KEY","GOOGLE_API_KEY"]`
  - login `[]` and logout `[]` (both run `gemini`)
  - login hint "Gemini starts Google sign-in on its own. When it is done, type /quit."
  - logout hint "Type /auth signout, then /quit."
  - existing dir allowed, in project env, `min_cli_version: Some("0.25.0")`
- **Standard home:** `user_home` itself, because `GEMINI_CLI_HOME=$HOME` is the default.
- **Prepare:** create `<dir>/.gemini` and write `<dir>/.gemini/settings.json` as `{"security":{"auth":{"selectedType":"oauth-personal"}}}` if it doesn't exist.
- **Identity:** `<home>/.gemini/google_accounts.json` → `active`. An email string means `SignedIn`; null or a missing file means `SignedOut`. Default reads `$GEMINI_CLI_HOME` if inherited, else `user_home`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn gemini_profile_values()
#[test] fn gemini_prepare_dir_seeds_oauth_settings_once()
#[test] fn gemini_identity_reads_active_account() // {"active":"dev@acme.com","old":[]} -> SignedIn; {"active":null} -> SignedOut
```
- [ ] **Step 2: Run** `cargo test gemini_`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Gemini accounts via GEMINI_CLI_HOME`

---

### Task 25: Grok accounts

**Files:** Modify `src-tauri/src/agent/grok.rs`

**Interfaces:**
- **Home env:** `[("GROK_HOME", dir)]`.
- **Profile:**
  - fixed env `[("GROK_DISABLE_AUTOUPDATER","1")]`
  - scrub `["GROK_HOME","GROK_AUTH","GROK_AUTH_PATH","XAI_API_KEY"]`, api keys `["XAI_API_KEY"]`
  - login `["login","--oauth"]`, logout `["logout"]`
  - existing dir allowed, in project env
- **Standard home:** `~/.grok`.
- **Identity:** `<home>/auth.json`.
  - The entry whose key starts with `https://auth.x.ai::` gives `email`, and it counts as `SignedIn` only if it has a `refresh_token`.
  - Its `key` JWT's `tier` claim maps 0 → "Free", 1 → "SuperGrok", 2 → "X Basic", 3 → "X Premium", 4 → "X Premium+", 5 → "SuperGrok Heavy", 6 → "SuperGrok Lite", 7 → "SuperGrok Plus".
  - An `xai::api_key` entry means `ApiKey`; otherwise `SignedOut`.
- **Blocked reason:** when the `grok` found on `PATH` canonicalizes into a `/node_modules/` path, return: "Grok was installed through npm. Added accounts need the native install: curl -fsSL https://x.ai/cli/install.sh | bash".
- Helpers: `fn find_on_path(bin: &str, path_var: &OsStr) -> Option<PathBuf>` and `fn is_npm_launcher(resolved: &Path) -> bool`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn grok_profile_values()                    // includes GROK_DISABLE_AUTOUPDATER=1
#[test] fn grok_identity_reads_oidc_entry_and_tier()
#[test] fn grok_identity_api_key_and_signed_out()
#[test] fn is_npm_launcher_detects_node_modules()
#[test] fn find_on_path_searches_dirs_in_order()    // tempdirs with executable files
```
- [ ] **Step 2: Run** `cargo test grok_` and `cargo test npm_launcher`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Grok accounts via GROK_HOME`

---

### Task 26: OpenCode accounts

**Files:** Modify `src-tauri/src/agent/opencode.rs`, `src-tauri/src/accounts/service.rs` (project_env test)

**Interfaces:**
- **Home env:** `[("XDG_DATA_HOME", "<dir>/data"), ("XDG_STATE_HOME", "<dir>/state")]`.
- **Profile:**
  - provider keys = `["OPENAI_API_KEY","ANTHROPIC_API_KEY","GEMINI_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","OPENROUTER_API_KEY","XAI_API_KEY","GROQ_API_KEY","MISTRAL_API_KEY","DEEPSEEK_API_KEY"]`
  - scrub = `["XDG_DATA_HOME","XDG_STATE_HOME"]` plus the provider keys, api keys = the provider keys
  - login `["auth","login"]`, logout `["auth","logout"]`
  - no existing dirs, `in_project_env: false`
- **Prepare:** create `data` and `state`.
- **Identity:** the keys of `<data>/opencode/auth.json` become `providers`. Non-empty means `SignedIn` with no email; empty or missing means `SignedOut`. Default reads `$XDG_DATA_HOME` if inherited, else `~/.local/share`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn opencode_profile_values()
#[test] fn opencode_home_env_layout()           // "/acc/o1" -> XDG_DATA_HOME "/acc/o1/data", XDG_STATE_HOME "/acc/o1/state"
#[test] fn opencode_identity_lists_providers()  // {"openai":{..},"anthropic":{..}} -> providers ["anthropic","openai"] (sorted), SignedIn
#[tokio::test] async fn project_env_excludes_opencode_account()      // shells: no XDG_DATA_HOME
#[tokio::test] async fn session_env_includes_opencode_vars_for_opencode_session()
```
- [ ] **Step 2: Run** `cargo test opencode_` and `cargo test project_env_excludes_opencode`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): OpenCode accounts via XDG data and state dirs`

---

### Task 27: Cursor API-key accounts

**Files:** Modify `src-tauri/src/agent/cursor.rs`, `src-tauri/src/accounts/manage.rs` (create_account test), `src-tauri/src/ipc.rs` (test)

**Interfaces:**
- **Home env:** `[("CURSOR_CONFIG_DIR", "<dir>/cfg"), ("CURSOR_DATA_DIR", "<dir>/data")]`.
- **Profile:**
  - fixed env `[("AGENT_CLI_CREDENTIAL_STORE","memory")]`
  - scrub `["CURSOR_CONFIG_DIR","CURSOR_DATA_DIR","CURSOR_API_KEY","AGENT_CLI_CREDENTIAL_STORE"]`, api keys `["CURSOR_API_KEY"]`, `required_secret: Some("CURSOR_API_KEY")`
  - no login or logout, no existing dirs, in project env
- **Prepare:** create `cfg` and `data`.
- **Identity:** `<dir>/cfg/cli-config.json` → `authInfo.email` if present, with status `Unknown`. The api-key overlay turns that into `ApiKey`.

- [ ] **Step 1: Write the failing tests:**
```rust
#[test] fn cursor_profile_values()
#[test] fn cursor_account_env_pairs_api_key_with_memory_store() // set has CURSOR_API_KEY and AGENT_CLI_CREDENTIAL_STORE=memory together
#[tokio::test] async fn create_cursor_account_requires_api_key() // missing secret -> Invalid
#[test] fn cursor_identity_reads_auth_info_email()
// account_support_info_only_for_supporting_harnesses: every harness now has support; assert Cursor has login false and required_secret "CURSOR_API_KEY"
```
- [ ] **Step 2: Run** `cargo test cursor_` and `cargo test create_cursor_account`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): Cursor API-key accounts`

---

### Task 28: Docs and end-to-end verification

**Files:** Modify `CHANGELOG.md` (under `## Unreleased`), `README.md` (Features), `ROADMAP.md` (check off any matching item)

- [ ] **Step 1: Update the docs.** CHANGELOG: "Multiple accounts per harness: bind each project to its own Claude, Codex, Gemini, Grok, OpenCode or Cursor account". README: one Features bullet. ROADMAP: check off any matching item without adding new ones.
- [ ] **Step 2: Run** `make check`, `cd src-tauri && cargo clippy -- -D warnings`, `pnpm check`, `pnpm test`, `cargo test`. Expected: all green, zero warnings.
- [ ] **Step 3: Verify end to end** in `pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications`:
  1. Add a second Claude account (new folder) and log in through the dialog. The card shows the email.
  2. Bind a project to it. Start a chat session and a terminal-mode session; `/status` in the terminal shows the bound email.
  3. In terminal mode, check that no onboarding wizard appears for the fresh account.
  4. Resume both sessions, fork one, and confirm the session title appears.
  5. Open a task shell and run `claude` and `echo $CLAUDE_CONFIG_DIR`: it is the account dir.
  6. Log the account out, then send a message: the "Account signed out" toast offers Log in.
  7. A project left on Default behaves exactly as before, including `env | grep -i claude` in its shells.
  8. Open the same task in a detached window: the tab shows the account dot, and pickers list the account.
  9. Add a Codex account and start a Codex session on it.
- [ ] **Step 4: Commit** `docs: multi-account support`
