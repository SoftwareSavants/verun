//! Login and logout terminals: a PTY that runs a harness's own sign-in or
//! sign-out command (`claude auth login`) on an account's env, one at a time.
//!
//! The CLI does the signing in, the way it wants to (a link for the browser, a
//! prompt) and writes what it learns into the account's folder. Verun gives it
//! the env of the account and nothing else. When the terminal ends it tells
//! every window who is signed in now, because the CLI changed its files behind
//! Verun's back.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Listener, Manager};

use super::env::{account_env, profile_of, pty_command_and_env, EnvPatch};
use super::manage::{account_user_home, publish_accounts, Turn};
use super::secrets::{SecretStore, Secrets};
use super::service::{blocking, invalid, live, load_account};
use super::AccountError;
use crate::agent::{Agent, AgentKind};
use crate::claude_terminal::shell_quote;
use crate::db::Account;
use crate::pty::{self, ActivePtyMap};

/// The login or logout terminal that is open: the id of its PTY. Only one at a
/// time, as two would fight over the browser and the CLI's files. Registered
/// as Tauri managed state.
///
/// From `claim` until `record` it holds `STARTING` instead: the terminal is
/// being spawned and has no id yet.
#[derive(Default)]
pub struct LoginGuard(pub Mutex<Option<String>>);

/// What the guard holds while a terminal is being spawned. Terminal ids are
/// UUIDs, so no real one is empty.
const STARTING: &str = "";

fn state(guard: &LoginGuard) -> MutexGuard<'_, Option<String>> {
    // It holds a plain `Option<String>`, which is valid whatever panicked while
    // it was locked.
    guard.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a terminal does for an account.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AccountTerminalAction {
    Login,
    Logout,
}

impl AccountTerminalAction {
    /// The action as a word in names and messages.
    fn verb(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Logout => "logout",
        }
    }
}

/// A terminal that was started, as the frontend gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTerminal {
    /// The PTY, shown with the usual PTY commands and events.
    pub terminal_id: String,
    /// What the user does in the terminal when the command alone does not
    /// finish the job (the harness's `login_hint` or `logout_hint`).
    pub hint: Option<String>,
}

/// The shell command of a terminal: the CLI replaces the shell (`exec`), so the
/// PTY ends when the CLI does, and every arg is one word whatever is in it.
pub fn terminal_command(cli_binary: &str, args: &[&str]) -> String {
    let mut command = format!("exec {cli_binary}");
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

// -- The one-at-a-time guard --

/// Takes the login terminal for a start that is about to spawn it, or `Busy` if
/// another one is open or still being started. `terminal_alive` says whether a
/// terminal id is a PTY of Verun's that is still running. One that is not (it
/// ended, or it was closed) is stale and does not count: its exit event may
/// never come, and the guard would hold it for good.
///
/// The caller spawns the terminal and then `record`s its id, or `release`s the
/// claim if the spawn failed. Until then the claim keeps a second start out.
pub fn claim(
    guard: &LoginGuard,
    terminal_alive: impl Fn(&str) -> bool,
) -> Result<(), AccountError> {
    let mut active = state(guard);
    let busy = match active.as_deref() {
        None => false,
        Some(STARTING) => true,
        Some(terminal_id) => terminal_alive(terminal_id),
    };
    if busy {
        return Err(AccountError::Busy);
    }
    *active = Some(STARTING.to_string());
    Ok(())
}

/// The claimed start spawned `terminal_id`, which holds the guard now.
fn record(guard: &LoginGuard, terminal_id: &str) {
    *state(guard) = Some(terminal_id.to_string());
}

/// The claimed start failed: nothing holds the guard.
fn release(guard: &LoginGuard) {
    *state(guard) = None;
}

/// `terminal_id` ended. Frees the guard if that terminal held it, and says
/// whether it did. A start in flight has no id yet, so no terminal that ends can
/// be it.
fn finish(guard: &LoginGuard, terminal_id: &str) -> bool {
    let mut active = state(guard);
    if terminal_id == STARTING || active.as_deref() != Some(terminal_id) {
        return false;
    }
    *active = None;
    true
}

/// The claim a start holds from `claim` until it has recorded its terminal.
/// Dropping it before then frees the guard again, whether the spawn failed or
/// the start was dropped while it waited for the spawn: a claim that nothing
/// is left to record would hold the guard for good.
struct Claimed<'a> {
    /// `None` once the terminal is recorded: there is nothing left to free.
    guard: Option<&'a LoginGuard>,
}

impl Claimed<'_> {
    /// The start spawned `terminal_id`, which holds the guard now.
    fn record(mut self, terminal_id: &str) {
        if let Some(guard) = self.guard.take() {
            record(guard, terminal_id);
        }
    }
}

impl Drop for Claimed<'_> {
    fn drop(&mut self) {
        if let Some(guard) = self.guard.take() {
            release(guard);
        }
    }
}

/// Runs `spawn` as the login terminal: claims the guard first, so a second
/// start is refused (`Busy`) while this one is alive or still spawning, and
/// then records the id `spawn` returns. A spawn that fails frees the guard
/// again, and so does a start that is dropped before its spawn is done.
async fn start_guarded<Fut>(
    guard: &LoginGuard,
    terminal_alive: impl Fn(&str) -> bool,
    spawn: impl FnOnce() -> Fut,
) -> Result<String, AccountError>
where
    Fut: Future<Output = Result<String, AccountError>>,
{
    claim(guard, terminal_alive)?;
    let claimed = Claimed { guard: Some(guard) };
    let terminal_id = spawn().await?;
    claimed.record(&terminal_id);
    Ok(terminal_id)
}

// -- What the terminal runs --

/// What `spawn_pty` is given for a terminal. `env` holds the account's secret
/// values, so this has no `Debug` and nothing logs it.
struct TerminalLaunch {
    /// The command for the shell. With an added account's env it is only the
    /// exec of the sh that applies it (see `pty_command_and_env`).
    command: String,
    env: EnvPatch,
    /// The name on the terminal's tab.
    name: String,
    /// The harness's hint for the action, for the user to read beside it.
    hint: Option<String>,
}

/// The launch of `action` on `account`, an account of `agent`'s harness.
///
/// The env is the account's own (see `account_env`) and nothing of any
/// project's: a login is the harness's, not a project's work. There is no
/// sign-in check, because signing in is the point. The command goes through
/// `pty_command_and_env`, so the user's profile can't override the account and
/// no value is in any argument. Reads the keychain, so async callers go
/// through `spawn_blocking`.
fn build_launch(
    agent: &dyn Agent,
    account: &Account,
    action: AccountTerminalAction,
    secrets: &dyn SecretStore,
) -> Result<TerminalLaunch, AccountError> {
    let profile = profile_of(agent)?;
    let (args, hint) = match action {
        AccountTerminalAction::Login => (profile.login_args, profile.login_hint),
        AccountTerminalAction::Logout => (profile.logout_args, profile.logout_hint),
    };
    let args = args.ok_or_else(|| {
        invalid(format!(
            "{} has no {} command.",
            agent.display_name(),
            action.verb()
        ))
    })?;
    let env = account_env(agent, account, secrets)?;
    let (command, env) = pty_command_and_env(
        &terminal_command(agent.cli_binary(), args),
        Vec::new(),
        &env,
    );
    Ok(TerminalLaunch {
        command,
        env,
        name: format!("{} {}", account.label, action.verb()),
        hint: hint.map(str::to_string),
    })
}

/// `build_launch` for the live account `account_id`: `Missing` or `Removed`
/// when there is none to run on. The keychain is read in `spawn_blocking`.
async fn load_launch(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    account_id: &str,
    action: AccountTerminalAction,
) -> Result<TerminalLaunch, AccountError> {
    let account = live(load_account(pool, account_id).await?)?;
    blocking(move || {
        let agent = AgentKind::parse(&account.agent_type).implementation();
        build_launch(agent.as_ref(), &account, action, secrets.as_ref())
    })
    .await
}

/// Starts the login or logout terminal of the account `account_id`: a PTY of
/// `rows` x `cols` in the user's home folder that runs the harness's command on
/// the account's env, and the harness's hint for it.
///
/// `Busy` while another login or logout terminal is running. Everything that can
/// fail for a reason of the account (it is gone, a secret can't be read, the
/// harness lacks the command) fails before the guard is claimed or anything is
/// spawned.
pub async fn start(
    app: &AppHandle,
    account_id: &str,
    action: AccountTerminalAction,
    rows: u16,
    cols: u16,
) -> Result<AccountTerminal, AccountError> {
    let user_home = account_user_home()?;
    let secrets = app.state::<Secrets>().0.clone();
    let TerminalLaunch {
        command,
        env,
        name,
        hint,
    } = load_launch(
        app.state::<SqlitePool>().inner(),
        secrets,
        account_id,
        action,
    )
    .await?;
    let guard = app.state::<LoginGuard>();
    let pty_map = app.state::<ActivePtyMap>();

    let terminal_id = start_guarded(
        &guard,
        |terminal_id| pty::is_running(&pty_map, terminal_id),
        || {
            let (app, map) = (app.clone(), pty_map.inner().clone());
            let task_id = format!("account-{account_id}");
            let cwd = user_home.to_string_lossy().into_owned();
            blocking(move || {
                pty::spawn_pty(
                    app,
                    map,
                    task_id,
                    cwd,
                    rows,
                    cols,
                    Some(command),
                    env,
                    /* direct_command = */ true,
                    Some(name),
                    /* is_start_command = */ false,
                    None,
                )
                .map(|spawned| spawned.terminal_id)
                .map_err(invalid)
            })
        },
    )
    .await?;

    // A process that is over already (the CLI is not installed, say) may have
    // ended before its id was recorded, and then the exit listener found no
    // terminal to match it with. Look again now that the guard knows it.
    if !pty::is_running(&pty_map, &terminal_id) {
        terminal_ended(app, &terminal_id);
    }
    Ok(AccountTerminal { terminal_id, hint })
}

// -- When the terminal ends --

/// The id of the terminal in the payload of a `pty-exited` event, which is
/// `{"terminalId": ..., "exitCode": ...}`.
pub fn exited_terminal_id(payload: &str) -> Option<String> {
    // Not a struct with a derived `Deserialize`: that would also read the
    // array `["t1"]`.
    let payload: serde_json::Value = serde_json::from_str(payload).ok()?;
    payload.get("terminalId")?.as_str().map(str::to_string)
}

/// Frees the guard when the login terminal ends and sends every window the
/// accounts as they are now: the CLI wrote the sign-in or sign-out into the
/// account's files, and nothing else tells Verun. Registered once at startup.
/// An event for any other PTY is ignored.
pub fn install_exit_listener(app: &AppHandle) {
    let handle = app.clone();
    app.listen("pty-exited", move |event| {
        if let Some(terminal_id) = exited_terminal_id(event.payload()) {
            terminal_ended(&handle, &terminal_id);
        }
    });
}

/// The PTY `terminal_id` ended. If it was the login terminal, the guard is free
/// and every window is sent a fresh snapshot.
///
/// The exit event and a start that finds its process over already both come
/// here. Whichever comes first does the work, as it is the one that finds the id
/// in the guard. An event for a terminal that a later start has replaced in the
/// guard finds nothing to free and is ignored.
///
/// It runs on the thread that emitted the event, which must not wait: the
/// snapshot is built on a task of its own.
fn terminal_ended(app: &AppHandle, terminal_id: &str) {
    if !finish(&app.state::<LoginGuard>(), terminal_id) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { publish_fresh_accounts(&app).await });
}

/// Sends every window the accounts as they are on disk now. Like any other
/// change to the accounts it takes the turn first and publishes while holding
/// it, so the snapshots reach the windows in the order they were taken.
async fn publish_fresh_accounts(app: &AppHandle) {
    let user_home = match account_user_home() {
        Ok(user_home) => user_home,
        Err(e) => {
            eprintln!(
                "[verun][accounts] couldn't send the accounts after a login terminal ended: {e}"
            );
            return;
        }
    };
    let turn = Turn::take().await;
    if let Err(e) =
        publish_accounts(&turn, app, app.state::<SqlitePool>().inner(), &user_home).await
    {
        eprintln!("[verun][accounts] couldn't send the accounts after a login terminal ended: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::env::{run_in_sh, ACCOUNT_SCRIPT_VAR};
    use crate::accounts::secrets::{LockedKeychain, MemorySecretStore};
    use crate::accounts::service::check_usable;
    use crate::accounts::service::tests::{acme, secret_var, ThreadSpy};
    use crate::agent::{AccountProfile, Claude, InputMode, ModelOption, SessionArgs};
    use crate::db::tests::{
        make_account, mark_account_removed_confirmed, test_pool, upsert_account_confirmed,
    };
    use crate::pty_output::OutputBuffer;
    use serde_json::json;
    use std::cell::RefCell;
    use std::path::Path;
    use tempfile::TempDir;

    // -- Fixtures --

    /// A guard that holds `id`, as after that terminal was started.
    fn holding(id: &str) -> LoginGuard {
        LoginGuard(Mutex::new(Some(id.to_string())))
    }

    /// What the guard holds.
    fn held(guard: &LoginGuard) -> Option<String> {
        guard.0.lock().unwrap().clone()
    }

    /// The liveness check for a guard that holds no terminal: nothing to ask.
    fn nothing_to_ask(id: &str) -> bool {
        panic!("asked about {id}, but the guard holds no terminal")
    }

    fn no_secrets() -> Arc<dyn SecretStore> {
        Arc::new(MemorySecretStore::default())
    }

    /// The live Claude account Acme (a1) with its home in `dir`.
    fn acme_in(dir: &str) -> Account {
        let mut account = make_account("a1", 1000);
        account.label = "Acme".into();
        account.config_dir = dir.into();
        account
    }

    /// The launch of `action` for `account` on `agent`, with no secrets in the
    /// keychain.
    fn launch_of(
        agent: &dyn Agent,
        account: &Account,
        action: AccountTerminalAction,
    ) -> TerminalLaunch {
        build_launch(agent, account, action, &MemorySecretStore::default()).unwrap()
    }

    /// The script the account's env travels in. It holds the account's values,
    /// so an assertion on it names vars and never prints it.
    fn script_of(env: &EnvPatch) -> &str {
        env.set
            .iter()
            .find(|(key, _)| key == ACCOUNT_SCRIPT_VAR)
            .map(|(_, script)| script.as_str())
            .expect("the script var is set")
    }

    /// Claude's account support with a program of the test's choosing behind
    /// it and the login and logout commands it is given. The home var, the
    /// scrub list and the rest are Claude's, so the env it gets is the one a
    /// real account gets. Without a profile it stands for a harness with no
    /// account support.
    struct StubCli {
        binary: &'static str,
        profile: Option<AccountProfile>,
    }

    impl StubCli {
        fn running(
            binary: &'static str,
            login_args: Option<&'static [&'static str]>,
            logout_args: Option<&'static [&'static str]>,
        ) -> Self {
            Self {
                binary,
                profile: Some(AccountProfile {
                    login_args,
                    logout_args,
                    login_hint: Some("Sign in, then type /quit."),
                    logout_hint: Some("Type /signout."),
                    ..Claude.account_profile().unwrap()
                }),
            }
        }

        fn without_accounts() -> Self {
            Self {
                binary: "stub",
                profile: None,
            }
        }
    }

    impl Agent for StubCli {
        fn kind(&self) -> AgentKind {
            AgentKind::Claude
        }
        fn display_name(&self) -> &'static str {
            "Stub CLI"
        }
        fn cli_binary(&self) -> &'static str {
            self.binary
        }
        fn input_mode(&self) -> InputMode {
            InputMode::PositionalOrStdin
        }
        fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
            Vec::new()
        }
        fn install_hint(&self) -> &'static str {
            ""
        }
        fn available_models(&self) -> Vec<ModelOption> {
            Vec::new()
        }
        fn account_profile(&self) -> Option<AccountProfile> {
            self.profile
        }
        fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
            Claude.account_home_env(dir)
        }
    }

    // -- The command --

    #[test]
    fn terminal_command_quotes_args() {
        assert_eq!(
            terminal_command("claude", &["auth", "login"]),
            "exec claude 'auth' 'login'"
        );
        assert_eq!(terminal_command("gemini", &[]), "exec gemini");
        // An arg is one word to the shell, whatever is in it.
        assert_eq!(
            terminal_command("x", &["it's", "two words", "a;b"]),
            r"exec x 'it'\''s' 'two words' 'a;b'"
        );
    }

    #[test]
    fn the_action_reads_what_the_frontend_sends() {
        for (input, expected) in [
            ("login", AccountTerminalAction::Login),
            ("logout", AccountTerminalAction::Logout),
        ] {
            let parsed: AccountTerminalAction = serde_json::from_value(json!(input))
                .unwrap_or_else(|e| panic!("not an action ({e}): {input}"));
            assert_eq!(parsed, expected, "input: {input}");
        }
        assert!(serde_json::from_value::<AccountTerminalAction>(json!("Login")).is_err());
    }

    #[test]
    fn the_terminal_serializes_as_the_frontend_reads_it() {
        let with_hint = AccountTerminal {
            terminal_id: "t1".into(),
            hint: Some("Sign in, then type /quit.".into()),
        };
        let bare = AccountTerminal {
            terminal_id: "t1".into(),
            hint: None,
        };

        assert_eq!(
            serde_json::to_value(&with_hint).unwrap(),
            json!({"terminalId": "t1", "hint": "Sign in, then type /quit."})
        );
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!({"terminalId": "t1", "hint": null})
        );
    }

    // -- Building the launch --

    #[test]
    fn login_runs_the_login_command_on_the_accounts_env() {
        let launch = launch_of(&Claude, &acme_in("/acc/a1"), AccountTerminalAction::Login);

        // The login shell is only asked to exec the sh that applies the
        // account's env: no value is in any argument.
        assert_eq!(
            launch.command,
            r#"exec /bin/sh -c 'eval "$VERUN_ACCOUNT_SCRIPT"'"#
        );
        let script = script_of(&launch.env);
        let unset = script.split(';').next().unwrap();
        for var in Claude.account_profile().unwrap().scrub_vars {
            assert!(
                unset.split_whitespace().any(|word| word == *var),
                "{var} is not unset"
            );
        }
        assert!(script.contains("export CLAUDE_CONFIG_DIR='/acc/a1'"));
        assert!(
            script.ends_with("; exec claude 'auth' 'login'"),
            "the login command is not what the script ends with"
        );
        // The env is the account's alone: a login has none of Verun's own
        // vars, and the scrub list travels inside the script.
        assert_eq!(launch.env.set.len(), 1);
        assert!(launch.env.remove.is_empty());
        assert_eq!(launch.name, "Acme login");
        assert_eq!(launch.hint, None);
    }

    #[test]
    fn logout_runs_the_logout_command() {
        let launch = launch_of(&Claude, &acme_in("/acc/a1"), AccountTerminalAction::Logout);

        let script = script_of(&launch.env);
        assert!(script.contains("export CLAUDE_CONFIG_DIR='/acc/a1'"));
        assert!(
            script.ends_with("; exec claude 'auth' 'logout'"),
            "the logout command is not what the script ends with"
        );
        assert_eq!(launch.name, "Acme logout");
    }

    #[test]
    fn the_hint_follows_the_action() {
        let cli = StubCli::running("stub", Some(&[]), Some(&[]));
        let account = acme_in("/acc/a1");

        let login = launch_of(&cli, &account, AccountTerminalAction::Login);
        let logout = launch_of(&cli, &account, AccountTerminalAction::Logout);

        assert_eq!(login.hint.as_deref(), Some("Sign in, then type /quit."));
        assert_eq!(logout.hint.as_deref(), Some("Type /signout."));
    }

    #[test]
    fn a_bare_cli_runs_without_args() {
        // `Some(&[])`: the harness signs in from its own start screen.
        let cli = StubCli::running("stub", Some(&[]), None);

        let launch = launch_of(&cli, &acme_in("/acc/a1"), AccountTerminalAction::Login);

        assert!(script_of(&launch.env).ends_with("; exec stub"));
    }

    #[test]
    fn an_action_the_harness_lacks_is_invalid() {
        let cli = StubCli::running("stub", Some(&["login"]), None);
        let account = acme_in("/acc/a1");

        let refused = build_launch(
            &cli,
            &account,
            AccountTerminalAction::Logout,
            &MemorySecretStore::default(),
        );

        match refused {
            Err(AccountError::Invalid { message }) => {
                assert_eq!(message, "Stub CLI has no logout command.")
            }
            Err(other) => panic!("expected an Invalid error, got {other:?}"),
            Ok(_) => panic!("a harness with no logout command got a logout terminal"),
        }
        // The command it does have is not affected.
        assert!(build_launch(
            &cli,
            &account,
            AccountTerminalAction::Login,
            &MemorySecretStore::default()
        )
        .is_ok());
    }

    #[test]
    fn a_harness_without_account_support_is_invalid() {
        let refused = build_launch(
            &StubCli::without_accounts(),
            &acme_in("/acc/a1"),
            AccountTerminalAction::Login,
            &MemorySecretStore::default(),
        );

        match refused {
            Err(AccountError::Invalid { message }) => {
                assert_eq!(message, "Stub CLI does not support multiple accounts")
            }
            Err(other) => panic!("expected an Invalid error, got {other:?}"),
            Ok(_) => panic!("a harness with no account support got a terminal"),
        }
    }

    #[test]
    fn a_secret_stays_out_of_the_command_and_reaches_the_env() {
        let store = MemorySecretStore::default();
        store
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-secret")
            .unwrap();
        let mut account = acme_in("/acc/a1");
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];

        let launch = build_launch(&Claude, &account, AccountTerminalAction::Login, &store).unwrap();

        // The assertions say nothing of the value when they fail.
        assert!(
            !launch.command.contains("sk-ant-secret"),
            "the key is in the command"
        );
        assert!(
            script_of(&launch.env).contains("sk-ant-secret"),
            "the key never reached the env"
        );
    }

    #[test]
    fn a_keychain_that_refuses_fails_the_launch() {
        let mut account = acme_in("/acc/a1");
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];

        let refused = build_launch(
            &Claude,
            &account,
            AccountTerminalAction::Login,
            &LockedKeychain,
        );

        assert!(
            matches!(refused, Err(AccountError::Secret { .. })),
            "the terminal started without the account's key"
        );
    }

    // -- Running the launch --

    #[cfg(unix)]
    #[test]
    fn the_cli_gets_each_arg_as_one_word() {
        let cli = StubCli::running("/usr/bin/printf", Some(&["%s|", "it's", "two words"]), None);
        let launch = launch_of(&cli, &acme_in("/acc/a1"), AccountTerminalAction::Login);

        let printed = run_in_sh("", &launch.command, &launch.env);

        assert_eq!(printed, "it's|two words|");
    }

    #[cfg(unix)]
    #[test]
    fn the_cli_gets_the_accounts_env_whatever_the_profile_exports() {
        // `env` stands in for the CLI and prints what it inherited.
        let cli = StubCli::running("/usr/bin/env", Some(&[]), None);
        let launch = launch_of(
            &cli,
            &acme_in("/x/Client Accounts/o'brien"),
            AccountTerminalAction::Login,
        );

        // The user's profile runs first and exports a home of its own, and the
        // shell has the ANTHROPIC_API_KEY that stands for what Verun inherited.
        let printed = run_in_sh(
            "export CLAUDE_CONFIG_DIR=/from-profile; ",
            &launch.command,
            &launch.env,
        );

        // The messages name vars and never print the env the CLI got.
        let lines: Vec<&str> = printed.lines().collect();
        assert!(
            lines.contains(&"CLAUDE_CONFIG_DIR=/x/Client Accounts/o'brien"),
            "CLAUDE_CONFIG_DIR is not the account's folder"
        );
        for gone in ["ANTHROPIC_API_KEY", "VERUN_ACCOUNT_SCRIPT"] {
            assert!(
                !lines
                    .iter()
                    .any(|line| line.starts_with(&format!("{gone}="))),
                "{gone} reached the CLI"
            );
        }
    }

    // -- Loading the launch --

    #[tokio::test]
    async fn an_account_nobody_is_signed_in_to_still_gets_a_terminal() {
        let pool = test_pool().await;
        // An empty home: nobody is signed in, which is why the user is here.
        let dir = TempDir::new().unwrap();
        let account = acme("a1", &dir);
        assert!(
            matches!(
                check_usable(&account, &Claude),
                Err(AccountError::SignedOut { .. })
            ),
            "a session would be refused on this account"
        );
        upsert_account_confirmed(&pool, account).await.unwrap();

        let launch = load_launch(&pool, no_secrets(), "a1", AccountTerminalAction::Login)
            .await
            .unwrap();

        assert_eq!(launch.name, "Acme login");
        assert!(script_of(&launch.env).contains(&format!(
            "export CLAUDE_CONFIG_DIR='{}'",
            dir.path().display()
        )));
    }

    #[tokio::test]
    async fn an_unknown_account_gets_no_terminal() {
        let pool = test_pool().await;

        let refused = load_launch(&pool, no_secrets(), "nope", AccountTerminalAction::Login).await;

        assert_eq!(
            refused.err(),
            Some(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn a_removed_account_gets_no_terminal() {
        let pool = test_pool().await;
        upsert_account_confirmed(&pool, make_account("a1", 1000))
            .await
            .unwrap();
        mark_account_removed_confirmed(&pool, "a1", 2000)
            .await
            .unwrap();

        let refused = load_launch(&pool, no_secrets(), "a1", AccountTerminalAction::Logout).await;

        assert_eq!(
            refused.err(),
            Some(AccountError::Removed {
                account_id: "a1".into(),
                label: "Account a1".into()
            })
        );
    }

    #[tokio::test]
    async fn the_keychain_is_read_off_the_calling_thread() {
        let pool = test_pool().await;
        let dir = TempDir::new().unwrap();
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        let spy = Arc::new(ThreadSpy::default());
        spy.set("a1", "ANTHROPIC_API_KEY", "sk-ant-one").unwrap();

        let launch = load_launch(&pool, spy.clone(), "a1", AccountTerminalAction::Login).await;

        assert!(launch.is_ok());
        // The test runs on a current-thread runtime, so a keychain call made
        // inline would be recorded on this very thread.
        let reads = spy.reads.lock().unwrap();
        assert!(!reads.is_empty(), "the secret was never read");
        assert!(
            !reads.contains(&std::thread::current().id()),
            "the keychain was read on the async caller's thread"
        );
    }

    // -- The one-at-a-time guard --

    #[test]
    fn claim_takes_a_free_guard() {
        let guard = LoginGuard::default();

        assert_eq!(claim(&guard, nothing_to_ask), Ok(()));
    }

    #[test]
    fn claim_rejects_while_terminal_alive() {
        let guard = holding("t1");

        assert_eq!(claim(&guard, |id| id == "t1"), Err(AccountError::Busy));
        // Refused, so the terminal that is open keeps the guard.
        assert_eq!(held(&guard), Some("t1".to_string()));
    }

    #[test]
    fn claim_frees_stale_terminal() {
        // t1 ended, or was closed, without anyone seeing it: nothing runs
        // behind its id.
        let guard = holding("t1");
        let asked = RefCell::new(Vec::new());

        let claimed = claim(&guard, |id| {
            asked.borrow_mut().push(id.to_string());
            false
        });

        assert_eq!(claimed, Ok(()));
        // It is the terminal the guard holds that was looked up.
        assert_eq!(*asked.borrow(), ["t1"]);
    }

    #[test]
    fn a_claim_holds_the_guard_until_it_is_released() {
        let guard = LoginGuard::default();
        claim(&guard, nothing_to_ask).unwrap();

        // The terminal is still being spawned: there is no PTY to ask about,
        // and a second one may not start meanwhile.
        assert_eq!(claim(&guard, |_| false), Err(AccountError::Busy));
        release(&guard);

        assert_eq!(claim(&guard, nothing_to_ask), Ok(()));
    }

    #[test]
    fn record_hands_the_claim_to_the_terminal() {
        let guard = LoginGuard::default();
        claim(&guard, nothing_to_ask).unwrap();

        record(&guard, "t1");

        assert_eq!(held(&guard), Some("t1".to_string()));
        assert_eq!(claim(&guard, |id| id == "t1"), Err(AccountError::Busy));
        // Once t1 is gone the next one may go.
        assert_eq!(claim(&guard, |_| false), Ok(()));
    }

    #[test]
    fn finish_frees_only_the_guarded_terminal() {
        let guard = holding("t1");

        assert!(!finish(&guard, "t2"), "another terminal ended");
        assert_eq!(held(&guard), Some("t1".to_string()));
        assert!(finish(&guard, "t1"));
        assert_eq!(held(&guard), None);
        assert!(!finish(&guard, "t1"), "an exit is handled once");
    }

    #[test]
    fn finish_leaves_a_start_in_flight_alone() {
        let guard = LoginGuard::default();
        claim(&guard, nothing_to_ask).unwrap();

        // Some other terminal ended while the new one has no id yet.
        assert!(!finish(&guard, "t0"));
        // An empty id is no terminal, whatever the guard holds meanwhile.
        assert!(!finish(&guard, ""));

        assert_eq!(claim(&guard, |_| false), Err(AccountError::Busy));
    }

    #[test]
    fn a_terminal_that_ends_before_it_is_recorded_is_freed_once_it_is() {
        let guard = LoginGuard::default();
        claim(&guard, nothing_to_ask).unwrap();

        // Its exit comes first, while the start has no id to match it with...
        assert!(!finish(&guard, "t1"));
        record(&guard, "t1");
        // ... so the start asks again once the id is recorded.
        assert!(finish(&guard, "t1"));

        assert_eq!(claim(&guard, nothing_to_ask), Ok(()));
    }

    #[test]
    fn an_exit_that_comes_after_a_new_start_is_ignored() {
        // t1 is over and a new start took its place in the guard before t1's
        // exit event was sent.
        let guard = holding("t1");
        claim(&guard, |_| false).unwrap();
        record(&guard, "t2");

        assert!(!finish(&guard, "t1"), "the old exit freed the new terminal");

        assert_eq!(held(&guard), Some("t2".to_string()));
    }

    #[test]
    fn a_login_that_ended_with_its_exit_event_held_back_does_not_lock_out_the_next() {
        let map = pty::new_active_pty_map();
        let output = Arc::new(OutputBuffer::default());
        pty::insert_test_pty(&map, "t1", Arc::clone(&output));
        let guard = holding("t1");

        // While the CLI runs, it holds the guard.
        assert_eq!(
            claim(&guard, |id| pty::is_running(&map, id)),
            Err(AccountError::Busy)
        );

        // The page showing it is reloaded while it waits for the browser, so
        // the output it was sent is never acknowledged. The CLI ends, and its
        // exit event, which waits for that acknowledgement, never comes.
        output.attach("main", 0);
        output.push("Open this link to sign in");
        output.finish(Some(0));
        assert_eq!(output.take_exit(), None, "the exit event was not held back");

        assert_eq!(claim(&guard, |id| pty::is_running(&map, id)), Ok(()));
    }

    // -- Starting under the guard --

    #[tokio::test]
    async fn a_started_terminal_holds_the_guard() {
        let guard = LoginGuard::default();

        let started =
            start_guarded(&guard, nothing_to_ask, || async { Ok("t1".to_string()) }).await;

        assert_eq!(started, Ok("t1".to_string()));
        assert_eq!(held(&guard), Some("t1".to_string()));
        assert_eq!(claim(&guard, |id| id == "t1"), Err(AccountError::Busy));
    }

    #[tokio::test]
    async fn a_failed_spawn_leaves_the_guard_free() {
        let guard = LoginGuard::default();

        let started = start_guarded(&guard, nothing_to_ask, || async {
            Err(AccountError::Invalid {
                message: "Failed to open PTY".into(),
            })
        })
        .await;

        assert_eq!(
            started,
            Err(AccountError::Invalid {
                message: "Failed to open PTY".into()
            })
        );
        assert_eq!(held(&guard), None);
        // The user can try again.
        assert_eq!(
            start_guarded(&guard, nothing_to_ask, || async { Ok("t2".to_string()) }).await,
            Ok("t2".to_string())
        );
    }

    #[tokio::test]
    async fn a_start_that_is_dropped_while_spawning_frees_the_guard() {
        let guard = LoginGuard::default();

        // The start is given up while it waits for a spawn that never ends.
        tokio::select! {
            biased;
            _ = start_guarded(&guard, nothing_to_ask, || {
                std::future::pending::<Result<String, AccountError>>()
            }) => panic!("the spawn never ends"),
            // Polled once the start is waiting for its spawn.
            _ = async {
                assert_eq!(
                    claim(&guard, |_| false),
                    Err(AccountError::Busy),
                    "the start had not claimed the guard"
                );
            } => {}
        }

        assert_eq!(held(&guard), None);
        assert_eq!(claim(&guard, nothing_to_ask), Ok(()));
    }

    #[tokio::test]
    async fn a_second_start_is_refused_while_the_first_terminal_is_alive() {
        let guard = holding("t1");
        let spawned = RefCell::new(false);

        let started = start_guarded(
            &guard,
            |id| id == "t1",
            || async {
                *spawned.borrow_mut() = true;
                Ok("t2".to_string())
            },
        )
        .await;

        assert_eq!(started, Err(AccountError::Busy));
        assert!(!*spawned.borrow(), "a second terminal was spawned");
        assert_eq!(held(&guard), Some("t1".to_string()));
    }

    #[tokio::test]
    async fn a_second_start_is_refused_while_the_first_is_still_spawning() {
        let guard = LoginGuard::default();
        let second = RefCell::new(None);
        let (guard_ref, second_ref) = (&guard, &second);

        let first = start_guarded(&guard, nothing_to_ask, move || async move {
            // A second request arrives while the first terminal is still being
            // spawned: it has no id yet, so nothing is alive to ask about.
            let refused = start_guarded(
                guard_ref,
                |_| false,
                || async { panic!("a second terminal was spawned") },
            )
            .await;
            *second_ref.borrow_mut() = Some(refused);
            Ok("t1".to_string())
        })
        .await;

        assert_eq!(first, Ok("t1".to_string()));
        assert_eq!(second.into_inner(), Some(Err(AccountError::Busy)));
    }

    #[tokio::test]
    async fn a_start_replaces_a_terminal_that_is_gone() {
        let guard = holding("t1");

        let started = start_guarded(&guard, |_| false, || async { Ok("t2".to_string()) }).await;

        assert_eq!(started, Ok("t2".to_string()));
        assert_eq!(held(&guard), Some("t2".to_string()));
    }

    // -- The exit event --

    #[test]
    fn exited_terminal_id_parses_payload() {
        assert_eq!(
            exited_terminal_id(r#"{"terminalId":"t1","exitCode":0}"#),
            Some("t1".to_string())
        );
        // A terminal that was killed has no exit code.
        assert_eq!(
            exited_terminal_id(r#"{"terminalId":"t1","exitCode":null}"#),
            Some("t1".to_string())
        );
        for payload in [
            "",
            "null",
            "not json",
            r#"["t1"]"#,
            r#"{"exitCode":0}"#,
            r#"{"terminalId":7,"exitCode":0}"#,
            r#"{"terminalId":null}"#,
        ] {
            assert_eq!(exited_terminal_id(payload), None, "payload: {payload}");
        }
    }

    #[test]
    fn exited_terminal_id_reads_what_the_pty_emits() {
        // The listener and the emitter live apart; this is what keeps them
        // agreeing on the field.
        for exit_code in [Some(0), Some(1), None] {
            let payload = serde_json::to_string(&crate::pty::PtyExitedEvent {
                terminal_id: "t1".into(),
                exit_code,
            })
            .unwrap();

            assert_eq!(
                exited_terminal_id(&payload),
                Some("t1".to_string()),
                "payload: {payload}"
            );
        }
    }
}
