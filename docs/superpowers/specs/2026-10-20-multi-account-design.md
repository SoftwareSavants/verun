# Multiple accounts per harness

**Date:** 2026-10-20
**Status:** Approved 2026-10-20

## Intent

Verun is used for client projects and for the user's own work. Each project
belongs to one account: a client's Claude (or Codex, ...) login, or the user's
own. Today every agent process inherits Verun's environment, so everything runs
on whatever login `~/.claude` (or `~/.codex`, ...) holds. Working on a client
project means logging out and back in globally.

This feature lets the user sign in to several accounts per harness side by
side, bind each project to an account, and have everything Verun runs for that
project use that account. The failure it exists to prevent: client work running
on the user's own subscription, or the reverse.

Prior art is T3 Code's "provider instances" (links at the end). We copy its
model: one isolated config dir per account, login done by the CLI itself, no
state shared between dirs.

## Goals

- Add, log in, log out, edit and remove accounts for any harness, from Settings.
  Cursor's added accounts are API-key accounts (see Per-harness support).
- Each project sets one default account per harness.
- A new session takes the project's account for its harness. The user can pick
  a different account when starting a session.
- A session keeps its account for life. Resume, fork, title generation,
  worktree trust, transcript reading, skill discovery and the rate-limit display
  all use it.
- Task shells, setup/destroy hooks and the start command get the project's
  account env too, so typing `claude` in a client worktree uses the client login.
- The UI shows which account a session runs on.
- Nothing changes for users who never add an account.

## Non-goals

- Switching a running session to another account, or T3-style lossy context
  handoff. To move work to another account, start a new session.
- Rotating or failing over between accounts on rate limits.
- Sharing settings, skills, plugins, MCP servers or history between accounts.
  Verun never symlinks anything; users can do it by hand. (Claude's
  undocumented `CLAUDE_SECURESTORAGE_CONFIG_DIR` would allow one shared config
  dir with separate credentials; not used.)
- Per-task default accounts.
- Per-account usage or cost reporting.
- Verun running OAuth itself, or reading, copying or writing CLI credentials.

## Anti-goals

These are failures even if everything else works:

- **Silent fallback.** A session or side call runs on a different account than
  the one it is bound to, for example because that account is signed out or
  was removed. It must fail loudly with a way to fix it.
- **Content leaking across accounts through side calls.** Title generation
  sends the user's message to the API, so it must run on the session's account.
  Same for cloud import.
- **A project quietly reverting to Default** because its account was removed.
- **Disturbing existing setups.** Account management never modifies
  `~/.claude`, `~/.claude.json`, the default keychain entries, or any directory
  the user brought in.

## Constraints

- Project rules in `CLAUDE.md` apply: all file I/O, git and process work in
  Rust; a typed wrapper in `src/lib/ipc.ts` for every command; events, never
  polling; fire-and-forget SQLite writes; TDD.
- **Platform:** macOS is the target and the only platform verified end to end;
  the keychain and path-hash details in this doc are macOS behavior. Use
  cross-platform primitives (for example a keyring crate that uses each OS's
  native store) so the Windows and Linux release builds keep compiling and
  behave sensibly, but do no platform-specific work beyond that.

## How it works

### Accounts and isolation

An account is a harness plus a label, a color, an optional config dir and
optional env vars.

- The config dir is passed through the harness's home env var (table below).
  Each dir is a complete, separate CLI home with its own credentials, settings,
  skills, plugins, MCP servers and history.
- For Claude this is `CLAUDE_CONFIG_DIR=<dir>`. Never override `HOME`: on macOS
  it drops the login keychain from the search list and breaks every
  keychain-backed CLI (verified; T3 Code hit this, issue #4696). Verified on
  Claude Code 2.1.304: with `CLAUDE_CONFIG_DIR` set, the keychain service is
  `Claude Code-credentials-<sha256(dir)[:8]>` and Claude reads
  `<dir>/.claude.json` instead of `~/.claude.json`, so each dir is its own login.
- **The dir string must be byte-identical on every spawn.** Claude hashes the
  exact env string: no `~` expansion, no `..` resolution, and a trailing slash
  changes the hash. A different spelling orphans the login. Verun normalizes the
  path once when the account is created (expand `~`, resolve `.`/`..`, strip a
  trailing slash, but do **not** resolve symlinks), stores that string, and
  always passes it verbatim.
- Every harness has an implicit **Default** account, which is today's
  behavior: no override, the CLI uses its standard home. Default is not stored
  as a row and cannot be removed.
- Env vars are arbitrary `KEY=VALUE` pairs per account (API keys, base URLs,
  router settings). Values marked secret live in the macOS keychain under a
  Verun service; the rest live in SQLite. Env vars work for every harness and
  are the only isolation available for harnesses without a home env var.

### Per-harness support

Researched on 2026-10-20 against Claude Code 2.1.304, Codex 0.159.2,
cursor-agent 2026.07.23, Gemini CLI 0.64.0 (source only, not installed),
Grok Build 1.0.34 and OpenCode 1.18.4. None of the CLIs expands `~` in these
vars, so Verun always passes absolute paths. Each harness's details live
behind the `Agent` trait (no `if kind == X` outside `agent/`).

**Claude**
- Home: `CLAUDE_CONFIG_DIR=<dir>`. Created by Claude if missing.
- Login / logout: `claude auth login` / `claude auth logout`.
- Identity: `<dir>/.claude.json` → `oauthAccount` (see Adding and logging in).
- Strip when inherited: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`,
  `CLAUDE_CODE_USE_MANTLE`, `ANTHROPIC_BASE_URL`.

**Codex**
- Home: `CODEX_HOME=<dir>`. It must already exist (Codex exits otherwise),
  so Verun creates it.
- Login / logout: `codex login` / `codex logout`. Browser login binds the
  fixed port 127.0.0.1:1455, and a second concurrent login cancels the first.
  Both commands revoke the home's existing token.
- Identity: `<dir>/auth.json` → `auth_mode`. For ChatGPT logins,
  `tokens.id_token` is a JWT whose payload has `email` and
  `https://api.openai.com/auth` → `chatgpt_plan_type`. The file is rewritten
  in place, not atomically, so retry when it fails to parse.
- MCP OAuth tokens go in a keychain entry shared by every home unless
  `mcp_oauth_credentials_store = "file"` is set. Set it for added accounts,
  by seeding the new home's `config.toml` or with a `-c` override at spawn.
- Strip when inherited: `CODEX_HOME`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
  `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`.
- `api_key_vars` is empty for Codex: API-key Codex accounts are set up by
  running `codex login --with-api-key` in a task shell of a bound project.

**Gemini**
- Home: `GEMINI_CLI_HOME=<dir>`. It stands in for `HOME`, so Gemini uses
  `<dir>/.gemini`. Requires Gemini CLI 0.25 or later.
- Login: there is no login subcommand. The login terminal runs `gemini`, and
  the user chooses "Sign in with Google" in its dialog; Gemini then saves that
  choice in the account's own settings. Verun does not seed
  `security.auth.selectedType` (amended during build): Gemini's configured
  auth type wins over `GEMINI_API_KEY`, so a seed would break API-key accounts.
  Logout: `/auth signout` in that terminal.
- Identity: `<dir>/.gemini/google_accounts.json` → `active` (an email, or
  null when signed out).
- API keys only through `GEMINI_API_KEY` in the account env: a key typed into
  Gemini's own dialog lands in a keychain entry shared by every home.
  `GOOGLE_API_KEY` alone selects no auth type, so it does not count as signed in.
- Added accounts always set `GEMINI_CLI_TRUST_WORKSPACE=true` (amended during
  build): a new home trusts no folders, and headless Gemini aborts in an
  untrusted folder. This matches Verun pre-trusting worktrees for Claude.
- Strip when inherited: `GEMINI_CLI_HOME`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`, `NO_BROWSER`,
  `CI`, `GOOGLE_GENAI_USE_GCA`, `GOOGLE_CLOUD_ACCESS_TOKEN`,
  `GOOGLE_GEMINI_BASE_URL`, `GEMINI_CLI_USE_COMPUTE_ADC`,
  `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE`.

**Grok** (xAI's Grok Build CLI)
- Home: `GROK_HOME=<dir>`. Credentials are files only, no keychain.
- Login / logout: `grok login --oauth` / `grok logout`. Pass the flag so the
  flow is deterministic.
- Identity: `<dir>/auth.json`, entry keyed `https://auth.x.ai::<client id>` →
  `email`. Signed in means an entry with a `refresh_token`. Plan comes from the
  token's `tier` claim.
- Always set `GROK_DISABLE_AUTOUPDATER=1` for added accounts, and spawn the
  native binary rather than the npm launcher. Otherwise each home gets its own
  ~140MB binary copy. The builder checks what Verun's `grok` resolves to.
- Strip when inherited: `GROK_HOME`, `GROK_AUTH`, `GROK_AUTH_PATH`,
  `XAI_API_KEY`.

**OpenCode**
- Home: no dedicated var. `XDG_DATA_HOME=<dir>/data` moves credentials and
  sessions, and `XDG_STATE_HOME=<dir>/state` moves prompt history. OpenCode 2's
  background service also lives under the state dir, so both are required.
- Login / logout: `opencode auth login` / `opencode auth logout` (the user
  picks a provider in the prompt). One account can hold several providers.
- Identity: no email on disk. Show the signed-in providers, which are the
  keys of `<dir>/data/opencode/auth.json`.
- These XDG vars also reach every tool the agent runs, which is accepted for
  OpenCode sessions.
- Inherited provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) apply to
  every OpenCode account. Strip the ones OpenCode reads. Known limitation: the
  scrub list is the nine common provider keys and is not exhaustive, so other
  providers' inherited keys (AWS, Azure, ...) can still reach an added account.

**Cursor** (API-key accounts only)
- Cursor's login lives in fixed keychain entries (`cursor-access-token`,
  `cursor-refresh-token`) that ignore its config dir, so two browser logins
  cannot coexist. Overriding `HOME` would work but breaks the keychain and
  every tool the agent runs. Browser login stays Default-only.
- An added Cursor account is a Cursor dashboard API key (a secret) plus
  `CURSOR_CONFIG_DIR=<dir>/cfg`, `CURSOR_DATA_DIR=<dir>/data` and
  `AGENT_CLI_CREDENTIAL_STORE=memory`.
- Never set `CURSOR_API_KEY` without `AGENT_CLI_CREDENTIAL_STORE=memory`: with
  the default store it overwrites the user's keychain login.
- Identity: `<dir>/cfg/cli-config.json` → `authInfo.email`, if Cursor writes
  it in API-key mode (builder verifies). Otherwise show "API key".
- Strip when inherited: `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`,
  `CURSOR_API_KEY`, `AGENT_CLI_CREDENTIAL_STORE`.

**All harnesses**
- **Scrub before applying.** For a session on an added account, remove that
  harness's inherited "strip" vars from the spawn env, then apply the account
  env. Nothing in Verun's own environment may override the account. Default
  sessions keep today's env untouched.
- **Resume works only within the same home for all six**, which is why the
  account is stored on the session.
- **Never copy credential files between homes.** Refresh tokens rotate or are
  single-use (Codex, Grok), so a copy breaks both logins. Verun offers no
  "clone account".

### Adding and logging in

- **Add account:** pick the harness, a label and a color, then either
  - **New directory:** Verun creates `<app data dir>/accounts/<account id>/`
    and lays out what the harness needs inside it (see the per-harness notes), or
  - **Existing directory:** a dir the user already logged in from a terminal,
    such as `~/.claude-acme`. Offered only for harnesses with a single home var
    (Claude, Codex, Gemini, Grok). Verun never writes into a dir the user
    brought in, except worktree trust as today.
  - Cursor accounts skip both: they ask for an API key instead.
- **Log in:** opens an in-app terminal dialog that runs the harness's login
  command with the account env applied, e.g. `claude auth login` with
  `CLAUDE_CONFIG_DIR` set. When the PTY exits, Rust re-reads the identity and
  emits an event. **Log out** works the same way with the logout command.
- **One login terminal at a time.** Codex and OpenCode's ChatGPT method bind the
  same fixed port, so a second concurrent login cancels the first; serializing
  all logins is the simple rule.
- **Browser account hint.** A browser login signs in whichever account the
  browser is already using, so the dialog says so. The CLIs print the login
  URL, so the user can open it in the right browser profile.
- **Identity** (email, org, plan where available) is read from files on disk
  per harness, without spawning anything or touching credentials. Identity is
  refreshed when a login/logout terminal exits and when Settings opens. It is
  shown for Default too, so the user can see who Default is.
  - Claude: `<dir>/.claude.json` (Default: `~/.claude.json`) →
    `oauthAccount.emailAddress`, `organizationName`, `organizationUuid`, and
    `organizationType` (e.g. `claude_max`) for the plan. Logout clears
    `oauthAccount`, so its presence means signed in. An account whose env
    supplies an API key shows "API key" instead.
  - `claude auth status --json` works on 2.1.304 (`loggedIn`, `email`,
    `orgName`, `subscriptionType`), but T3 Code saw false "authenticated"
    results from it on older versions. Don't depend on it.
- **Claude login runs `claude auth login`** (claude.ai subscription, the
  default). It uses a browser callback on an ephemeral port, so concurrent
  logins don't collide, and its paste-code fallback needs a TTY, which the PTY
  provides. Console (API-billed) logins store a profile in `~/.config/anthropic`,
  which `CLAUDE_CONFIG_DIR` does not isolate, so API-billed accounts use an
  `ANTHROPIC_API_KEY` secret env var instead of a Console login.
- **New dirs start empty:** no settings, skills, plugins, MCP servers or trust.
  That's intended. The builder checks whether the first terminal-mode launch in
  a fresh dir shows Claude's onboarding wizard after `claude auth login`; if it
  does, mark onboarding complete in `<dir>/.claude.json` the same way
  `pre_trust_worktree` writes trust.
- **Directory validation:** normalize as above. Reject a dir already used by
  another account of the same harness. Reject the harness's standard home (for
  Claude, `~/.claude`): set explicitly it is a different login from Default
  (hashed keychain entry, `~/.claude/.claude.json`), which would be confusing.

### Binding accounts to projects and sessions

- Each project stores at most one account per harness. No entry means Default.
- A session's account is fixed when the session is created, in this order: the
  account picked when starting it, then the project's account for that harness,
  then Default. It never changes afterwards.
- Resume and fork within a task use the session's account. Forking to a new
  task keeps the source session's account, because the transcript lives in that
  account's dir.
- Changing a project's account only affects new sessions. Existing sessions,
  including every session created before this feature, stay on Default.
- Starting, resuming or sending to a session whose account is signed out or
  removed fails with a clear error and a fix action (Log in / Choose account).
  It never falls back.

### Where the account env is applied

One Rust function turns an account into its env: scrub that harness's
inherited vars, then add the home var and the account's env vars, with secrets
read from the keychain. Two combinations are built from it:

- **Project env:** the project's accounts for every harness except OpenCode,
  whose XDG vars would redirect unrelated tools. Harnesses on Default
  contribute nothing.
- **Session env:** the project env, with the session's own harness replaced by
  the session's account. This includes OpenCode's own vars for an OpenCode
  session. CLIs an agent runs itself (a Claude session running `codex exec`)
  therefore follow the project's accounts too.

They are applied at:

1. **Chat sessions (pipes):** `task.rs` `spawn_session_process` and
   `spawn_rpc_session`, with the session env.
2. **Claude terminal mode (PTY):** `claude_terminal.rs`, with the session env.
   The PTY runs `$SHELL -lic`, so a `CLAUDE_CONFIG_DIR` exported in the user's
   shell profile would override Verun's. The account env must win here, and
   secrets must not appear in process arguments.
3. **Title and task naming:** `generate_session_title` in `task.rs` always runs
   `claude -p --model haiku`, whatever the session's harness.
   - A Claude session uses its own account.
   - A non-Claude session on Default uses the project's Claude account, which
     is today's behavior when that is Default too.
   - A non-Claude session on an added account uses the project's Claude
     account only if that is an added account. Otherwise it skips the model
     call and uses a plain fallback title, such as the first words of the
     prompt, so client content never reaches a Default login.
4. **Cloud import:** `claude auth status` and the `--teleport` PTY in
   `cloud_import.rs`, with the project's Claude account.
5. **Task shells, setup/destroy hooks and the start command:** the project env,
   added alongside `worktree::verun_env_vars`. In plain interactive shells the
   user's profile can still override these vars; that is accepted.
6. **Version checks and model listing** keep the Default env.

### Claude paths that must follow the account

Every place that builds a Claude path from `$HOME` must instead resolve the
account's home. Do this through one shared "resolved Claude home" helper, not
by patching each `$HOME` call:

- `claude_jsonl::projects_dir` / `session_path`, which cover transcript reads,
  terminal tailing, fresh-session discovery, forks and cloud-import writes.
- `claude_terminal::pre_trust_worktree`: write `<dir>/.claude.json` for a custom
  dir, `~/.claude.json` for Default.
- `policy::is_within_claude_home`: auto-allow reads under the session's
  account dir.
- Skill discovery (`list_agent_skills` → `Agent::discover_skills`): scan the
  session's account home. The IPC takes the account.

Verun reads nothing from the other harnesses' homes today (no `CODEX_HOME` or
similar references), so the env is enough for them. The builder re-checks this.

**Adjacent fix, same helper:** Claude names a transcript dir
`<home>/projects/<slug>`, where the slug is `realpath(cwd)` with every
non-alphanumeric character replaced by `-`. Paths over 200 characters keep the
first 200 characters, then `-` plus a base36 hash. Verun's `encode_cwd` skips
the realpath and the truncation. Fix it while moving the helper, since the
resolved-home helper has to compute exactly the path Claude does.

### Rate limits

The `rate-limit-info` event carries the session's account. The frontend keeps
one entry per account, and the composer shows the active session's account.
Today it is a single global signal, which would mix accounts.

## UI

Use existing Verun components and patterns; nothing new is invented.

- **Settings → Accounts:** a new sidebar section next to General and
  Appearance. Accounts are grouped by installed harness. Each card shows the
  label, color, dir and identity (or "Signed out"), with Log in / Log out, Edit
  (label, color, env vars with a secret toggle) and Remove. Each harness also
  shows a read-only Default row with its identity.
- **Project settings → Accounts:** one select per harness that has at least one
  added account. Options are Default plus that harness's accounts.
- **Session pickers** (`NewSessionMenu`, `ModelPicker` via
  `TaskModelPickerHost`, `HarnessModelPicker` in `NewTaskView`): as in T3 Code,
  each added account appears as its own row under its harness (label + color
  dot). The project's account is preselected.
- **Session indicator:** a color dot and label next to the agent icon on
  session tabs when a session is not on Default, with a tooltip showing the
  email.
- **Errors:** a signed-out or removed account shows an error with Log in /
  Choose account.
- **Detached task windows** must get the same picker and indicator changes as
  the main window.

### Removing an account

- Confirm first.
- Blocked while any project uses the account; the dialog lists those projects.
- Sessions bound to it keep their history viewable; sending or resuming fails
  with the removed-account error.
- If Verun created the dir, offer to delete it along with the account's
  keychain secrets. Never delete a dir the user brought in.

## Data model

New migration:

- `accounts`: `id`, `agent_type`, `label`, `color`, `config_dir` (nullable),
  `managed_dir` (Verun created it), `env` (JSON list of `{key, value?, secret}`;
  secret values are not stored here), identity cache (`email`, `org_name`,
  `plan`), `removed_at`, `created_at`.
- `project_accounts`: `(project_id, agent_type) → account_id`.
- `sessions.account_id`: nullable, NULL means Default.

## IPC

Typed wrappers in `src/lib/ipc.ts` for: list / create / update / remove
accounts, start login and logout (returns a terminal id), refresh identity, and
set a project's account. `create_task` and `create_session` take an optional
account id. The fork commands don't: a fork always keeps its source session's
account, and transcripts never move between account homes. A new event signals
identity changes.

Verun's MCP tools stay allowed across accounts (decided by the user): an agent
on one account may read another task's output, message another session, or
spawn tasks and sessions anywhere, because these calls only happen when the
user asks an agent to make them. Sessions created through `verun_spawn_task` /
`verun_create_session` get the target project's account, like any new session.

## Testing (TDD)

Rust:

- Account → env resolution (home var, env vars, secrets through a mockable
  keychain layer).
- Session account precedence: picked, then project, then Default.
- Path resolution for Default vs a custom dir: transcripts, `.claude.json`,
  skills.
- `pre_trust_worktree` writes the right file.
- Identity parsing from fixture files per harness.
- Directory validation: `~` expansion, duplicates, standard home rejected.
- Removal blocked while a project uses the account.
- Each spawn site includes the account env.
- Signed-out or removed account errors instead of falling back.

Frontend:

- Pickers list accounts and preselect the project's account.
- Settings account add / edit / remove flows.
- Rate-limit state keyed by account.

End to end in `pnpm tauri dev`:

- Add a second Claude account and log in through the dialog.
- Bind a project to it and start both a chat session and a terminal session.
  `/status` shows the bound email.
- Resume, fork and title generation stay on that account.
- `claude` typed in a task shell uses the account.
- A project left on Default behaves exactly as before.

## Left to the builder

- Module layout (e.g. a new `accounts.rs`), trait method names, migration shape.
- Keychain crate.
- How pickers render account rows and where the session indicator sits.
- Whether the identity cache lives in the DB or in memory.
- How the account env wins over the shell profile in terminal mode without
  putting secrets in arguments.

## Calls made during design

The user decided: isolated dirs like T3 Code, one default account per project
per harness, a generic per-harness model, the login terminal, per-session
override, shells following the project, no mid-session switching, secrets in
the keychain, and cross-account MCP calls allowed. These were the designer's
calls, open to veto:

- Cursor's added accounts are API-key only.
- Verun-created dirs live in the app data dir, so dev and prod builds have
  separate accounts, like their separate databases.
- "Existing directory" only for single-home-var harnesses, and Verun never
  writes into such a dir apart from worktree trust.
- The harness's standard home (e.g. `~/.claude`) is rejected as an account dir.
- One login terminal at a time.
- Inherited auth vars are scrubbed for added accounts. Default's env is
  untouched.
- The session env carries the project's accounts for other harnesses, so CLIs
  an agent runs itself follow the project.
- OpenCode stays out of the project env.
- Title naming falls back to a plain title rather than a Default Claude login.
- Identity is read from disk, not from `auth status`.
- API-billed Claude accounts use `ANTHROPIC_API_KEY`.
- Removing an account is blocked while a project uses it. Bound sessions become
  read-only.
- `encode_cwd` gets its realpath and truncation fix as part of the helper move.
- macOS-only verification, built on cross-platform primitives.

## Definition of done

As in `CLAUDE.md`: `make check` green, clippy clean, no TS errors, works end
to end in `pnpm tauri dev`, committed, CHANGELOG / README / ROADMAP updated.

## References

- T3 Code `ClaudeHome.ts` (CLAUDE_CONFIG_DIR per instance):
  https://github.com/pingdotgg/t3code/blob/e9a5974379943e471aa340e683b47cc89db60015/apps/server/src/provider/Drivers/ClaudeHome.ts
- T3 Code Claude provider docs:
  https://github.com/pingdotgg/t3code/blob/e9a5974379943e471aa340e683b47cc89db60015/docs/user/providers-claude.md
- HOME → CLAUDE_CONFIG_DIR breakage: https://github.com/pingdotgg/t3code/issues/4696
- `auth status` unreliable: https://github.com/pingdotgg/t3code/pull/7691
- Claude Code, multiple accounts:
  https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts
- Claude per-dir keychain hashing: https://github.com/anthropics/claude-code/issues/20553
- Codex home resolution:
  https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/utils/home-dir/src/lib.rs#L13-L63
- Codex login port collision: https://github.com/openai/codex/issues/22048
- Cursor CLI auth: https://cursor.com/docs/cli/reference/authentication
- Gemini `GEMINI_CLI_HOME`:
  https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/utils/paths.ts#L17-L28
- Grok Build home dirs:
  https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-dirs/src/lib.rs#L49-L92
- OpenCode: https://github.com/anomalyco/opencode
