//! Account decisions that need the database.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;

use super::env::{account_env, project_env, session_env, EnvPatch};
use super::identity::{with_api_key_overlay, AccountIdentity, SignInStatus};
use super::secrets::SecretStore;
use super::{resolve_session_account, title_account, AccountError, AccountSelection, TitleAccount};
use crate::agent::{AccountHome, Agent, AgentKind};
use crate::db::{self, Account};

/// A failed query. `AccountError` has no database kind, and starting the
/// session on Default instead would be the silent fallback accounts forbid.
pub(super) fn database_error(message: String) -> AccountError {
    AccountError::Invalid { message }
}

/// The request or the account is wrong, as `message` says.
pub(super) fn invalid(message: impl Into<String>) -> AccountError {
    AccountError::Invalid {
        message: message.into(),
    }
}

/// Runs `work` on a blocking thread. What it does is use the keychain and the
/// CLI's files, which may block (a keychain unlock prompt can sit there until
/// the user answers), so it must never run on a tokio worker.
pub(super) async fn blocking<T, F>(work: F) -> Result<T, AccountError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AccountError> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        // The work panicked. The panic hook already printed it, and the work
        // handles secrets, so none of it is repeated in the message.
        Err(_) => Err(invalid("The account work failed unexpectedly")),
    }
}

/// The row of `account_id`, removed or not.
pub(super) async fn load_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Account, AccountError> {
    db::get_account(pool, account_id)
        .await
        .map_err(database_error)?
        .ok_or_else(|| AccountError::Missing {
            account_id: account_id.to_string(),
        })
}

/// `account` if it is not removed.
pub(super) fn live(account: Account) -> Result<Account, AccountError> {
    if account.removed_at.is_some() {
        return Err(AccountError::Removed {
            account_id: account.id,
            label: account.label,
        });
    }
    Ok(account)
}

/// The row of the account `account_id`, which must be a live account of the
/// harness `agent_type`: `Missing`, `WrongHarness` or `Removed` otherwise, in
/// that order.
pub(super) async fn load_live_account(
    pool: &SqlitePool,
    account_id: &str,
    agent_type: &str,
) -> Result<Account, AccountError> {
    let account = load_account(pool, account_id).await?;
    if account.agent_type != agent_type {
        return Err(AccountError::WrongHarness {
            account_id: account_id.to_string(),
        });
    }
    live(account)
}

/// The account a new session of `agent_type` in `project_id` runs on: what the
/// user picked, else the project's account for the harness, else Default
/// (`None`). A picked account must exist, belong to the harness and not be
/// removed. The project's own binding needs no check: an account cannot be
/// removed while a project uses it.
pub async fn resolve_new_session_account(
    pool: &SqlitePool,
    project_id: &str,
    agent_type: &str,
    selection: Option<&AccountSelection>,
) -> Result<Option<String>, AccountError> {
    let project_accounts = db::project_account_ids(pool, project_id)
        .await
        .map_err(database_error)?;
    if let Some(AccountSelection::Account { id }) = selection {
        load_live_account(pool, id, agent_type).await?;
    }
    Ok(resolve_session_account(
        selection,
        agent_type,
        &project_accounts,
    ))
}

/// The accounts `project_id` is bound to, one per harness, ordered by harness
/// and then by creation. The order is fixed because `project_env` merges the
/// accounts in turn and the later one wins where their vars overlap, so it
/// must not change from one spawn to the next.
///
/// Nothing bound is skipped, removed or not: removal is refused while a project
/// uses the account, so a binding to a removed one is a fault to surface, and
/// a binding to an account with no row fails as `Missing`.
pub async fn load_project_accounts(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Vec<Account>, AccountError> {
    let bindings = db::project_account_ids(pool, project_id)
        .await
        .map_err(database_error)?;
    let mut accounts = Vec::with_capacity(bindings.len());
    for account_id in bindings.into_values() {
        accounts.push(load_account(pool, &account_id).await?);
    }
    accounts.sort_by(|a, b| {
        (&a.agent_type, a.created_at, &a.id).cmp(&(&b.agent_type, b.created_at, &b.id))
    });
    Ok(accounts)
}

/// Whether a session may run on `account`, an added account of `agent`'s
/// harness. A removed account may not, and neither may one nobody is signed in
/// to. An API key in the account's env counts as a login. A sign-in the files
/// cannot answer (`Unknown`) never blocks.
///
/// Only added accounts are checked: the Default account has no row and is
/// never refused. Reads the CLI's files, so async callers go through
/// `spawn_blocking`.
pub fn check_usable(account: &Account, agent: &dyn Agent) -> Result<(), AccountError> {
    if account.removed_at.is_some() {
        return Err(AccountError::Removed {
            account_id: account.id.clone(),
            label: account.label.clone(),
        });
    }
    if account_identity(agent, account).status == SignInStatus::SignedOut {
        return Err(AccountError::SignedOut {
            account_id: account.id.clone(),
            label: account.label.clone(),
        });
    }
    Ok(())
}

/// Who is signed in to the added account `account` of `agent`'s harness: what
/// the CLI's files say, or an API key in the account's env when they say nobody
/// is. Reads the CLI's files, so async callers go through `spawn_blocking`.
pub(super) fn account_identity(agent: &dyn Agent, account: &Account) -> AccountIdentity {
    let identity = agent.read_account_identity(AccountHome::Dir(Path::new(&account.config_dir)));
    match agent.account_profile() {
        Some(profile) => with_api_key_overlay(identity, &profile, &account.env),
        None => identity,
    }
}

/// The row of the account a session of `agent_type` runs on.
async fn load_session_account(
    pool: &SqlitePool,
    account_id: &str,
    agent_type: &str,
) -> Result<Account, AccountError> {
    let account = load_account(pool, account_id).await?;
    // A session's account is fixed when the session is created, so a mismatch
    // means a row was changed behind Verun's back. Refuse rather than hand one
    // harness another's env, which `session_env` assumes it is not given.
    if AgentKind::parse(&account.agent_type) != AgentKind::parse(agent_type) {
        return Err(AccountError::WrongHarness {
            account_id: account_id.to_string(),
        });
    }
    Ok(account)
}

/// The env a session of `agent_type` in `project_id` is spawned with, on
/// `account_id` (`None`: the Default account). See `session_env` for what it
/// holds.
///
/// A session's account must exist, belong to the harness and pass
/// `check_usable`, or this is an error: a session never falls back to another
/// account. The Default account has nothing to check.
///
/// The database is read here; the sign-in check and the keychain reads run in
/// `spawn_blocking` with the owned data they need.
pub async fn session_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
    agent_type: &str,
    account_id: Option<&str>,
) -> Result<EnvPatch, AccountError> {
    let session_account = match account_id {
        Some(id) => Some(load_session_account(pool, id, agent_type).await?),
        None => None,
    };
    let project_accounts = load_project_accounts(pool, project_id).await?;
    let agent_type = agent_type.to_string();
    blocking(move || {
        if let Some(account) = &session_account {
            let agent = AgentKind::parse(&agent_type).implementation();
            check_usable(account, agent.as_ref())?;
        }
        session_env(
            &agent_type,
            session_account.as_ref(),
            &project_accounts,
            secrets.as_ref(),
        )
    })
    .await
}

/// The env of the task shells, hooks and start command of `project_id`: see
/// `project_env`. No account has to be signed in: a shell is where the user
/// signs it in.
///
/// The database is read here and the keychain reads run in `spawn_blocking`,
/// like `session_env_for`.
pub async fn project_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
) -> Result<EnvPatch, AccountError> {
    let project_accounts = load_project_accounts(pool, project_id).await?;
    blocking(move || project_env(&project_accounts, secrets.as_ref())).await
}

/// The env of a hook of `project_id`, `hook` being its command: see
/// `project_env_for`. An empty hook spawns nothing, so it needs no env and
/// neither the database nor the keychain is touched: a project without a hook
/// never fails over an account.
pub async fn hook_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
    hook: &str,
) -> Result<EnvPatch, AccountError> {
    if hook.is_empty() {
        return Ok(EnvPatch::default());
    }
    project_env_for(pool, secrets, project_id).await
}

/// How long deleting or archiving a task waits for the project's accounts
/// before it runs the destroy hook without them.
const DESTROY_HOOK_ENV_TIMEOUT: Duration = Duration::from_secs(10);

/// The env of the destroy hook (`hook`) of a task that is being deleted or
/// archived: `hook_env_for`, except that it cannot fail. A task must stay
/// removable whatever state its accounts are in (a locked keychain, a secret
/// that was never stored), so an error is logged and the hook runs without the
/// project's accounts, with Verun's own vars alone. Every other spawn fails
/// instead of falling back to another login.
///
/// A keychain that never answers (a locked one waits on its unlock prompt for
/// as long as the user leaves it) counts as an error too once
/// `DESTROY_HOOK_ENV_TIMEOUT` has passed. The read it was stuck in is left to
/// finish on its blocking thread, and its result is dropped.
///
/// The warning names the account and the var, never a value: no error carries
/// one.
pub async fn destroy_hook_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
    hook: &str,
) -> EnvPatch {
    destroy_hook_env_within(DESTROY_HOOK_ENV_TIMEOUT, pool, secrets, project_id, hook).await
}

/// `destroy_hook_env_for` with the time it waits as a parameter.
async fn destroy_hook_env_within(
    timeout: Duration,
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
    hook: &str,
) -> EnvPatch {
    let failure =
        match tokio::time::timeout(timeout, hook_env_for(pool, secrets, project_id, hook)).await {
            Ok(Ok(env)) => return env,
            Ok(Err(e)) => format!("{e:?}"),
            Err(_) => format!("no answer within {timeout:?}"),
        };
    eprintln!(
        "[verun][accounts] destroy hook of project {project_id} runs without its accounts: {failure}"
    );
    EnvPatch::default()
}

/// The env of the Haiku call that names a session, on the Claude login
/// `title` chose: `None` when there is no Claude login the message may go to
/// (`Skip`), and the empty patch for Default's, which keeps the env Verun has.
///
/// An added account gets its own env and nothing of the project's: a title is
/// one Claude call, so the project's other accounts have no part in it. The
/// account must exist, be Claude's, and pass `check_usable`. One that does not
/// (removed, signed out, a secret the keychain won't give, a row that is not
/// Claude's) is `None` and never the Default login, since the message is the
/// client's and a Default call would put it on the user's own subscription. The
/// reason is logged, naming the account and never a value.
///
/// The database is read here; the sign-in check and the keychain reads run in
/// `spawn_blocking`, like `session_env_for`.
pub async fn title_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    title: &TitleAccount,
) -> Option<EnvPatch> {
    let account_id = match title {
        TitleAccount::Skip => return None,
        TitleAccount::Use(None) => return Some(EnvPatch::default()),
        TitleAccount::Use(Some(account_id)) => account_id,
    };
    match claude_account_env(pool, secrets, account_id).await {
        Ok(env) => Some(env),
        Err(e) => {
            eprintln!(
                "[verun][accounts] title for a session on account {account_id} is a plain title: {e}"
            );
            None
        }
    }
}

/// The env of the added Claude account `account_id`, if a session may run on
/// it.
async fn claude_account_env(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    account_id: &str,
) -> Result<EnvPatch, AccountError> {
    let account = load_session_account(pool, account_id, AgentKind::Claude.as_str()).await?;
    blocking(move || {
        let claude = AgentKind::Claude.implementation();
        check_usable(&account, claude.as_ref())?;
        account_env(claude.as_ref(), &account, secrets.as_ref())
    })
    .await
}

/// `title_env_for` for the session of `agent_type` in `project_id` that runs on
/// `account_id` (`None`: Default): the login is `title_account`'s choice, from
/// the session and the project's Claude account.
///
/// A Claude session does not look at the project. For a session of another
/// harness the project's Claude account decides, so when the project's accounts
/// can't be read it is unknown whether the Default login is safe, and the
/// answer is `None` (a plain title) rather than a guess.
pub async fn session_title_env_for(
    pool: &SqlitePool,
    secrets: Arc<dyn SecretStore>,
    project_id: &str,
    agent_type: &str,
    account_id: Option<&str>,
) -> Option<EnvPatch> {
    let project_claude = if AgentKind::parse(agent_type) == AgentKind::Claude {
        None
    } else {
        match db::project_account_ids(pool, project_id).await {
            Ok(mut bindings) => bindings.remove(AgentKind::Claude.as_str()),
            Err(e) => {
                eprintln!(
                    "[verun][accounts] title for a session of project {project_id} is a plain title: {e}"
                );
                return None;
            }
        }
    };
    let title = title_account(agent_type, account_id, project_claude.as_deref());
    title_env_for(pool, secrets, &title).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::accounts::secrets::{LockedKeychain, MemorySecretStore};
    use crate::agent::Claude;
    use crate::db::tests::{
        make_account, mark_account_removed_confirmed, set_project_account_confirmed, test_pool,
        upsert_account_confirmed,
    };
    use crate::db::AccountEnvVar;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn pick(id: &str) -> AccountSelection {
        AccountSelection::Account { id: id.into() }
    }

    /// Claude accounts a1 and a2, Codex account c1, and a1-gone: a removed Claude account.
    async fn pool_with_accounts() -> SqlitePool {
        let pool = test_pool().await;
        for (id, agent_type) in [("a1", "claude"), ("a2", "claude"), ("c1", "codex")] {
            let mut account = make_account(id, 1000);
            account.agent_type = agent_type.into();
            upsert_account_confirmed(&pool, account).await.unwrap();
        }
        upsert_account_confirmed(&pool, make_account("a1-gone", 1000))
            .await
            .unwrap();
        mark_account_removed_confirmed(&pool, "a1-gone", 1700)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn resolve_new_session_account_validates_explicit_id() {
        let pool = pool_with_accounts().await;

        // A Codex account cannot back a Claude session.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("c1"))).await,
            Err(AccountError::WrongHarness {
                account_id: "c1".into()
            })
        );
        // A removed account may not start anything, and the error names it.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a1-gone"))).await,
            Err(AccountError::Removed {
                account_id: "a1-gone".into(),
                label: "Account a1-gone".into()
            })
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("nope"))).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_accepts_a_live_account_of_the_harness() {
        let pool = pool_with_accounts().await;

        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a2"))).await,
            Ok(Some("a2".to_string()))
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "codex", Some(&pick("c1"))).await,
            Ok(Some("c1".to_string()))
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_falls_back_to_the_project_binding() {
        let pool = pool_with_accounts().await;
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        // No choice and ProjectDefault both mean the project's account.
        for selection in [None, Some(AccountSelection::ProjectDefault)] {
            assert_eq!(
                resolve_new_session_account(&pool, "p-001", "claude", selection.as_ref()).await,
                Ok(Some("a1".to_string())),
                "selection: {selection:?}"
            );
        }
        // Default skips the binding, and a pick beats it.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&AccountSelection::Default))
                .await,
            Ok(None)
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "claude", Some(&pick("a2"))).await,
            Ok(Some("a2".to_string()))
        );
        // The binding belongs to one project and one harness.
        assert_eq!(
            resolve_new_session_account(&pool, "p-001", "codex", None).await,
            Ok(None)
        );
        assert_eq!(
            resolve_new_session_account(&pool, "p-002", "claude", None).await,
            Ok(None)
        );
    }

    #[tokio::test]
    async fn resolve_new_session_account_fails_instead_of_defaulting_when_the_database_fails() {
        // No migrations ran, so every query fails. A session must not quietly
        // start on Default because the project's binding could not be read.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        for selection in [None, Some(pick("a1"))] {
            let result =
                resolve_new_session_account(&pool, "p-001", "claude", selection.as_ref()).await;
            assert!(
                matches!(result, Err(AccountError::Invalid { .. })),
                "selection: {selection:?}, result: {result:?}"
            );
        }
    }

    // -- Fixtures for the spawn env --

    /// The `.claude.json` of a home somebody is signed in to.
    pub(crate) const SIGNED_IN: &str = r#"{"oauthAccount":{"emailAddress":"dev@acme.com"}}"#;

    /// A Claude config dir whose `.claude.json` holds `json`.
    pub(crate) fn claude_dir(json: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(".claude.json"), json).unwrap();
        dir
    }

    /// A live Claude account called Acme with its home in `dir`.
    pub(crate) fn acme(id: &str, dir: &TempDir) -> Account {
        let mut account = make_account(id, 1000);
        account.label = "Acme".into();
        account.config_dir = dir.path().to_string_lossy().into_owned();
        account
    }

    pub(crate) fn secret_var(key: &str) -> AccountEnvVar {
        AccountEnvVar {
            key: key.into(),
            value: None,
            secret: true,
        }
    }

    pub(crate) fn plain_var(key: &str, value: &str) -> AccountEnvVar {
        AccountEnvVar {
            key: key.into(),
            value: Some(value.into()),
            secret: false,
        }
    }

    fn no_secrets() -> Arc<dyn SecretStore> {
        Arc::new(MemorySecretStore::default())
    }

    fn sets(patch: &EnvPatch, key: &str, value: &str) -> bool {
        patch.set.contains(&(key.to_string(), value.to_string()))
    }

    /// A keychain that notes the thread of every read, and of every write and
    /// delete.
    #[derive(Default)]
    pub(crate) struct ThreadSpy {
        secrets: MemorySecretStore,
        pub(crate) reads: Mutex<Vec<std::thread::ThreadId>>,
        pub(crate) changes: Mutex<Vec<std::thread::ThreadId>>,
    }

    impl SecretStore for ThreadSpy {
        fn get(&self, account_id: &str, key: &str) -> Result<Option<String>, String> {
            self.reads.lock().unwrap().push(std::thread::current().id());
            self.secrets.get(account_id, key)
        }
        fn set(&self, account_id: &str, key: &str, value: &str) -> Result<(), String> {
            self.changes
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.secrets.set(account_id, key, value)
        }
        fn delete(&self, account_id: &str, key: &str) -> Result<(), String> {
            self.changes
                .lock()
                .unwrap()
                .push(std::thread::current().id());
            self.secrets.delete(account_id, key)
        }
    }

    // -- load_project_accounts --

    /// The ids `load_project_accounts` returns, in its order.
    async fn loaded_ids(pool: &SqlitePool, project_id: &str) -> Vec<String> {
        load_project_accounts(pool, project_id)
            .await
            .unwrap()
            .into_iter()
            .map(|account| account.id)
            .collect()
    }

    #[tokio::test]
    async fn load_project_accounts_orders_by_harness_whatever_the_binding_order() {
        let pool = test_pool().await;
        // Created and bound in reverse order. Six harnesses leave next to no
        // chance that an unordered lookup comes back sorted by luck.
        for (i, agent_type) in ["opencode", "grok", "gemini", "cursor", "codex", "claude"]
            .into_iter()
            .enumerate()
        {
            let id = format!("acc-{agent_type}");
            let mut account = make_account(&id, 100 + i as i64);
            account.agent_type = agent_type.into();
            upsert_account_confirmed(&pool, account).await.unwrap();
            set_project_account_confirmed(&pool, "p-001", agent_type, Some(&id))
                .await
                .unwrap();
        }

        assert_eq!(
            loaded_ids(&pool, "p-001").await,
            [
                "acc-claude",
                "acc-codex",
                "acc-cursor",
                "acc-gemini",
                "acc-grok",
                "acc-opencode"
            ]
        );
    }

    #[tokio::test]
    async fn load_project_accounts_returns_only_the_accounts_this_project_is_bound_to() {
        let pool = pool_with_accounts().await;
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-002", "claude", Some("a2"))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-002", "codex", Some("c1"))
            .await
            .unwrap();

        // a2 is bound by p-002 only, and a project with no bindings has none.
        assert_eq!(loaded_ids(&pool, "p-001").await, ["a1"]);
        assert_eq!(loaded_ids(&pool, "p-002").await, ["a2", "c1"]);
        assert_eq!(loaded_ids(&pool, "p-003").await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn load_project_accounts_skips_nothing_that_is_bound() {
        let pool = pool_with_accounts().await;
        // Removal is blocked while a project uses the account. If a binding
        // outlives it anyway, the account is still the project's.
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1-gone"))
            .await
            .unwrap();

        let accounts = load_project_accounts(&pool, "p-001").await.unwrap();

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "a1-gone");
        assert!(accounts[0].removed_at.is_some());
    }

    #[tokio::test]
    async fn load_project_accounts_reports_a_binding_to_an_account_that_is_gone() {
        let pool = test_pool().await;
        set_project_account_confirmed(&pool, "p-001", "claude", Some("nope"))
            .await
            .unwrap();

        assert_eq!(
            load_project_accounts(&pool, "p-001").await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    // -- check_usable --

    #[test]
    fn check_usable_refuses_a_removed_account_even_if_somebody_is_signed_in() {
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.removed_at = Some(1700);

        assert_eq!(
            check_usable(&account, &Claude),
            Err(AccountError::Removed {
                account_id: "a1".into(),
                label: "Acme".into()
            })
        );
    }

    #[test]
    fn check_usable_refuses_an_account_nobody_is_signed_in_to() {
        // A home without an account in it, and one never logged in to.
        for dir in [claude_dir("{}"), TempDir::new().unwrap()] {
            assert_eq!(
                check_usable(&acme("a1", &dir), &Claude),
                Err(AccountError::SignedOut {
                    account_id: "a1".into(),
                    label: "Acme".into()
                }),
                "dir: {:?}",
                dir.path()
            );
        }
    }

    #[test]
    fn check_usable_allows_a_signed_in_account() {
        let dir = claude_dir(SIGNED_IN);
        assert_eq!(check_usable(&acme("a1", &dir), &Claude), Ok(()));
    }

    #[test]
    fn check_usable_allows_an_account_whose_sign_in_cannot_be_read() {
        // Half a file says nothing about a login, so it never blocks.
        let dir = claude_dir("{");
        assert_eq!(check_usable(&acme("a1", &dir), &Claude), Ok(()));
    }

    #[test]
    fn check_usable_treats_an_api_key_in_the_env_as_a_login() {
        let dir = claude_dir("{}");
        let mut account = acme("a1", &dir);
        // Another var does not stand in for a key.
        account.env = vec![plain_var("ANTHROPIC_BASE_URL", "https://proxy")];
        assert!(matches!(
            check_usable(&account, &Claude),
            Err(AccountError::SignedOut { .. })
        ));

        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        assert_eq!(check_usable(&account, &Claude), Ok(()));
    }

    // -- session_env_for --

    #[tokio::test]
    async fn session_env_for_default_is_empty() {
        let pool = pool_with_accounts().await;

        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", None).await,
            Ok(EnvPatch::default())
        );
    }

    #[tokio::test]
    async fn session_env_for_default_session_keeps_its_own_harness_on_default() {
        // The project's Claude account is not a Default Claude session's: it
        // keeps the env it inherited. A session of another harness follows the
        // project's Claude account, so the `claude` it runs uses it.
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        upsert_account_confirmed(&pool, acme("a1", &dir))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", None).await,
            Ok(EnvPatch::default())
        );
        let other = session_env_for(&pool, no_secrets(), "p-001", "codex", None)
            .await
            .unwrap();
        assert!(sets(
            &other,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
    }

    #[tokio::test]
    async fn session_env_for_signed_in_account_gets_its_home_and_scrubbed_env() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![plain_var("ANTHROPIC_BASE_URL", "https://proxy")];
        upsert_account_confirmed(&pool, account).await.unwrap();

        let patch = session_env_for(&pool, no_secrets(), "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
        assert!(sets(&patch, "ANTHROPIC_BASE_URL", "https://proxy"));
        // What Verun inherited cannot override the account.
        assert!(patch.remove.contains(&"ANTHROPIC_API_KEY".to_string()));
    }

    #[tokio::test]
    async fn session_env_for_signed_out_account_errors() {
        let pool = test_pool().await;
        let dir = claude_dir("{}");
        upsert_account_confirmed(&pool, acme("a1", &dir))
            .await
            .unwrap();

        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", Some("a1")).await,
            Err(AccountError::SignedOut {
                account_id: "a1".into(),
                label: "Acme".into()
            })
        );
    }

    #[tokio::test]
    async fn session_env_for_api_key_account_is_usable() {
        let pool = test_pool().await;
        // Nobody is logged in to the dir, but the account brings its own key.
        let dir = claude_dir("{}");
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();

        let patch = session_env_for(&pool, secrets, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        assert!(sets(&patch, "ANTHROPIC_API_KEY", "sk-ant-one"));
    }

    #[tokio::test]
    async fn session_env_for_removed_or_missing_account_errors() {
        let pool = pool_with_accounts().await;

        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", Some("a1-gone")).await,
            Err(AccountError::Removed {
                account_id: "a1-gone".into(),
                label: "Account a1-gone".into()
            })
        );
        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", Some("nope")).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn session_env_for_refuses_an_account_of_another_harness() {
        let pool = pool_with_accounts().await;

        // c1 is a Codex account: a Claude session must not get its env.
        assert_eq!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", Some("c1")).await,
            Err(AccountError::WrongHarness {
                account_id: "c1".into()
            })
        );
    }

    #[tokio::test]
    async fn session_env_for_reports_a_secret_it_cannot_read() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();

        // Signed in, but the key the account defines is not in the keychain.
        assert!(matches!(
            session_env_for(&pool, no_secrets(), "p-001", "claude", Some("a1")).await,
            Err(AccountError::Secret { .. })
        ));
    }

    #[tokio::test]
    async fn session_env_for_fails_instead_of_defaulting_when_the_database_fails() {
        // No migrations ran, so every query fails: a session must not start on
        // an env nobody could check.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        for account_id in [None, Some("a1")] {
            let result = session_env_for(&pool, no_secrets(), "p-001", "claude", account_id).await;
            assert!(
                matches!(result, Err(AccountError::Invalid { .. })),
                "account: {account_id:?}, result: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn session_env_for_reads_the_keychain_off_the_calling_thread() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        let spy = Arc::new(ThreadSpy::default());
        spy.set("a1", "ANTHROPIC_API_KEY", "sk-ant-one").unwrap();

        let patch = session_env_for(&pool, spy.clone(), "p-001", "claude", Some("a1")).await;

        assert!(patch.is_ok(), "{patch:?}");
        // The test runs on a current-thread runtime, so a keychain call made
        // inline would be recorded on this very thread.
        let reads = spy.reads.lock().unwrap();
        assert!(!reads.is_empty(), "the secret was never read");
        assert!(
            !reads.contains(&std::thread::current().id()),
            "the keychain was read on the async caller's thread"
        );
    }

    // -- project_env_for --

    #[tokio::test]
    async fn project_env_for_project_without_accounts_is_empty() {
        let pool = pool_with_accounts().await;

        assert_eq!(
            project_env_for(&pool, no_secrets(), "p-001").await,
            Ok(EnvPatch::default())
        );
    }

    #[tokio::test]
    async fn project_env_for_includes_bound_claude_account() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![
            secret_var("ANTHROPIC_API_KEY"),
            plain_var("ANTHROPIC_BASE_URL", "https://proxy"),
        ];
        upsert_account_confirmed(&pool, account).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();

        let patch = project_env_for(&pool, secrets, "p-001").await.unwrap();

        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
        assert!(sets(&patch, "ANTHROPIC_API_KEY", "sk-ant-one"));
        assert!(sets(&patch, "ANTHROPIC_BASE_URL", "https://proxy"));
    }

    #[tokio::test]
    async fn project_env_for_does_not_need_the_account_to_be_signed_in() {
        // Task shells are where a user runs `claude auth login`, so a signed-out
        // account must not lock them out.
        let pool = test_pool().await;
        let dir = claude_dir("{}");
        upsert_account_confirmed(&pool, acme("a1", &dir))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        let patch = project_env_for(&pool, no_secrets(), "p-001").await.unwrap();

        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
    }

    #[tokio::test]
    async fn project_env_for_reads_the_keychain_off_the_calling_thread() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        let spy = Arc::new(ThreadSpy::default());
        spy.set("a1", "ANTHROPIC_API_KEY", "sk-ant-one").unwrap();

        let patch = project_env_for(&pool, spy.clone(), "p-001").await;

        assert!(patch.is_ok(), "{patch:?}");
        let reads = spy.reads.lock().unwrap();
        assert!(!reads.is_empty(), "the secret was never read");
        assert!(
            !reads.contains(&std::thread::current().id()),
            "the keychain was read on the async caller's thread"
        );
    }

    // -- hook_env_for --

    #[tokio::test]
    async fn hook_env_for_a_hook_gets_the_projects_env() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        upsert_account_confirmed(&pool, acme("a1", &dir))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        let patch = hook_env_for(&pool, no_secrets(), "p-001", "pnpm install")
            .await
            .unwrap();

        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
    }

    #[tokio::test]
    async fn hook_env_for_a_hook_fails_when_a_secret_cannot_be_read() {
        // The hook would run on the wrong login, so it does not run.
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        let result = hook_env_for(&pool, Arc::new(LockedKeychain), "p-001", "pnpm install").await;

        assert!(
            matches!(result, Err(AccountError::Secret { .. })),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn hook_env_for_no_hook_needs_no_env() {
        // Nothing is spawned, so neither the database nor the keychain is
        // touched, and an account that cannot be read costs a project without a
        // hook nothing. The pool has no tables, so any query would fail.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let spy = Arc::new(ThreadSpy::default());

        assert_eq!(
            hook_env_for(&pool, spy.clone(), "p-001", "").await,
            Ok(EnvPatch::default())
        );
        assert!(spy.reads.lock().unwrap().is_empty());
    }

    // -- destroy_hook_env_for --

    #[tokio::test]
    async fn destroy_hook_env_for_includes_the_bound_account() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        upsert_account_confirmed(&pool, acme("a1", &dir))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();

        let patch = destroy_hook_env_for(&pool, no_secrets(), "p-001", "rm -rf node_modules").await;

        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
    }

    #[tokio::test]
    async fn destroy_hook_env_for_runs_without_the_accounts_when_the_keychain_fails() {
        // A task must stay deletable, so unlike a shell or a setup hook the
        // destroy hook goes on with Verun's own vars alone.
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        assert!(matches!(
            project_env_for(&pool, Arc::new(LockedKeychain), "p-001").await,
            Err(AccountError::Secret { .. })
        ));

        let patch = destroy_hook_env_for(
            &pool,
            Arc::new(LockedKeychain),
            "p-001",
            "rm -rf node_modules",
        )
        .await;

        assert_eq!(patch, EnvPatch::default());
    }

    #[tokio::test]
    async fn destroy_hook_env_for_runs_without_the_accounts_when_the_database_fails() {
        // No migrations ran, so every query fails.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        let patch = destroy_hook_env_for(&pool, no_secrets(), "p-001", "rm -rf node_modules").await;

        assert_eq!(patch, EnvPatch::default());
    }

    /// A keychain that does not answer until the test lets go of `release`.
    struct StuckKeychain(Mutex<std::sync::mpsc::Receiver<()>>);

    impl SecretStore for StuckKeychain {
        fn get(&self, _account_id: &str, _key: &str) -> Result<Option<String>, String> {
            // Returns once the sender is dropped.
            let _ = self.0.lock().unwrap().recv();
            Err("keychain was released".into())
        }
        fn set(&self, _account_id: &str, _key: &str, _value: &str) -> Result<(), String> {
            Err("keychain was released".into())
        }
        fn delete(&self, _account_id: &str, _key: &str) -> Result<(), String> {
            Err("keychain was released".into())
        }
    }

    #[tokio::test]
    async fn destroy_hook_env_within_gives_up_on_a_keychain_that_never_answers() {
        // A locked keychain can sit on its unlock prompt until the user answers
        // it, and deleting a task must not wait for that.
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        let (release, stuck) = std::sync::mpsc::channel();
        let secrets = Arc::new(StuckKeychain(Mutex::new(stuck)));

        // The outer limit only keeps a missing timeout from hanging the test.
        let patch = tokio::time::timeout(
            Duration::from_secs(10),
            destroy_hook_env_within(
                Duration::from_millis(50),
                &pool,
                secrets,
                "p-001",
                "rm -rf node_modules",
            ),
        )
        .await
        .expect("destroy_hook_env_within waited for the keychain");

        // Verun's own vars alone, as for any other failure.
        assert_eq!(patch, EnvPatch::default());
        // Lets the blocked read finish, so the runtime can shut down.
        drop(release);
    }

    // -- title_env_for and session_title_env_for --

    fn use_claude(id: &str) -> TitleAccount {
        TitleAccount::Use(Some(id.into()))
    }

    /// The env a Claude call on `account` runs with, its own and nothing else.
    fn claude_env_of(account: &Account) -> EnvPatch {
        account_env(&Claude, account, &MemorySecretStore::default()).unwrap()
    }

    /// What the title tests run on.
    struct TitleFixture {
        pool: SqlitePool,
        /// Signed-in Claude accounts.
        a1: Account,
        a2: Account,
        /// The accounts' homes, kept so they live as long as the test does.
        _homes: [TempDir; 3],
    }

    /// A pool with two signed-in Claude accounts, a1 and a2, a signed-in Claude
    /// account a1-gone that was removed, and the Codex account c1. Project p-001
    /// is bound to a1, p-002 has no accounts and p-003 is bound to a1-gone.
    async fn title_fixture() -> TitleFixture {
        let pool = test_pool().await;
        let [d1, d2, d3] = [SIGNED_IN; 3].map(claude_dir);
        let (a1, a2) = (acme("a1", &d1), acme("a2", &d2));
        for account in [a1.clone(), a2.clone(), acme("a1-gone", &d3)] {
            upsert_account_confirmed(&pool, account).await.unwrap();
        }
        mark_account_removed_confirmed(&pool, "a1-gone", 1700)
            .await
            .unwrap();
        let mut codex = make_account("c1", 1000);
        codex.agent_type = "codex".into();
        upsert_account_confirmed(&pool, codex).await.unwrap();
        set_project_account_confirmed(&pool, "p-001", "claude", Some("a1"))
            .await
            .unwrap();
        set_project_account_confirmed(&pool, "p-003", "claude", Some("a1-gone"))
            .await
            .unwrap();
        TitleFixture {
            pool,
            a1,
            a2,
            _homes: [d1, d2, d3],
        }
    }

    #[tokio::test]
    async fn title_env_for_the_default_login_adds_nothing() {
        // Default has no row, so nothing is read for it.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        assert_eq!(
            title_env_for(&pool, no_secrets(), &TitleAccount::Use(None)).await,
            Some(EnvPatch::default())
        );
    }

    #[tokio::test]
    async fn title_env_for_skip_is_no_env_at_all() {
        let pool = test_pool().await;

        assert_eq!(
            title_env_for(&pool, no_secrets(), &TitleAccount::Skip).await,
            None
        );
    }

    #[tokio::test]
    async fn title_env_for_an_added_claude_account_is_its_own_env() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![
            secret_var("ANTHROPIC_API_KEY"),
            plain_var("ANTHROPIC_BASE_URL", "https://proxy"),
        ];
        upsert_account_confirmed(&pool, account.clone())
            .await
            .unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();

        let patch = title_env_for(&pool, secrets.clone(), &use_claude("a1"))
            .await
            .expect("a signed-in account can name a session");

        // Exactly what a Claude session on the account is spawned with.
        assert_eq!(
            patch,
            account_env(&Claude, &account, secrets.as_ref()).unwrap()
        );
        assert!(sets(
            &patch,
            "CLAUDE_CONFIG_DIR",
            &dir.path().to_string_lossy()
        ));
        assert!(sets(&patch, "ANTHROPIC_API_KEY", "sk-ant-one"));
        assert!(sets(&patch, "ANTHROPIC_BASE_URL", "https://proxy"));
    }

    #[tokio::test]
    async fn title_env_for_an_account_that_cannot_run_is_none_never_default() {
        let t = title_fixture().await;
        let signed_out = claude_dir("{}");
        upsert_account_confirmed(&t.pool, acme("signed-out", &signed_out))
            .await
            .unwrap();
        // The fixture is sound: an account that can run gets its env.
        assert!(title_env_for(&t.pool, no_secrets(), &use_claude("a1"))
            .await
            .is_some());

        for (account, why) in [
            (
                "a1-gone",
                "it was removed, though somebody is signed in to it",
            ),
            ("signed-out", "nobody is signed in to it"),
            ("nope", "no account has this id"),
            ("c1", "it belongs to another harness than Claude"),
        ] {
            assert_eq!(
                title_env_for(&t.pool, no_secrets(), &use_claude(account)).await,
                None,
                "{account}: {why}"
            );
        }
    }

    #[tokio::test]
    async fn title_env_for_an_account_with_an_unreadable_secret_is_none() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();

        // The key was never stored, and the keychain is locked.
        for secrets in [
            no_secrets(),
            Arc::new(LockedKeychain) as Arc<dyn SecretStore>,
        ] {
            assert_eq!(title_env_for(&pool, secrets, &use_claude("a1")).await, None);
        }
    }

    #[tokio::test]
    async fn title_env_for_reads_the_keychain_off_the_calling_thread() {
        let pool = test_pool().await;
        let dir = claude_dir(SIGNED_IN);
        let mut account = acme("a1", &dir);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        upsert_account_confirmed(&pool, account).await.unwrap();
        let spy = Arc::new(ThreadSpy::default());
        spy.set("a1", "ANTHROPIC_API_KEY", "sk-ant-one").unwrap();

        let patch = title_env_for(&pool, spy.clone(), &use_claude("a1")).await;

        assert!(patch.is_some());
        let reads = spy.reads.lock().unwrap();
        assert!(!reads.is_empty(), "the secret was never read");
        assert!(
            !reads.contains(&std::thread::current().id()),
            "the keychain was read on the async caller's thread"
        );
    }

    #[tokio::test]
    async fn session_title_env_for_a_claude_session_names_itself_on_its_own_account() {
        let t = title_fixture().await;
        let pool = &t.pool;

        // p-001 is bound to a1, and the session runs on a2.
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-001", "claude", Some("a2")).await,
            Some(claude_env_of(&t.a2))
        );
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-001", "claude", Some("a1")).await,
            Some(claude_env_of(&t.a1))
        );
        // A Default Claude session stays on Default, the project's account
        // notwithstanding: the project's account is for the other harnesses.
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-001", "claude", None).await,
            Some(EnvPatch::default())
        );
    }

    #[tokio::test]
    async fn session_title_env_for_a_default_non_claude_session_follows_the_projects_claude() {
        let t = title_fixture().await;
        let pool = &t.pool;

        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-001", "codex", None).await,
            Some(claude_env_of(&t.a1))
        );
        // With no Claude account in the project it is Default, as it always was.
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-002", "codex", None).await,
            Some(EnvPatch::default())
        );
    }

    #[tokio::test]
    async fn session_title_env_for_an_added_non_claude_session_never_reaches_default() {
        let t = title_fixture().await;
        let pool = &t.pool;

        // The project's added Claude account takes the message.
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-001", "codex", Some("c1")).await,
            Some(claude_env_of(&t.a1))
        );
        // No Claude account in the project: the message stays off Default's.
        assert_eq!(
            session_title_env_for(pool, no_secrets(), "p-002", "codex", Some("c1")).await,
            None
        );
        // And a project account that was removed is not Default either, for a
        // session on Default or on an added account.
        for account in [None, Some("c1")] {
            assert_eq!(
                session_title_env_for(pool, no_secrets(), "p-003", "codex", account).await,
                None,
                "account: {account:?}"
            );
        }
    }

    #[tokio::test]
    async fn session_title_env_for_unreadable_project_accounts_are_not_a_default_login() {
        // No migrations ran, so every query fails.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        // Whether the project has a Claude account is unknown, so the message
        // of another harness's session is not sent to a login on a guess.
        for account in [None, Some("c1")] {
            assert_eq!(
                session_title_env_for(&pool, no_secrets(), "p-001", "codex", account).await,
                None,
                "account: {account:?}"
            );
        }
        // A Claude session never needed the project: its own account decides.
        assert_eq!(
            session_title_env_for(&pool, no_secrets(), "p-001", "claude", None).await,
            Some(EnvPatch::default())
        );
    }
}
