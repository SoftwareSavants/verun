//! Adding, editing and removing accounts, and the snapshot of all of them that
//! the frontend reads.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::env::profile_of;
use super::identity::{with_api_key_overlay, AccountIdentity};
use super::paths::{
    managed_account_dir, normalize_account_dir, validate_account_dir, AccountDirError,
};
use super::secrets::SecretStore;
use super::service::{
    account_identity, blocking, database_error, invalid, live, load_account, load_live_account,
};
use super::AccountError;
use crate::agent::{AccountHome, AccountProfile, Agent, AgentKind};
use crate::db::{self, Account, AccountEnvVar, DbWrite, DbWriteTx, ProjectAccount};

// -- Adding, editing and removing accounts --

/// Account changes take turns. Each one looks at the accounts before it writes
/// (is the account still live, does a project use it, is the folder taken),
/// while the write queue only orders the writes. Two changes at once could pass
/// the same check and leave a project on a removed account, or two accounts on
/// one folder.
static ACCOUNT_CHANGES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A turn at changing accounts. Every change takes one before its first check
/// and hands it back with its result, and the caller sends the snapshot of the
/// change (`publish`) before giving the turn up by dropping it. That way the
/// snapshots reach the windows in the order the changes were stored. One built
/// or sent after the turn was over could be overtaken by the snapshot of the
/// next change, and a window would be left showing the older state.
#[must_use = "an account change is not over until its snapshot is out, and the turn holds up every other change until it is dropped"]
pub struct Turn {
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl Turn {
    /// Waits for the turn.
    pub async fn take() -> Self {
        Turn {
            _guard: ACCOUNT_CHANGES.lock().await,
        }
    }

    /// Builds the snapshot of the accounts as they are now (see `snapshot`),
    /// gives it to `emit` and returns it. `emit` is what sends it to the
    /// windows. Nothing is emitted if the snapshot cannot be built.
    pub async fn publish(
        &self,
        pool: &SqlitePool,
        user_home: &Path,
        emit: impl FnOnce(&AccountsSnapshot),
    ) -> Result<AccountsSnapshot, String> {
        let snapshot = snapshot(pool, user_home).await?;
        emit(&snapshot);
        Ok(snapshot)
    }
}

/// The user's home folder: what `~` means in an account's folder, and where the
/// Default accounts keep their logins.
pub fn account_user_home() -> Result<PathBuf, AccountError> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AccountError::Invalid {
            message: "Couldn't find your home folder.".into(),
        })
}

/// Tells every window that the accounts changed, with the fresh snapshot, and
/// hands the snapshot back for the command's result. `turn` is the one the
/// change took and still holds, so that snapshots go out in the order the
/// changes were stored.
pub async fn publish_accounts(
    turn: &Turn,
    app: &AppHandle,
    pool: &SqlitePool,
    user_home: &Path,
) -> Result<AccountsSnapshot, String> {
    turn.publish(pool, user_home, |snapshot| {
        let _ = app.emit("accounts-changed", snapshot);
    })
    .await
}

/// An account as the frontend reads it: its row and who is signed in to it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    pub account: Account,
    pub identity: AccountIdentity,
}

/// The Default account of one harness, the user's own CLI login. It has no row.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAccountView {
    pub agent_type: String,
    pub identity: AccountIdentity,
}

/// Everything the frontend knows about accounts. It is sent whole, as the
/// result of every account command and as the `accounts-changed` event.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountsSnapshot {
    pub accounts: Vec<AccountView>,
    pub defaults: Vec<DefaultAccountView>,
    pub project_accounts: Vec<ProjectAccount>,
}

/// One env var of an account as the user entered it.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEnvInput {
    pub key: String,
    /// A plain var's value, or a secret's new value. A secret that comes
    /// without one keeps the value already in the keychain.
    pub value: Option<String>,
    pub secret: bool,
}

/// A secret's value shows as `***`: input ends up in panic messages and failed
/// assertions.
impl std::fmt::Debug for AccountEnvInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match (&self.value, self.secret) {
            (Some(_), true) => Some("***"),
            (Some(value), false) => Some(value.as_str()),
            (None, _) => None,
        };
        f.debug_struct("AccountEnvInput")
            .field("key", &self.key)
            .field("value", &value)
            .field("secret", &self.secret)
            .finish()
    }
}

impl AccountEnvInput {
    /// The value the user entered, if any. A blank field sends the empty
    /// string, which is no value.
    fn entered_value(&self) -> Option<&str> {
        self.value.as_deref().filter(|value| !value.is_empty())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccountInput {
    pub agent_type: String,
    pub label: String,
    pub color: String,
    /// A folder the user already logged in from. `None`: Verun makes one.
    pub existing_dir: Option<String>,
    pub env: Vec<AccountEnvInput>,
}

/// An edit of an account. The harness and the folder are fixed when it is made.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccountInput {
    pub id: String,
    pub label: String,
    pub color: String,
    /// Replaces the account's env.
    pub env: Vec<AccountEnvInput>,
}

const BAD_ENV_NAME: &str =
    "Env var names use letters, digits and underscores, and can't start with a digit.";

const SHARED_DIR: &str =
    "Choose a folder of its own, not your home folder or the root of the disk.";

/// Whether `key` is a name a shell can export as it is: `[A-Za-z_][A-Za-z0-9_]*`.
/// The script that applies an account's env interpolates keys unquoted.
pub fn validate_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether `key` is a var Verun sets on the processes it starts: its own
/// `VERUN_*` vars, and the two that mark a Claude process as Verun's. Env names
/// are case-insensitive on some systems, so the case is ignored.
fn is_verun_env_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("VERUN_") || key == "CLAUDECODE" || key == "CLAUDE_CODE_ENTRYPOINT"
}

/// The vars every account of the harness gets from the account support itself:
/// the var that points the CLI at `dir`, and the harness's fixed env. An
/// account's own vars apply after them, so one of the same name would re-point
/// the account or defeat a setting.
fn harness_env_keys(agent: &dyn Agent, profile: &AccountProfile, dir: &str) -> Vec<String> {
    agent
        .account_home_env(Path::new(dir))
        .into_iter()
        .map(|(key, _)| key)
        .chain(profile.fixed_env.iter().map(|(key, _)| key.to_string()))
        .collect()
}

/// Checks the env an account is to have after a create or an edit.
/// `previous` is the env it had before (empty for a new account),
/// `harness_keys` the vars `harness_env_keys` names.
///
/// Every key must be a name a shell can export that Verun and the harness
/// don't set themselves, and none may be given twice. A var needs a value. For
/// a secret that may be the one in the keychain, but only if the account
/// already had that key as a secret: a new one has nothing stored to keep. The
/// secret the harness requires has to be there.
fn check_env(
    env: &[AccountEnvInput],
    previous: &[AccountEnvVar],
    harness_keys: &[String],
    profile: &AccountProfile,
) -> Result<(), AccountError> {
    for (i, var) in env.iter().enumerate() {
        let key = var.key.as_str();
        if !validate_env_key(key) {
            return Err(invalid(BAD_ENV_NAME));
        }
        if is_verun_env_key(key)
            || harness_keys
                .iter()
                .any(|reserved| reserved.eq_ignore_ascii_case(key))
        {
            return Err(invalid(format!("{key} is reserved for Verun.")));
        }
        if env[..i].iter().any(|earlier| earlier.key == key) {
            return Err(invalid(format!("{key} is set more than once.")));
        }
        let stored = var.secret && previous.iter().any(|old| old.secret && old.key == key);
        if var.entered_value().is_none() && !stored {
            return Err(invalid(format!("{key} needs a value.")));
        }
    }
    if let Some(required) = profile.required_secret {
        if !env.iter().any(|var| var.secret && var.key == required) {
            return Err(invalid(format!("{required} must be set as a secret.")));
        }
    }
    Ok(())
}

/// The env rows to store for `env`. A secret's value belongs in the keychain,
/// so its row has none.
fn env_rows(env: &[AccountEnvInput]) -> Vec<AccountEnvVar> {
    env.iter()
        .map(|var| AccountEnvVar {
            key: var.key.clone(),
            value: if var.secret { None } else { var.value.clone() },
            secret: var.secret,
        })
        .collect()
}

/// The secret values in `env` to put in the keychain, `(key, value)`. A secret
/// without a value is left as it is there.
fn new_secret_values(env: &[AccountEnvInput]) -> Vec<(String, String)> {
    env.iter()
        .filter(|var| var.secret)
        .filter_map(|var| Some((var.key.clone(), var.entered_value()?.to_string())))
        .collect()
}

/// The label to store: trimmed, and not empty.
fn checked_label(label: &str) -> Result<String, AccountError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(invalid("Give the account a name."));
    }
    Ok(label.to_string())
}

/// What a bad folder looks like to the user.
fn dir_error(error: AccountDirError) -> AccountError {
    invalid(error.to_string())
}

/// The harness named `agent_type`. `AgentKind::parse` reads a name it doesn't
/// know as Claude, which would give an account of an unknown harness Claude's
/// rules.
fn harness_kind(agent_type: &str) -> Result<AgentKind, AccountError> {
    AgentKind::all()
        .iter()
        .copied()
        .find(|kind| kind.as_str() == agent_type)
        .ok_or_else(|| invalid(format!("Unknown agent: {agent_type}.")))
}

/// Everything a new account needs, worked out before anything is touched: the
/// row to store, and the secrets to put in the keychain. It holds secret
/// values, so it has no `Debug`.
struct NewAccountPlan {
    account: Account,
    secrets: Vec<(String, String)>,
}

/// The folder of a new account and whether Verun makes it. A folder the user
/// brings is spelled out once here (see `normalize_account_dir`). It may not be
/// their home folder, where the CLI would find the Default account's own files
/// (Claude keeps `~/.claude.json` there), or the root of the disk.
fn plan_dir(
    agent: &dyn Agent,
    profile: &AccountProfile,
    user_home: &Path,
    app_data_dir: &Path,
    id: &str,
    existing_dir: Option<&str>,
) -> Result<(String, bool), AccountError> {
    let Some(existing) = existing_dir else {
        return Ok((managed_account_dir(app_data_dir, id), true));
    };
    if !profile.allows_existing_dir {
        return Err(invalid(format!(
            "{} accounts can't use an existing folder.",
            agent.display_name()
        )));
    }
    let dir = normalize_account_dir(existing, user_home).map_err(dir_error)?;
    let path = Path::new(&dir);
    if path == user_home || path.parent().is_none() {
        return Err(invalid(SHARED_DIR));
    }
    Ok((dir, false))
}

/// Works out what creating the account `id` of `agent`'s harness does, or why it
/// can't be done. Nothing is read from or written to disk, the keychain or the
/// database: what needs them (the folder must exist and not be taken) is
/// checked by `create_account`.
fn plan_new_account(
    agent: &dyn Agent,
    user_home: &Path,
    app_data_dir: &Path,
    input: &NewAccountInput,
    id: &str,
    now: i64,
) -> Result<NewAccountPlan, AccountError> {
    let profile = profile_of(agent)?;
    let label = checked_label(&input.label)?;
    let (config_dir, managed_dir) = plan_dir(
        agent,
        &profile,
        user_home,
        app_data_dir,
        id,
        input.existing_dir.as_deref(),
    )?;
    check_env(
        &input.env,
        &[],
        &harness_env_keys(agent, &profile, &config_dir),
        &profile,
    )?;
    Ok(NewAccountPlan {
        account: Account {
            id: id.to_string(),
            agent_type: agent.kind().as_str().to_string(),
            label,
            color: input.color.clone(),
            config_dir,
            managed_dir,
            env: env_rows(&input.env),
            removed_at: None,
            created_at: now,
        },
        secrets: new_secret_values(&input.env),
    })
}

/// What an edit does, worked out before anything is touched. It holds secret
/// values, so it has no `Debug`.
struct AccountUpdatePlan {
    /// The account as it is after the edit.
    account: Account,
    /// The secret values to put in the keychain, `(key, value)`.
    secrets: Vec<(String, String)>,
    /// The secrets the account had that the edit drops or turns into plain
    /// vars. Their values are left in the keychain until the edit is stored.
    stale: Vec<String>,
}

/// Works out what editing `account` (of `agent`'s harness) to `input` does, or
/// why it can't be done. Only the label, the color and the env change. Like
/// `plan_new_account`, it touches nothing.
fn plan_account_update(
    agent: &dyn Agent,
    account: &Account,
    input: &UpdateAccountInput,
) -> Result<AccountUpdatePlan, AccountError> {
    let profile = profile_of(agent)?;
    let label = checked_label(&input.label)?;
    check_env(
        &input.env,
        &account.env,
        &harness_env_keys(agent, &profile, &account.config_dir),
        &profile,
    )?;
    let env = env_rows(&input.env);
    let stale = account
        .env
        .iter()
        .filter(|old| old.secret)
        .filter(|old| !env.iter().any(|var| var.secret && var.key == old.key))
        .map(|old| old.key.clone())
        .collect();
    Ok(AccountUpdatePlan {
        account: Account {
            label,
            color: input.color.clone(),
            env,
            ..account.clone()
        },
        secrets: new_secret_values(&input.env),
        stale,
    })
}

/// Puts `values` (`(key, value)`) in the keychain under `account`, stopping at
/// the first one the keychain refuses. Blocks, so async callers go through
/// `spawn_blocking`.
fn store_secrets(
    store: &dyn SecretStore,
    account: &Account,
    values: &[(String, String)],
) -> Result<(), AccountError> {
    for (key, value) in values {
        store
            .set(&account.id, key, value)
            .map_err(|message| AccountError::Secret {
                account_id: account.id.clone(),
                label: account.label.clone(),
                message: format!("{key}: {message}"),
            })?;
    }
    Ok(())
}

/// Deletes the secrets `keys` of the account `account_id` from the keychain,
/// as far as it lets Verun. A secret that can't be deleted is only left behind,
/// so each failure is logged by name and the rest are still tried; no error
/// carries a value. Blocks, so async callers go through `spawn_blocking`.
fn forget_secrets(store: &dyn SecretStore, account_id: &str, keys: &[String]) {
    for key in keys {
        if let Err(e) = store.delete(account_id, key) {
            eprintln!(
                "[verun][accounts] couldn't delete secret {key} of account {account_id}: {e}"
            );
        }
    }
}

/// The keys of the secrets among `env`.
fn secret_keys(env: &[AccountEnvVar]) -> Vec<String> {
    env.iter()
        .filter(|var| var.secret)
        .map(|var| var.key.clone())
        .collect()
}

/// Deletes the folder Verun made for `account`, unless that could cost somebody
/// else their files. A folder the user brought is never deleted. Neither is one
/// that is not where Verun makes them (`<app data>/accounts/<id>`), whatever the
/// row says: the row is the only thing between this and an `rm -rf` of any
/// folder. And neither is one that a live account in `accounts` has its home in
/// or under, whatever its harness: an account may be created in the folder of a
/// removed one (only live accounts of the same harness count as taking a
/// folder), and removing the removed one again asks for the folder once more.
/// Blocks, so async callers go through `spawn_blocking`.
fn delete_managed_dir(account: &Account, accounts: &[Account]) {
    if !account.managed_dir {
        return;
    }
    let dir = Path::new(&account.config_dir);
    if !dir.ends_with(Path::new("accounts").join(&account.id)) {
        eprintln!(
            "[verun][accounts] not deleting the folder of account {}: it is not under accounts/{}",
            account.id, account.id
        );
        return;
    }
    let user = accounts.iter().find(|other| {
        other.id != account.id
            && other.removed_at.is_none()
            && Path::new(&other.config_dir).starts_with(dir)
    });
    if let Some(user) = user {
        eprintln!(
            "[verun][accounts] not deleting the folder of account {}: account {} uses it",
            account.id, user.id
        );
        return;
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!(
            "[verun][accounts] couldn't delete the folder of account {}: {e}",
            account.id
        ),
    }
}

/// Queues the write that `write` builds from the sender that confirms it, and
/// waits until the database has stored it. Account changes wait for their
/// writes, unlike most: the next step (or the snapshot the caller sends right
/// after) must see the row.
async fn write_confirmed(
    db_tx: &DbWriteTx,
    write: impl FnOnce(oneshot::Sender<Result<(), String>>) -> DbWrite,
) -> Result<(), AccountError> {
    let (done, receipt) = oneshot::channel();
    db_tx
        .send(write(done))
        .await
        .map_err(|e| database_error(format!("DB write failed: {e}")))?;
    receipt
        .await
        .map_err(|e| database_error(format!("DB write failed: {e}")))?
        .map_err(database_error)
}

/// The Default account of `agent`'s harness and who is signed in to it, or
/// `None` for a harness without account support. Nobody signed in on disk
/// still counts as signed in when Verun itself was started with a key
/// (`has_inherited` says whether a var holds one): the Default account runs on
/// Verun's own env, so the CLI works on it. Reads the CLI's files, so async
/// callers go through `spawn_blocking`.
fn default_view(
    agent: &dyn Agent,
    user_home: &Path,
    has_inherited: &dyn Fn(&str) -> bool,
) -> Option<DefaultAccountView> {
    let profile = agent.account_profile()?;
    let identity = agent.read_account_identity(AccountHome::Default { user_home });
    // The same rule as for an account with the key in its env.
    let inherited: Vec<AccountEnvVar> = profile
        .api_key_vars
        .iter()
        .filter(|key| has_inherited(key))
        .map(|key| AccountEnvVar {
            key: key.to_string(),
            value: None,
            secret: true,
        })
        .collect();
    Some(DefaultAccountView {
        agent_type: agent.kind().as_str().to_string(),
        identity: with_api_key_overlay(identity, &profile, &inherited),
    })
}

/// The identity of every account and every Default, read from disk. A removed
/// account can't be used again, so its files are not read: it gets the default
/// identity. Blocks, so async callers go through `spawn_blocking`.
fn read_identities(
    accounts: Vec<Account>,
    user_home: &Path,
    has_inherited: &dyn Fn(&str) -> bool,
) -> (Vec<AccountView>, Vec<DefaultAccountView>) {
    let views = accounts
        .into_iter()
        .map(|account| {
            let identity = if account.removed_at.is_some() {
                AccountIdentity::default()
            } else {
                let agent = AgentKind::parse(&account.agent_type).implementation();
                account_identity(agent.as_ref(), &account)
            };
            AccountView { account, identity }
        })
        .collect();
    let defaults = AgentKind::all()
        .iter()
        .filter_map(|kind| default_view(kind.implementation().as_ref(), user_home, has_inherited))
        .collect();
    (views, defaults)
}

/// Every account, the Default account of every harness that has account
/// support, and the project bindings, with who is signed in to each read from
/// disk now. Nothing about identity is stored: a CLI signs in and out behind
/// Verun's back.
pub async fn snapshot(pool: &SqlitePool, user_home: &Path) -> Result<AccountsSnapshot, String> {
    snapshot_with(pool, user_home, |key| {
        std::env::var_os(key).is_some_and(|value| !value.is_empty())
    })
    .await
}

/// `snapshot` with the check for a key in Verun's own env supplied, so tests
/// need not touch the process env.
async fn snapshot_with(
    pool: &SqlitePool,
    user_home: &Path,
    has_inherited: impl Fn(&str) -> bool + Send + 'static,
) -> Result<AccountsSnapshot, String> {
    let accounts = db::list_accounts(pool).await?;
    let project_accounts = db::list_project_accounts(pool).await?;
    let user_home = user_home.to_path_buf();
    let (accounts, defaults) =
        tokio::task::spawn_blocking(move || read_identities(accounts, &user_home, &has_inherited))
            .await
            .map_err(|e| format!("Reading the accounts failed: {e}"))?;
    Ok(AccountsSnapshot {
        accounts,
        defaults,
        project_accounts,
    })
}

/// The steps of creating an account that change something outside the
/// database, ending with the row itself: the folder, if Verun makes it, the
/// secrets, and the row. `values` are the secrets to store.
async fn install_account(
    db_tx: &DbWriteTx,
    secrets: Arc<dyn SecretStore>,
    agent: Box<dyn Agent>,
    account: &Account,
    values: Vec<(String, String)>,
) -> Result<(), AccountError> {
    if account.managed_dir {
        let dir = PathBuf::from(&account.config_dir);
        blocking(move || {
            agent
                .prepare_account_dir(&dir)
                .map_err(|e| invalid(format!("Couldn't create the account folder: {e}")))
        })
        .await?;
    }
    let row = account.clone();
    blocking(move || store_secrets(secrets.as_ref(), &row, &values)).await?;
    write_confirmed(db_tx, |done| DbWrite::UpsertAccount {
        account: account.clone(),
        done,
    })
    .await
}

/// Adds the account `id` for the harness `input.agent_type`, made on `now`.
///
/// The account gets a folder of its own under `app_data_dir`, which the harness
/// lays out (see `Agent::prepare_account_dir`), or the folder the user brings
/// in `existing_dir`. A user's folder must exist, may not be the harness's own
/// home or one that another live account of the harness uses, and is never
/// written to. Its spelling is fixed here (see `normalize_account_dir`).
/// `user_home` is what `~` means in it.
///
/// Secret values go to the keychain and the row keeps none. Everything is
/// checked before anything is changed; if a step fails after that, the earlier
/// ones are undone, so a failed create leaves no folder, secret or row behind.
///
/// The folder checks, the keychain calls and the folder work run in
/// `spawn_blocking`.
///
/// The result comes with the turn of the change (see `Turn`), still held. A
/// create that fails gives its turn up.
#[allow(clippy::too_many_arguments)]
pub async fn create_account(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    secrets: Arc<dyn SecretStore>,
    app_data_dir: &Path,
    user_home: &Path,
    input: NewAccountInput,
    id: String,
    now: i64,
) -> Result<(Account, Turn), AccountError> {
    let turn = Turn::take().await;
    let kind = harness_kind(&input.agent_type)?;
    let agent = kind.implementation();
    let NewAccountPlan {
        account,
        secrets: values,
    } = plan_new_account(agent.as_ref(), user_home, app_data_dir, &input, &id, now)?;

    let others = db::list_accounts(pool).await.map_err(database_error)?;
    // The id is the caller's, and a clash would overwrite the other account
    // and, if this create then failed, delete its folder.
    if others.iter().any(|other| other.id == id) {
        return Err(invalid("An account with that id already exists."));
    }
    if !account.managed_dir {
        let taken: Vec<String> = others
            .iter()
            .filter(|other| {
                other.removed_at.is_none() && AgentKind::parse(&other.agent_type) == kind
            })
            .map(|other| other.config_dir.clone())
            .collect();
        let standard_home = agent.account_standard_home(user_home);
        let dir = account.config_dir.clone();
        blocking(move || {
            validate_account_dir(&dir, standard_home.as_deref(), &taken, true).map_err(dir_error)
        })
        .await?;
    }

    let keys: Vec<String> = values.iter().map(|(key, _)| key.clone()).collect();
    let installed = install_account(db_tx, secrets.clone(), agent, &account, values).await;
    if let Err(error) = installed {
        // Take back what it did. A folder the user brought was never written.
        let made = account.clone();
        let id = account.id.clone();
        let _ = blocking(move || {
            forget_secrets(secrets.as_ref(), &id, &keys);
            delete_managed_dir(&made, &others);
            Ok(())
        })
        .await;
        return Err(error);
    }
    Ok((account, turn))
}

/// Changes the label, color and env of the live account `input.id`; the env
/// list is replaced as a whole. A secret that comes without a value keeps the
/// one in the keychain, a secret that is not in the list any more (or became a
/// plain var) is deleted from it, and a new value replaces the old one. The same
/// rules as for a new account apply to the env.
///
/// New secret values are stored before the row is, so a keychain that refuses
/// fails the edit before the row changes. Values stored before the refusal stay:
/// the old ones were not read, so there is nothing to put back. The secrets that
/// went away are deleted after the row is stored: if that fails they only
/// linger, unused, and are logged.
///
/// The result comes with the turn of the change (see `Turn`), still held.
pub async fn update_account(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    secrets: Arc<dyn SecretStore>,
    input: UpdateAccountInput,
) -> Result<(Account, Turn), AccountError> {
    let turn = Turn::take().await;
    let account = live(load_account(pool, &input.id).await?)?;
    let agent = AgentKind::parse(&account.agent_type).implementation();
    let AccountUpdatePlan {
        account: updated,
        secrets: values,
        stale,
    } = plan_account_update(agent.as_ref(), &account, &input)?;

    let row = updated.clone();
    let store = secrets.clone();
    blocking(move || store_secrets(store.as_ref(), &row, &values)).await?;
    write_confirmed(db_tx, |done| DbWrite::UpsertAccount {
        account: updated.clone(),
        done,
    })
    .await?;
    let id = updated.id.clone();
    let _ = blocking(move || {
        forget_secrets(secrets.as_ref(), &id, &stale);
        Ok(())
    })
    .await;
    Ok((updated, turn))
}

/// Removes the account `account_id`: it is marked removed on `now`, and can
/// never run again, but its row stays so the sessions bound to it keep their
/// history. Refused while a project uses it.
///
/// Its secrets are deleted from the keychain, and so is its folder when
/// `delete_dir` is set, Verun made it and no live account uses it (see
/// `delete_managed_dir`). Both
/// happen after the account is marked, as best-effort cleanup: an account
/// stays removable whatever state the keychain or the disk is in, and what a
/// failure leaves behind is only logged. Removing an account that is already
/// removed keeps its first time and runs the cleanup again.
///
/// The result is the turn of the change (see `Turn`), still held.
pub async fn remove_account(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    secrets: Arc<dyn SecretStore>,
    account_id: &str,
    delete_dir: bool,
    now: i64,
) -> Result<Turn, AccountError> {
    let turn = Turn::take().await;
    let account = load_account(pool, account_id).await?;
    let projects = db::projects_using_account(pool, account_id)
        .await
        .map_err(database_error)?;
    if !projects.is_empty() {
        return Err(AccountError::InUse {
            account_id: account_id.to_string(),
            projects,
        });
    }
    let accounts = db::list_accounts(pool).await.map_err(database_error)?;
    if account.removed_at.is_none() {
        write_confirmed(db_tx, |done| DbWrite::MarkAccountRemoved {
            id: account.id.clone(),
            removed_at: now,
            done,
        })
        .await?;
    }
    let _ = blocking(move || {
        forget_secrets(secrets.as_ref(), &account.id, &secret_keys(&account.env));
        if delete_dir {
            delete_managed_dir(&account, &accounts);
        }
        Ok(())
    })
    .await;
    Ok(turn)
}

/// Makes `account_id` the account of `project_id` for the harness
/// `agent_type`, or with `None` clears the choice, so the harness runs on
/// Default. The account must exist, belong to the harness and not be removed.
///
/// The result is the turn of the change (see `Turn`), still held.
pub async fn set_project_account(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    project_id: &str,
    agent_type: &str,
    account_id: Option<String>,
) -> Result<Turn, AccountError> {
    let turn = Turn::take().await;
    let kind = harness_kind(agent_type)?;
    if let Some(account_id) = &account_id {
        load_live_account(pool, account_id, kind.as_str()).await?;
    }
    write_confirmed(db_tx, |done| DbWrite::SetProjectAccount {
        project_id: project_id.to_string(),
        agent_type: kind.as_str().to_string(),
        account_id,
        done,
    })
    .await?;
    Ok(turn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::identity::SignInStatus;
    use crate::accounts::paths::AccountDirError;
    use crate::accounts::secrets::{LockedKeychain, MemorySecretStore};
    use crate::accounts::service::tests::{
        acme, claude_dir, plain_var, secret_var, ThreadSpy, SIGNED_IN,
    };
    use crate::agent::{AccountProfile, Claude, InputMode, ModelOption, SessionArgs};
    use crate::db::tests::{
        make_account, make_project, mark_account_removed_confirmed, set_project_account_confirmed,
        test_pool, upsert_account_confirmed,
    };
    use crate::db::{AccountEnvVar, DbWrite, DbWriteTx, ProjectAccount};
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // -- Fixtures for the account commands --

    /// The change lock is one for the whole process and the tests run in
    /// parallel, so a test that changes accounts or looks at who holds the lock
    /// takes this first (every `Lab` does, for as long as it lives). While one
    /// holds it, no other test is in the middle of a change.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// What the account commands work on: a database with its write queue, a
    /// keychain, the app data dir and the user's home.
    struct Lab {
        pool: SqlitePool,
        db_tx: DbWriteTx,
        store: Arc<dyn SecretStore>,
        app_data: TempDir,
        user_home: TempDir,
        _alone: tokio::sync::MutexGuard<'static, ()>,
    }

    impl Lab {
        async fn new() -> Self {
            Self::with_store(Arc::new(MemorySecretStore::default())).await
        }

        async fn with_store(store: Arc<dyn SecretStore>) -> Self {
            let alone = ONE_AT_A_TIME.lock().await;
            let pool = test_pool().await;
            Self {
                db_tx: db::spawn_write_queue(pool.clone()),
                pool,
                store,
                app_data: TempDir::new().unwrap(),
                user_home: TempDir::new().unwrap(),
                _alone: alone,
            }
        }

        /// A folder in the user's home that exists.
        fn user_dir(&self, name: &str) -> PathBuf {
            let dir = self.user_home.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// Where Verun keeps the home of the managed account `id`.
        fn managed_dir(&self, id: &str) -> PathBuf {
            self.app_data.path().join("accounts").join(id)
        }

        async fn create(&self, id: &str, input: NewAccountInput) -> Result<Account, AccountError> {
            create_account(
                &self.pool,
                &self.db_tx,
                self.store.clone(),
                self.app_data.path(),
                self.user_home.path(),
                input,
                id.into(),
                1000,
            )
            .await
            .map(|(account, _turn)| account)
        }

        async fn update(&self, input: UpdateAccountInput) -> Result<Account, AccountError> {
            update_account(&self.pool, &self.db_tx, self.store.clone(), input)
                .await
                .map(|(account, _turn)| account)
        }

        async fn remove(&self, id: &str, delete_dir: bool) -> Result<(), AccountError> {
            remove_account(
                &self.pool,
                &self.db_tx,
                self.store.clone(),
                id,
                delete_dir,
                2000,
            )
            .await
            .map(|_turn| ())
        }

        async fn bind(
            &self,
            project_id: &str,
            agent_type: &str,
            account_id: Option<&str>,
        ) -> Result<(), AccountError> {
            set_project_account(
                &self.pool,
                &self.db_tx,
                project_id,
                agent_type,
                account_id.map(Into::into),
            )
            .await
            .map(|_turn| ())
        }

        /// The snapshot, with nothing in Verun's own env.
        async fn snapshot(&self) -> AccountsSnapshot {
            snapshot_with(&self.pool, self.user_home.path(), |_| false)
                .await
                .unwrap()
        }

        /// Every stored account, removed ones included.
        async fn stored(&self) -> Vec<Account> {
            db::list_accounts(&self.pool).await.unwrap()
        }

        /// Adds the project "My App" (p-001).
        async fn add_project(&self) {
            db::process_write(&self.pool, DbWrite::InsertProject(make_project()))
                .await
                .unwrap();
        }

        /// The secret in the keychain, if there is one.
        fn secret(&self, account_id: &str, key: &str) -> Option<String> {
            self.store.get(account_id, key).unwrap()
        }
    }

    /// A write queue nobody reads, so every write to it fails.
    fn dead_queue() -> DbWriteTx {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        drop(rx);
        tx
    }

    fn new_claude(label: &str) -> NewAccountInput {
        NewAccountInput {
            agent_type: "claude".into(),
            label: label.into(),
            color: "#d97757".into(),
            existing_dir: None,
            env: vec![],
        }
    }

    fn in_dir(mut input: NewAccountInput, dir: &str) -> NewAccountInput {
        input.existing_dir = Some(dir.into());
        input
    }

    fn with_env(mut input: NewAccountInput, env: Vec<AccountEnvInput>) -> NewAccountInput {
        input.env = env;
        input
    }

    fn plain_in(key: &str, value: &str) -> AccountEnvInput {
        AccountEnvInput {
            key: key.into(),
            value: Some(value.into()),
            secret: false,
        }
    }

    fn secret_in(key: &str, value: Option<&str>) -> AccountEnvInput {
        AccountEnvInput {
            key: key.into(),
            value: value.map(Into::into),
            secret: true,
        }
    }

    /// An edit of account `id` that renames it and sets `env`.
    fn edit(id: &str, env: Vec<AccountEnvInput>) -> UpdateAccountInput {
        UpdateAccountInput {
            id: id.into(),
            label: "Renamed".into(),
            color: "#000000".into(),
            env,
        }
    }

    /// The message of an `Invalid` error; panics on anything else.
    fn invalid_message<T: std::fmt::Debug>(result: Result<T, AccountError>) -> String {
        match result {
            Err(AccountError::Invalid { message }) => message,
            other => panic!("expected an Invalid error, got {other:?}"),
        }
    }

    /// A harness with the account support a test gives it, for the cases no
    /// real harness covers: no support at all, its own env vars, a required
    /// secret and no existing folders. It stands in for Claude unless `of`
    /// says another harness. Its Default account has the status given and the
    /// email of the home it is read from.
    struct StubHarness {
        kind: AgentKind,
        profile: Option<AccountProfile>,
        default_status: SignInStatus,
    }

    impl StubHarness {
        fn new() -> Self {
            Self {
                kind: AgentKind::Claude,
                profile: Some(AccountProfile {
                    scrub_vars: &[],
                    fixed_env: &[("STUB_FIXED", "1")],
                    api_key_vars: &["STUB_API_KEY"],
                    login_args: None,
                    logout_args: None,
                    login_hint: None,
                    logout_hint: None,
                    allows_existing_dir: false,
                    required_secret: Some("STUB_SECRET"),
                    in_project_env: true,
                    min_cli_version: None,
                }),
                default_status: SignInStatus::SignedIn,
            }
        }

        fn without_profile() -> Self {
            Self {
                profile: None,
                ..Self::new()
            }
        }

        /// The same, as the harness `kind`: its accounts are stored under it.
        fn of(self, kind: AgentKind) -> Self {
            Self { kind, ..self }
        }

        /// The same, taking a folder the user brings.
        fn taking_existing_dirs(self) -> Self {
            Self {
                profile: self.profile.map(|profile| AccountProfile {
                    allows_existing_dir: true,
                    ..profile
                }),
                ..self
            }
        }

        fn signed(status: SignInStatus) -> Self {
            Self {
                default_status: status,
                ..Self::new()
            }
        }
    }

    impl Agent for StubHarness {
        fn kind(&self) -> AgentKind {
            self.kind
        }
        fn display_name(&self) -> &'static str {
            "Stub CLI"
        }
        fn cli_binary(&self) -> &'static str {
            "stub"
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
            vec![("STUB_HOME".into(), dir.to_string_lossy().into_owned())]
        }
        fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
            match home {
                AccountHome::Default { user_home } => AccountIdentity {
                    status: self.default_status,
                    email: Some(user_home.to_string_lossy().into_owned()),
                    ..AccountIdentity::default()
                },
                AccountHome::Dir(_) => AccountIdentity::default(),
            }
        }
    }

    // -- Env var names --

    #[test]
    fn validate_env_key_accepts_shell_names_only() {
        for key in ["A", "_", "ANTHROPIC_API_KEY", "_x1", "a_B_9"] {
            assert!(validate_env_key(key), "{key}");
        }
        for key in [
            "", "1A", "BAD-KEY", "A B", "A=B", "A.B", "\u{c4}", "A\n", "$(x)", "A;B",
        ] {
            assert!(!validate_env_key(key), "{key:?}");
        }
    }

    #[test]
    fn env_input_debug_hides_secret_values() {
        let secret = secret_in("ANTHROPIC_API_KEY", Some("sk-ant-leak"));
        let shown = format!("{secret:?}");
        assert!(shown.contains("ANTHROPIC_API_KEY"), "{shown}");
        assert!(!shown.contains("sk-ant-leak"), "{shown}");

        // Input that holds it shows no more than the var does.
        let input = with_env(new_claude("Acme"), vec![secret]);
        assert!(!format!("{input:?}").contains("sk-ant-leak"));

        // A plain value is no secret.
        assert!(
            format!("{:?}", plain_in("ANTHROPIC_BASE_URL", "https://proxy"))
                .contains("https://proxy")
        );
    }

    #[test]
    fn account_input_reads_the_shapes_the_frontend_sends() {
        let new: NewAccountInput = serde_json::from_value(json!({
            "agentType": "claude",
            "label": "Acme",
            "color": "#d97757",
            "existingDir": null,
            "env": [
                {"key": "ANTHROPIC_API_KEY", "value": null, "secret": true},
                {"key": "ANTHROPIC_BASE_URL", "value": "https://proxy", "secret": false},
            ],
        }))
        .unwrap();
        assert_eq!(new.agent_type, "claude");
        assert_eq!(new.existing_dir, None);
        assert_eq!(new.env.len(), 2);
        assert_eq!(new.env[0].value, None);
        assert!(new.env[0].secret);

        let existing: NewAccountInput = serde_json::from_value(json!({
            "agentType": "codex", "label": "x", "color": "#000", "existingDir": "~/c", "env": [],
        }))
        .unwrap();
        assert_eq!(existing.existing_dir.as_deref(), Some("~/c"));

        let update: UpdateAccountInput = serde_json::from_value(json!({
            "id": "a1", "label": "Acme", "color": "#000", "env": [],
        }))
        .unwrap();
        assert_eq!(update.id, "a1");
    }

    // -- Planning a new account --

    fn plan(agent: &dyn Agent, input: &NewAccountInput) -> Result<NewAccountPlan, AccountError> {
        plan_new_account(
            agent,
            Path::new("/Users/me"),
            Path::new("/app"),
            input,
            "a1",
            1000,
        )
    }

    /// The message of the `Invalid` error that planning `input` fails with. (A
    /// plan holds secret values, so it has no `Debug` for the failure message.)
    fn refused(agent: &dyn Agent, input: NewAccountInput) -> String {
        invalid_message(plan(agent, &input).map(|_| ()))
    }

    #[test]
    fn plan_gives_a_new_account_a_folder_of_its_own() {
        let plan = plan(&Claude, &new_claude("  Acme \n")).unwrap();

        assert_eq!(
            plan.account,
            Account {
                id: "a1".into(),
                agent_type: "claude".into(),
                label: "Acme".into(),
                color: "#d97757".into(),
                config_dir: "/app/accounts/a1".into(),
                managed_dir: true,
                env: vec![],
                removed_at: None,
                created_at: 1000,
            }
        );
        assert!(plan.secrets.is_empty());
    }

    #[test]
    fn plan_keeps_the_folder_a_user_brings_as_normalized() {
        let plan = plan(&Claude, &in_dir(new_claude("Acme"), "~/accounts/./acme/")).unwrap();

        assert_eq!(plan.account.config_dir, "/Users/me/accounts/acme");
        assert!(!plan.account.managed_dir);
    }

    #[test]
    fn plan_rejects_folders_that_are_not_paths() {
        for (dir, message) in [
            ("", "Choose a folder path."),
            ("   ", "Choose a folder path."),
            ("rel/dir", "Use an absolute folder path."),
        ] {
            assert_eq!(
                refused(&Claude, in_dir(new_claude("Acme"), dir)),
                message,
                "dir: {dir:?}"
            );
        }
    }

    #[test]
    fn plan_rejects_the_users_home_and_the_root_of_the_disk() {
        // CLAUDE_CONFIG_DIR=~ would make Claude read Default's own
        // ~/.claude.json, which is what refusing ~/.claude is for.
        for dir in [
            "~",
            "~/",
            "/Users/me",
            "/Users/me/",
            "/Users/me/./",
            "/",
            "/..",
            "/x/..",
        ] {
            assert_eq!(
                refused(&Claude, in_dir(new_claude("Acme"), dir)),
                "Choose a folder of its own, not your home folder or the root of the disk.",
                "dir: {dir:?}"
            );
        }
        // Only the home itself: what is inside it is fine.
        assert!(plan(&Claude, &in_dir(new_claude("Acme"), "~/acme")).is_ok());
    }

    #[test]
    fn plan_needs_a_label() {
        for label in ["", "   ", "\t\n"] {
            assert_eq!(
                refused(&Claude, new_claude(label)),
                "Give the account a name.",
                "label: {label:?}"
            );
        }
    }

    #[test]
    fn plan_needs_a_harness_with_account_support() {
        assert_eq!(
            refused(&StubHarness::without_profile(), new_claude("Acme")),
            "Stub CLI does not support multiple accounts"
        );
    }

    #[test]
    fn plan_refuses_an_existing_folder_when_the_harness_does_not_take_one() {
        assert_eq!(
            refused(&StubHarness::new(), in_dir(new_claude("Acme"), "/x/acme")),
            "Stub CLI accounts can't use an existing folder."
        );
    }

    #[test]
    fn plan_puts_plain_values_in_the_row_and_secrets_in_the_keychain() {
        let input = with_env(
            new_claude("Acme"),
            vec![
                plain_in("ANTHROPIC_BASE_URL", "https://proxy"),
                secret_in("ANTHROPIC_API_KEY", Some("sk-1")),
            ],
        );

        let plan = plan(&Claude, &input).unwrap();

        assert_eq!(
            plan.account.env,
            vec![
                plain_var("ANTHROPIC_BASE_URL", "https://proxy"),
                secret_var("ANTHROPIC_API_KEY")
            ]
        );
        assert_eq!(
            plan.secrets,
            vec![("ANTHROPIC_API_KEY".to_string(), "sk-1".to_string())]
        );
    }

    #[test]
    fn plan_rejects_env_names_a_shell_cannot_export() {
        for key in ["BAD-KEY", "1A", "", "A B", "A=B", "A;rm -rf /"] {
            assert_eq!(
                refused(
                    &Claude,
                    with_env(new_claude("Acme"), vec![plain_in(key, "x")])
                ),
                "Env var names use letters, digits and underscores, and can't start with a digit.",
                "key: {key:?}"
            );
        }
    }

    #[test]
    fn plan_rejects_the_names_verun_reserves() {
        for key in [
            "VERUN_ACCOUNT_SCRIPT",
            "VERUN_PORT_0",
            "verun_anything",
            "CLAUDECODE",
            "claudecode",
            "CLAUDE_CODE_ENTRYPOINT",
            // The home var of the account: it would re-point the account.
            "CLAUDE_CONFIG_DIR",
            "claude_config_dir",
        ] {
            assert_eq!(
                refused(
                    &Claude,
                    with_env(new_claude("Acme"), vec![plain_in(key, "x")])
                ),
                format!("{key} is reserved for Verun."),
                "key: {key}"
            );
        }
    }

    #[test]
    fn plan_rejects_the_vars_the_harness_sets_for_every_account() {
        // The stub's home var, and a var in its fixed env.
        for key in ["STUB_HOME", "STUB_FIXED"] {
            let input = with_env(
                new_claude("Acme"),
                vec![secret_in("STUB_SECRET", Some("sk-1")), plain_in(key, "x")],
            );
            assert_eq!(
                refused(&StubHarness::new(), input),
                format!("{key} is reserved for Verun."),
                "key: {key}"
            );
        }
    }

    #[test]
    fn plan_allows_provider_vars_and_names_that_differ_only_in_case() {
        let input = with_env(
            new_claude("Acme"),
            vec![
                plain_in("ANTHROPIC_BASE_URL", "https://proxy"),
                plain_in("CLAUDE_CODE_USE_BEDROCK", "1"),
                // Tools read either spelling of the proxy vars.
                plain_in("http_proxy", "http://p"),
                plain_in("HTTP_PROXY", "http://p"),
            ],
        );
        assert!(plan(&Claude, &input).is_ok());
    }

    #[test]
    fn plan_rejects_a_var_given_twice() {
        for env in [
            vec![plain_in("A", "1"), plain_in("A", "2")],
            vec![plain_in("A", "1"), secret_in("A", Some("sk"))],
        ] {
            assert_eq!(
                refused(&Claude, with_env(new_claude("Acme"), env)),
                "A is set more than once."
            );
        }
    }

    #[test]
    fn plan_rejects_a_plain_var_without_a_value() {
        // An empty key would also count as an API key to the sign-in check.
        for value in [None, Some("")] {
            let var = AccountEnvInput {
                key: "ANTHROPIC_API_KEY".into(),
                value: value.map(Into::into),
                secret: false,
            };
            assert_eq!(
                refused(&Claude, with_env(new_claude("Acme"), vec![var])),
                "ANTHROPIC_API_KEY needs a value.",
                "value: {value:?}"
            );
        }
    }

    #[test]
    fn plan_rejects_a_new_secret_without_a_value() {
        // A new account has no stored value to keep.
        for value in [None, Some("")] {
            assert_eq!(
                refused(
                    &Claude,
                    with_env(
                        new_claude("Acme"),
                        vec![secret_in("ANTHROPIC_API_KEY", value)]
                    )
                ),
                "ANTHROPIC_API_KEY needs a value.",
                "value: {value:?}"
            );
        }
    }

    #[test]
    fn plan_needs_the_secret_the_harness_requires() {
        let with = |env| with_env(new_claude("Acme"), env);
        let required = "STUB_SECRET must be set as a secret.";

        assert_eq!(refused(&StubHarness::new(), with(vec![])), required);
        // A plain var of that name is no secret.
        assert_eq!(
            refused(
                &StubHarness::new(),
                with(vec![plain_in("STUB_SECRET", "x")])
            ),
            required
        );
        assert_eq!(
            refused(
                &StubHarness::new(),
                with(vec![secret_in("STUB_SECRET", None)])
            ),
            "STUB_SECRET needs a value."
        );

        let plan = plan(
            &StubHarness::new(),
            &with(vec![secret_in("STUB_SECRET", Some("key-1"))]),
        )
        .unwrap();
        assert_eq!(
            plan.secrets,
            vec![("STUB_SECRET".to_string(), "key-1".to_string())]
        );
    }

    // -- Planning an edit --

    fn stored_with(env: Vec<AccountEnvVar>) -> Account {
        let mut account = make_account("a1", 1000);
        account.env = env;
        account
    }

    fn edited(
        agent: &dyn Agent,
        account: &Account,
        env: Vec<AccountEnvInput>,
    ) -> Result<AccountUpdatePlan, AccountError> {
        plan_account_update(agent, account, &edit("a1", env))
    }

    /// The message of the `Invalid` error that editing fails with.
    fn refused_edit(agent: &dyn Agent, account: &Account, env: Vec<AccountEnvInput>) -> String {
        invalid_message(edited(agent, account, env).map(|_| ()))
    }

    #[test]
    fn plan_update_replaces_label_color_and_env_and_nothing_else() {
        let account = stored_with(vec![plain_var("OLD", "1")]);

        let plan = edited(&Claude, &account, vec![plain_in("NEW", "2")]).unwrap();

        assert_eq!(
            plan.account,
            Account {
                label: "Renamed".into(),
                color: "#000000".into(),
                env: vec![plain_var("NEW", "2")],
                ..account
            }
        );
    }

    #[test]
    fn plan_update_keeps_a_secret_that_comes_without_a_value() {
        let account = stored_with(vec![secret_var("A_KEY"), secret_var("B_KEY")]);

        // The empty string is what a blank field sends: no new value either.
        for value in [None, Some("")] {
            let plan = edited(
                &Claude,
                &account,
                vec![secret_in("A_KEY", value), secret_in("B_KEY", Some("new-b"))],
            )
            .unwrap();

            assert_eq!(
                plan.account.env,
                vec![secret_var("A_KEY"), secret_var("B_KEY")]
            );
            assert_eq!(
                plan.secrets,
                vec![("B_KEY".to_string(), "new-b".to_string())]
            );
            assert!(plan.stale.is_empty());
        }
    }

    #[test]
    fn plan_update_forgets_secrets_that_are_gone_or_became_plain() {
        let account = stored_with(vec![
            secret_var("A_KEY"),
            secret_var("B_KEY"),
            secret_var("C_KEY"),
        ]);

        let plan = edited(
            &Claude,
            &account,
            vec![secret_in("A_KEY", None), plain_in("B_KEY", "now plain")],
        )
        .unwrap();

        assert_eq!(
            plan.account.env,
            vec![secret_var("A_KEY"), plain_var("B_KEY", "now plain")]
        );
        assert_eq!(plan.stale, vec!["B_KEY".to_string(), "C_KEY".to_string()]);
        assert!(plan.secrets.is_empty());
    }

    #[test]
    fn plan_update_needs_a_value_for_a_secret_with_none_stored() {
        // Nothing is stored for a var that was plain, or is new.
        let account = stored_with(vec![plain_var("WAS_PLAIN", "x")]);

        for key in ["WAS_PLAIN", "BRAND_NEW"] {
            assert_eq!(
                refused_edit(&Claude, &account, vec![secret_in(key, None)]),
                format!("{key} needs a value."),
                "key: {key}"
            );
        }
        let plan = edited(
            &Claude,
            &account,
            vec![secret_in("WAS_PLAIN", Some("sk-1"))],
        )
        .unwrap();
        assert_eq!(plan.account.env, vec![secret_var("WAS_PLAIN")]);
        assert_eq!(
            plan.secrets,
            vec![("WAS_PLAIN".to_string(), "sk-1".to_string())]
        );
        assert!(plan.stale.is_empty());
    }

    #[test]
    fn plan_update_applies_the_rules_of_a_new_account() {
        let account = stored_with(vec![]);

        assert_eq!(
            refused_edit(&Claude, &account, vec![plain_in("BAD-KEY", "x")]),
            "Env var names use letters, digits and underscores, and can't start with a digit."
        );
        assert_eq!(
            refused_edit(&Claude, &account, vec![plain_in("CLAUDE_CONFIG_DIR", "/x")]),
            "CLAUDE_CONFIG_DIR is reserved for Verun."
        );
        assert_eq!(
            refused_edit(
                &Claude,
                &account,
                vec![plain_in("A", "1"), plain_in("A", "2")]
            ),
            "A is set more than once."
        );
        assert_eq!(
            refused_edit(&Claude, &account, vec![plain_in("A", "")]),
            "A needs a value."
        );
        let blank = UpdateAccountInput {
            label: "  ".into(),
            ..edit("a1", vec![])
        };
        assert_eq!(
            invalid_message(plan_account_update(&Claude, &account, &blank).map(|_| ())),
            "Give the account a name."
        );
    }

    #[test]
    fn plan_update_keeps_the_secret_the_harness_requires() {
        let account = stored_with(vec![secret_var("STUB_SECRET")]);
        let stub = StubHarness::new();

        // Kept as it is, or replaced.
        assert!(edited(&stub, &account, vec![secret_in("STUB_SECRET", None)]).is_ok());
        assert!(edited(&stub, &account, vec![secret_in("STUB_SECRET", Some("k2"))]).is_ok());
        // Dropped, or turned into a plain var.
        let required = "STUB_SECRET must be set as a secret.";
        assert_eq!(refused_edit(&stub, &account, vec![]), required);
        assert_eq!(
            refused_edit(&stub, &account, vec![plain_in("STUB_SECRET", "x")]),
            required
        );
    }

    // -- create_account --

    #[tokio::test]
    async fn create_managed_claude_account_creates_dir() {
        let lab = Lab::new().await;

        let account = lab.create("a1", new_claude("Acme")).await.unwrap();

        let dir = lab.managed_dir("a1");
        assert!(dir.is_dir());
        assert_eq!(account.config_dir, dir.to_string_lossy());
        assert!(account.managed_dir);
        assert_eq!(account.agent_type, "claude");
        assert_eq!(account.label, "Acme");
        assert_eq!(account.created_at, 1000);
        assert_eq!(account.removed_at, None);
        // What was returned is what was stored.
        assert_eq!(lab.stored().await, vec![account]);
    }

    #[tokio::test]
    async fn create_existing_dir_account_normalizes_and_does_not_write() {
        let lab = Lab::new().await;
        let dir = lab.user_dir("x");

        let account = lab
            .create("a1", in_dir(new_claude("Acme"), "~/x/"))
            .await
            .unwrap();

        assert_eq!(account.config_dir, dir.to_str().unwrap());
        assert!(!account.managed_dir);
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "nothing is written into a folder the user brought"
        );
        assert!(!lab.managed_dir("a1").exists());
        assert_eq!(lab.stored().await, vec![account]);
    }

    #[tokio::test]
    async fn create_rejects_standard_home() {
        let lab = Lab::new().await;

        let result = lab
            .create("a1", in_dir(new_claude("Acme"), "~/.claude"))
            .await;

        assert_eq!(
            invalid_message(result),
            AccountDirError::StandardHome.to_string()
        );
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_rejects_the_users_home() {
        let lab = Lab::new().await;
        lab.user_dir("anything");

        for dir in ["~", lab.user_home.path().to_str().unwrap()] {
            let result = lab.create("a1", in_dir(new_claude("Acme"), dir)).await;
            assert_eq!(
                invalid_message(result),
                "Choose a folder of its own, not your home folder or the root of the disk.",
                "dir: {dir}"
            );
        }
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_rejects_duplicate_dir() {
        let lab = Lab::new().await;
        let dir = lab.user_dir("shared");
        let dir = dir.to_str().unwrap();
        lab.create("a1", in_dir(new_claude("Acme"), dir))
            .await
            .unwrap();

        // The same folder, spelled another way.
        let result = lab
            .create("a2", in_dir(new_claude("Other"), &format!("{dir}/")))
            .await;

        assert_eq!(
            invalid_message(result),
            AccountDirError::Duplicate.to_string()
        );
        assert_eq!(lab.stored().await.len(), 1);
    }

    #[tokio::test]
    async fn create_only_compares_dirs_with_live_accounts_of_the_same_harness() {
        let lab = Lab::new().await;
        let dir = lab.user_dir("shared");
        let dir = dir.to_str().unwrap();
        // A removed Claude account and a live Codex account used the folder.
        let mut gone = make_account("gone", 100);
        gone.config_dir = dir.into();
        gone.managed_dir = false;
        upsert_account_confirmed(&lab.pool, gone).await.unwrap();
        mark_account_removed_confirmed(&lab.pool, "gone", 200)
            .await
            .unwrap();
        let mut codex = make_account("c1", 100);
        codex.agent_type = "codex".into();
        codex.config_dir = dir.into();
        upsert_account_confirmed(&lab.pool, codex).await.unwrap();

        let account = lab.create("a1", in_dir(new_claude("Acme"), dir)).await;

        assert_eq!(account.unwrap().config_dir, dir);
    }

    #[tokio::test]
    async fn create_rejects_a_folder_that_is_not_there() {
        let lab = Lab::new().await;
        let file = lab.user_home.path().join("file");
        std::fs::write(&file, "").unwrap();

        for (dir, error) in [
            ("~/missing", AccountDirError::Missing),
            ("~/file", AccountDirError::NotADirectory),
        ] {
            let result = lab.create("a1", in_dir(new_claude("Acme"), dir)).await;
            assert_eq!(invalid_message(result), error.to_string(), "dir: {dir}");
        }
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_rejects_an_unknown_harness() {
        let lab = Lab::new().await;
        let mut input = new_claude("Acme");
        // `AgentKind::parse` would read this as Claude.
        input.agent_type = "bogus".into();

        let result = lab.create("a1", input).await;

        assert_eq!(invalid_message(result), "Unknown agent: bogus.");
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_refuses_an_id_that_is_taken() {
        let lab = Lab::new().await;
        let first = lab.create("a1", new_claude("Acme")).await.unwrap();
        std::fs::write(lab.managed_dir("a1").join("login"), "x").unwrap();

        let result = lab.create("a1", new_claude("Other")).await;

        assert_eq!(
            invalid_message(result),
            "An account with that id already exists."
        );
        // Neither the row nor the folder of the first one was touched.
        assert_eq!(lab.stored().await, vec![first]);
        assert!(lab.managed_dir("a1").join("login").exists());
    }

    #[tokio::test]
    async fn create_stores_secret_in_store_not_db() {
        let lab = Lab::new().await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                plain_in("ANTHROPIC_BASE_URL", "https://proxy"),
                secret_in("ANTHROPIC_API_KEY", Some("sk-1")),
            ],
        );

        let account = lab.create("a1", input).await.unwrap();

        let rows = vec![
            plain_var("ANTHROPIC_BASE_URL", "https://proxy"),
            secret_var("ANTHROPIC_API_KEY"),
        ];
        assert_eq!(account.env, rows);
        assert_eq!(lab.stored().await[0].env, rows);
        assert_eq!(
            lab.secret("a1", "ANTHROPIC_API_KEY").as_deref(),
            Some("sk-1")
        );
        let raw: String = sqlx::query_scalar("SELECT env FROM accounts WHERE id = 'a1'")
            .fetch_one(&lab.pool)
            .await
            .unwrap();
        assert!(!raw.contains("sk-1"), "{raw}");
    }

    #[tokio::test]
    async fn create_rejects_invalid_env_key() {
        let lab = Lab::new().await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                secret_in("ANTHROPIC_API_KEY", Some("sk-1")),
                plain_in("BAD-KEY", "x"),
            ],
        );

        let result = lab.create("a1", input).await;

        assert!(matches!(result, Err(AccountError::Invalid { .. })));
        // Checked before anything is done: no row, no folder, no secret.
        assert!(lab.stored().await.is_empty());
        assert!(!lab.managed_dir("a1").exists());
        assert_eq!(lab.secret("a1", "ANTHROPIC_API_KEY"), None);
    }

    #[tokio::test]
    async fn create_undoes_what_it_did_when_the_row_cannot_be_stored() {
        let mut lab = Lab::new().await;
        lab.db_tx = dead_queue();
        let input = with_env(
            new_claude("Acme"),
            vec![secret_in("ANTHROPIC_API_KEY", Some("sk-1"))],
        );

        let result = lab.create("a1", input).await;

        assert!(matches!(result, Err(AccountError::Invalid { .. })));
        assert_eq!(lab.secret("a1", "ANTHROPIC_API_KEY"), None);
        assert!(!lab.managed_dir("a1").exists());
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_leaves_nothing_behind_when_the_keychain_refuses() {
        let lab = Lab::with_store(Arc::new(LockedKeychain)).await;
        let input = with_env(
            new_claude("Acme"),
            vec![secret_in("ANTHROPIC_API_KEY", Some("sk-1"))],
        );

        let result = lab.create("a1", input).await;

        assert_eq!(
            result,
            Err(AccountError::Secret {
                account_id: "a1".into(),
                label: "Acme".into(),
                message: "ANTHROPIC_API_KEY: keychain is locked".into(),
            })
        );
        assert!(!lab.managed_dir("a1").exists());
        assert!(lab.stored().await.is_empty());
    }

    #[tokio::test]
    async fn create_reports_a_folder_it_cannot_make() {
        let lab = Lab::new().await;
        // `accounts` is a file, so nothing can be made under it.
        std::fs::write(lab.app_data.path().join("accounts"), "").unwrap();

        let result = lab.create("a1", new_claude("Acme")).await;

        assert!(
            invalid_message(result).starts_with("Couldn't create the account folder"),
            "the folder is the reason"
        );
        assert!(lab.stored().await.is_empty());
    }

    // -- update_account --

    #[tokio::test]
    async fn update_keeps_omitted_secret_and_deletes_removed_secret() {
        let lab = Lab::new().await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                secret_in("A_KEY", Some("sk-a")),
                secret_in("B_KEY", Some("sk-b")),
                plain_in("PLAIN", "1"),
            ],
        );
        lab.create("a1", input).await.unwrap();

        let updated = lab
            .update(edit(
                "a1",
                vec![secret_in("A_KEY", None), plain_in("NEW_PLAIN", "2")],
            ))
            .await
            .unwrap();

        assert_eq!(updated.label, "Renamed");
        assert_eq!(updated.color, "#000000");
        assert_eq!(
            updated.env,
            vec![secret_var("A_KEY"), plain_var("NEW_PLAIN", "2")]
        );
        assert_eq!(lab.secret("a1", "A_KEY").as_deref(), Some("sk-a"));
        assert_eq!(lab.secret("a1", "B_KEY"), None);
        assert_eq!(lab.stored().await, vec![updated]);
    }

    #[tokio::test]
    async fn update_replaces_a_secret_and_forgets_one_turned_plain() {
        let lab = Lab::new().await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                secret_in("A_KEY", Some("sk-a")),
                secret_in("B_KEY", Some("sk-b")),
            ],
        );
        let created = lab.create("a1", input).await.unwrap();

        let updated = lab
            .update(edit(
                "a1",
                vec![
                    secret_in("A_KEY", Some("sk-a2")),
                    plain_in("B_KEY", "not secret"),
                ],
            ))
            .await
            .unwrap();

        assert_eq!(lab.secret("a1", "A_KEY").as_deref(), Some("sk-a2"));
        assert_eq!(lab.secret("a1", "B_KEY"), None);
        assert_eq!(
            updated.env,
            vec![secret_var("A_KEY"), plain_var("B_KEY", "not secret")]
        );
        // The dir, harness and creation time never change.
        assert_eq!(updated.config_dir, created.config_dir);
        assert_eq!(updated.created_at, created.created_at);
    }

    #[tokio::test]
    async fn update_refuses_unknown_and_removed_accounts() {
        let lab = Lab::new().await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        lab.remove("a1", false).await.unwrap();

        assert_eq!(
            lab.update(edit("a1", vec![])).await,
            Err(AccountError::Removed {
                account_id: "a1".into(),
                label: "Acme".into()
            })
        );
        assert_eq!(
            lab.update(edit("nope", vec![])).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn update_changes_nothing_when_the_new_env_is_refused() {
        let lab = Lab::new().await;
        let input = with_env(new_claude("Acme"), vec![secret_in("A_KEY", Some("sk-a"))]);
        let created = lab.create("a1", input).await.unwrap();

        let result = lab
            .update(edit(
                "a1",
                vec![secret_in("A_KEY", Some("sk-new")), plain_in("BAD-KEY", "x")],
            ))
            .await;

        assert!(matches!(result, Err(AccountError::Invalid { .. })));
        assert_eq!(lab.stored().await, vec![created]);
        assert_eq!(lab.secret("a1", "A_KEY").as_deref(), Some("sk-a"));
    }

    #[tokio::test]
    async fn update_leaves_the_account_alone_when_the_keychain_refuses() {
        let lab = Lab::with_store(Arc::new(LockedKeychain)).await;
        let created = lab.create("a1", new_claude("Acme")).await.unwrap();

        let result = lab
            .update(edit("a1", vec![secret_in("A_KEY", Some("sk-a"))]))
            .await;

        assert!(
            matches!(result, Err(AccountError::Secret { .. })),
            "{result:?}"
        );
        assert_eq!(lab.stored().await, vec![created]);
    }

    // -- remove_account --

    #[tokio::test]
    async fn remove_blocked_while_project_uses_account() {
        let lab = Lab::new().await;
        lab.add_project().await;
        let input = with_env(new_claude("Acme"), vec![secret_in("A_KEY", Some("sk-a"))]);
        lab.create("a1", input).await.unwrap();
        lab.bind("p-001", "claude", Some("a1")).await.unwrap();

        let result = lab.remove("a1", true).await;

        assert_eq!(
            result,
            Err(AccountError::InUse {
                account_id: "a1".into(),
                projects: vec!["My App".into()]
            })
        );
        // Nothing was touched.
        assert_eq!(lab.stored().await[0].removed_at, None);
        assert_eq!(lab.secret("a1", "A_KEY").as_deref(), Some("sk-a"));
        assert!(lab.managed_dir("a1").is_dir());

        // Once the project lets go, it can go.
        lab.bind("p-001", "claude", None).await.unwrap();
        lab.remove("a1", false).await.unwrap();
        assert_eq!(lab.stored().await[0].removed_at, Some(2000));
    }

    #[tokio::test]
    async fn remove_deletes_secrets_and_managed_dir_when_asked() {
        let lab = Lab::new().await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                secret_in("A_KEY", Some("sk-a")),
                secret_in("B_KEY", Some("sk-b")),
                plain_in("PLAIN", "1"),
            ],
        );
        lab.create("a1", input).await.unwrap();
        // Another account's secret under the same name stays.
        lab.store.set("a2", "A_KEY", "sk-other").unwrap();
        std::fs::write(lab.managed_dir("a1").join(".claude.json"), "{}").unwrap();

        lab.remove("a1", true).await.unwrap();

        let stored = lab.stored().await;
        assert_eq!(
            stored.len(),
            1,
            "removing marks the row, it does not delete"
        );
        assert_eq!(stored[0].removed_at, Some(2000));
        assert_eq!(lab.secret("a1", "A_KEY"), None);
        assert_eq!(lab.secret("a1", "B_KEY"), None);
        assert_eq!(lab.secret("a2", "A_KEY").as_deref(), Some("sk-other"));
        assert!(!lab.managed_dir("a1").exists());
    }

    #[tokio::test]
    async fn remove_keeps_the_managed_dir_unless_asked_but_still_forgets_secrets() {
        let lab = Lab::new().await;
        let input = with_env(new_claude("Acme"), vec![secret_in("A_KEY", Some("sk-a"))]);
        lab.create("a1", input).await.unwrap();

        lab.remove("a1", false).await.unwrap();

        assert!(lab.managed_dir("a1").is_dir());
        assert_eq!(lab.secret("a1", "A_KEY"), None);
    }

    #[tokio::test]
    async fn remove_never_deletes_user_dir() {
        let lab = Lab::new().await;
        // Even one that looks like a managed folder: it is the user's.
        let dir = lab.user_dir("accounts/a1");
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        let input = with_env(new_claude("Acme"), vec![secret_in("A_KEY", Some("sk-a"))]);
        lab.create("a1", in_dir(input, dir.to_str().unwrap()))
            .await
            .unwrap();

        lab.remove("a1", true).await.unwrap();

        assert!(dir.join(".claude.json").exists(), "the user's folder stays");
        assert_eq!(lab.secret("a1", "A_KEY"), None);
        assert_eq!(lab.stored().await[0].removed_at, Some(2000));
    }

    #[tokio::test]
    async fn remove_deletes_no_dir_that_is_not_an_accounts_folder_of_its_id() {
        let lab = Lab::new().await;
        let dir = lab.user_dir("precious");
        std::fs::write(dir.join("notes"), "x").unwrap();
        // A row that says Verun made a folder it did not make: whatever
        // happened to it, deleting that folder is not Verun's to do.
        let mut account = make_account("a1", 1000);
        account.managed_dir = true;
        account.config_dir = dir.to_str().unwrap().into();
        upsert_account_confirmed(&lab.pool, account).await.unwrap();

        lab.remove("a1", true).await.unwrap();

        assert!(dir.join("notes").exists());
        assert_eq!(lab.stored().await[0].removed_at, Some(2000));
    }

    #[tokio::test]
    async fn remove_keeps_a_folder_another_account_has_moved_into() {
        let lab = Lab::new().await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        // Removed with its folder kept, so the folder is free for a new account.
        lab.remove("a1", false).await.unwrap();
        let dir = lab.managed_dir("a1");
        std::fs::write(dir.join(".claude.json"), SIGNED_IN).unwrap();
        lab.create("b1", in_dir(new_claude("Other"), dir.to_str().unwrap()))
            .await
            .unwrap();

        // Asked again, with the folder this time: it is b1's now.
        lab.remove("a1", true).await.unwrap();

        assert!(dir.join(".claude.json").exists(), "b1 is still signed in");
        assert_eq!(lab.stored().await[1].removed_at, None);
    }

    #[tokio::test]
    async fn remove_keeps_a_folder_a_live_account_of_another_harness_uses() {
        let lab = Lab::new().await;
        let account = lab.create("a1", new_claude("Acme")).await.unwrap();
        let dir = lab.managed_dir("a1");
        std::fs::write(dir.join("login"), "x").unwrap();
        // The folders are compared within a harness when an account is
        // created, so an account of another one can be in this folder. The
        // stub stands in for a harness with account support that is not Claude.
        let stub = StubHarness::new()
            .of(AgentKind::Codex)
            .taking_existing_dirs();
        let input = in_dir(
            with_env(
                new_claude("Other"),
                vec![secret_in("STUB_SECRET", Some("key-1"))],
            ),
            &account.config_dir,
        );
        let other = plan_new_account(
            &stub,
            lab.user_home.path(),
            lab.app_data.path(),
            &input,
            "c1",
            1500,
        )
        .map(|plan| plan.account)
        .unwrap();
        assert_eq!(other.agent_type, "codex");
        assert_eq!(other.config_dir, account.config_dir);
        upsert_account_confirmed(&lab.pool, other).await.unwrap();

        lab.remove("a1", true).await.unwrap();

        assert!(dir.join("login").exists(), "c1 is still there");
        // The folder is not kept for good: once nobody live is in it, it goes.
        lab.remove("c1", false).await.unwrap();
        lab.remove("a1", true).await.unwrap();
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn remove_keeps_a_folder_with_a_live_account_inside_it() {
        let lab = Lab::new().await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        let inner = lab.managed_dir("a1").join("profile");
        std::fs::create_dir(&inner).unwrap();
        std::fs::write(inner.join(".claude.json"), SIGNED_IN).unwrap();
        lab.create("b1", in_dir(new_claude("Other"), inner.to_str().unwrap()))
            .await
            .unwrap();

        lab.remove("a1", true).await.unwrap();

        assert!(inner.join(".claude.json").exists(), "b1 is still signed in");
    }

    #[tokio::test]
    async fn remove_deletes_the_folder_once_only_removed_accounts_were_in_it() {
        let lab = Lab::new().await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        lab.remove("a1", false).await.unwrap();
        let dir = lab.managed_dir("a1");
        lab.create("b1", in_dir(new_claude("Other"), dir.to_str().unwrap()))
            .await
            .unwrap();
        lab.remove("b1", false).await.unwrap();

        lab.remove("a1", true).await.unwrap();

        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn create_does_not_undo_into_a_folder_a_live_account_uses() {
        // Ids are random in the app, but this one is the caller's: the folder
        // a failed create would clean up may be one another account brought.
        let mut lab = Lab::new().await;
        let taken = lab.managed_dir("z9");
        std::fs::create_dir_all(&taken).unwrap();
        std::fs::write(taken.join(".claude.json"), SIGNED_IN).unwrap();
        lab.create("b1", in_dir(new_claude("Other"), taken.to_str().unwrap()))
            .await
            .unwrap();
        lab.db_tx = dead_queue();

        let result = lab.create("z9", new_claude("Acme")).await;

        assert!(matches!(result, Err(AccountError::Invalid { .. })));
        assert!(taken.join(".claude.json").exists(), "b1 is still signed in");
    }

    #[tokio::test]
    async fn remove_unknown_account_is_missing() {
        let lab = Lab::new().await;

        assert_eq!(
            lab.remove("nope", true).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn remove_twice_is_harmless_and_keeps_the_first_time() {
        let lab = Lab::new().await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        lab.remove("a1", false).await.unwrap();

        // A second request, now asking for the folder too.
        remove_account(&lab.pool, &lab.db_tx, lab.store.clone(), "a1", true, 3000)
            .await
            .map(drop)
            .unwrap();

        assert_eq!(lab.stored().await[0].removed_at, Some(2000));
        assert!(!lab.managed_dir("a1").exists());
    }

    #[tokio::test]
    async fn remove_goes_through_when_the_keychain_is_locked() {
        // An account stays removable whatever state the keychain is in: it
        // can never run again, so what lingers is only residue.
        let lab = Lab::with_store(Arc::new(LockedKeychain)).await;
        lab.create("a1", new_claude("Acme")).await.unwrap();
        let mut keyed = make_account("a2", 1500);
        keyed.env = vec![secret_var("A_KEY")];
        upsert_account_confirmed(&lab.pool, keyed).await.unwrap();

        lab.remove("a2", true).await.unwrap();

        assert_eq!(lab.stored().await[1].removed_at, Some(2000));
    }

    // -- set_project_account --

    /// Claude accounts a1 and a1-gone (removed), and the Codex account c1.
    async fn lab_with_accounts() -> Lab {
        let lab = Lab::new().await;
        for (id, agent_type) in [("a1", "claude"), ("a1-gone", "claude"), ("c1", "codex")] {
            let mut account = make_account(id, 1000);
            account.agent_type = agent_type.into();
            upsert_account_confirmed(&lab.pool, account).await.unwrap();
        }
        mark_account_removed_confirmed(&lab.pool, "a1-gone", 1700)
            .await
            .unwrap();
        lab
    }

    #[tokio::test]
    async fn set_project_account_rejects_wrong_harness_and_removed() {
        let lab = lab_with_accounts().await;

        assert_eq!(
            lab.bind("p-001", "claude", Some("c1")).await,
            Err(AccountError::WrongHarness {
                account_id: "c1".into()
            })
        );
        assert_eq!(
            lab.bind("p-001", "claude", Some("a1-gone")).await,
            Err(AccountError::Removed {
                account_id: "a1-gone".into(),
                label: "Account a1-gone".into()
            })
        );
        assert_eq!(
            lab.bind("p-001", "claude", Some("nope")).await,
            Err(AccountError::Missing {
                account_id: "nope".into()
            })
        );
        assert!(db::project_account_ids(&lab.pool, "p-001")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn set_project_account_binds_replaces_and_clears() {
        let lab = lab_with_accounts().await;
        let mut second = make_account("a2", 2000);
        second.agent_type = "claude".into();
        upsert_account_confirmed(&lab.pool, second).await.unwrap();
        let bound = |pairs: &[(&str, &str)]| -> std::collections::HashMap<String, String> {
            pairs
                .iter()
                .map(|(agent, account)| (agent.to_string(), account.to_string()))
                .collect()
        };

        lab.bind("p-001", "claude", Some("a1")).await.unwrap();
        lab.bind("p-001", "codex", Some("c1")).await.unwrap();
        assert_eq!(
            db::project_account_ids(&lab.pool, "p-001").await.unwrap(),
            bound(&[("claude", "a1"), ("codex", "c1")])
        );

        lab.bind("p-001", "claude", Some("a2")).await.unwrap();
        lab.bind("p-001", "codex", None).await.unwrap();
        assert_eq!(
            db::project_account_ids(&lab.pool, "p-001").await.unwrap(),
            bound(&[("claude", "a2")])
        );
    }

    #[tokio::test]
    async fn set_project_account_needs_a_real_harness() {
        let lab = lab_with_accounts().await;

        // `AgentKind::parse` would read both as Claude.
        for account in [None, Some("a1")] {
            assert_eq!(
                invalid_message(lab.bind("p-001", "bogus", account).await),
                "Unknown agent: bogus.",
                "account: {account:?}"
            );
        }
        assert!(db::list_project_accounts(&lab.pool)
            .await
            .unwrap()
            .is_empty());
    }

    // -- changes that must not interleave --

    #[tokio::test]
    async fn an_account_cannot_be_removed_and_bound_at_the_same_time() {
        // Removal is refused while a project uses the account, and a project
        // may only use a live one. Each looks before it writes, so without
        // taking turns both could pass and leave a project on a removed account.
        for round in 0..20 {
            let lab = Lab::new().await;
            lab.add_project().await;
            lab.create("a1", new_claude("Acme")).await.unwrap();

            let (removed, bound) = tokio::join!(
                lab.remove("a1", false),
                lab.bind("p-001", "claude", Some("a1"))
            );

            let is_removed = lab.stored().await[0].removed_at.is_some();
            let is_bound = !db::project_account_ids(&lab.pool, "p-001")
                .await
                .unwrap()
                .is_empty();
            assert!(
                !(is_removed && is_bound),
                "round {round}: removed {removed:?}, bound {bound:?}"
            );
            assert!(
                removed.is_ok() != bound.is_ok(),
                "round {round}: exactly one of them wins: {removed:?} / {bound:?}"
            );
        }
    }

    #[tokio::test]
    async fn two_accounts_cannot_claim_the_same_folder_at_the_same_time() {
        for round in 0..20 {
            let lab = Lab::new().await;
            let dir = lab.user_dir("shared");
            let dir = dir.to_str().unwrap();

            let (first, second) = tokio::join!(
                lab.create("a1", in_dir(new_claude("One"), dir)),
                lab.create("a2", in_dir(new_claude("Two"), dir))
            );

            assert!(
                first.is_ok() != second.is_ok(),
                "round {round}: one of them wins: {first:?} / {second:?}"
            );
            assert_eq!(lab.stored().await.len(), 1, "round {round}");
        }
    }

    // -- Publishing --

    /// Creates the account `id` and keeps the turn of the change.
    async fn create_keeping_the_turn(lab: &Lab, id: &str) -> Turn {
        let (_, turn) = create_account(
            &lab.pool,
            &lab.db_tx,
            lab.store.clone(),
            lab.app_data.path(),
            lab.user_home.path(),
            new_claude(id),
            id.into(),
            1000,
        )
        .await
        .unwrap();
        turn
    }

    #[tokio::test]
    async fn publish_hands_out_the_snapshot_while_the_turn_is_still_held() {
        let lab = Lab::new().await;
        let turn = create_keeping_the_turn(&lab, "a1").await;
        let mut emitted = None;

        let returned = turn
            .publish(&lab.pool, lab.user_home.path(), |snapshot| {
                // Nobody else can change an account between the snapshot and
                // the change it shows.
                assert!(
                    ACCOUNT_CHANGES.try_lock().is_err(),
                    "emitted after the turn was over"
                );
                emitted = Some(snapshot.clone());
            })
            .await
            .unwrap();

        let ids: Vec<&str> = returned
            .accounts
            .iter()
            .map(|view| view.account.id.as_str())
            .collect();
        assert_eq!(ids, ["a1"]);
        assert_eq!(emitted, Some(returned));
    }

    #[tokio::test]
    async fn snapshots_go_out_in_the_order_the_changes_were_stored() {
        // Four accounts are created at once, each publishing right after its
        // own change. Whichever goes first, snapshot n is the state right after
        // change n: one account, then two, and so on. A snapshot built or sent
        // after the turn was given up could already show a later change, or
        // arrive after a newer one and leave a window with the older state.
        for round in 0..10 {
            let lab = Lab::new().await;
            let emitted = std::sync::Mutex::new(Vec::new());
            let change = |n: usize| {
                let (lab, emitted) = (&lab, &emitted);
                async move {
                    let turn = create_keeping_the_turn(lab, &format!("a{n}")).await;
                    turn.publish(&lab.pool, lab.user_home.path(), |snapshot| {
                        emitted.lock().unwrap().push(snapshot.accounts.len());
                    })
                    .await
                    .unwrap();
                }
            };

            tokio::join!(change(1), change(2), change(3), change(4));

            assert_eq!(*emitted.lock().unwrap(), [1, 2, 3, 4], "round {round}");
        }
    }

    #[tokio::test]
    async fn publish_emits_nothing_when_the_snapshot_cannot_be_built() {
        let _alone = ONE_AT_A_TIME.lock().await;
        // No migrations ran, so every query fails.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let home = TempDir::new().unwrap();
        let turn = Turn::take().await;
        let mut emitted = false;

        let result = turn.publish(&pool, home.path(), |_| emitted = true).await;

        assert!(result.is_err());
        assert!(!emitted);
    }

    #[tokio::test]
    async fn a_refused_change_gives_up_its_turn() {
        let lab = Lab::new().await;

        let refused = lab.create("a1", new_claude("  ")).await;

        assert!(refused.is_err());
        assert!(
            ACCOUNT_CHANGES.try_lock().is_ok(),
            "the refused change kept its turn, which would hold up every other change"
        );
    }

    // -- Blocking work --

    #[tokio::test]
    async fn account_commands_use_the_keychain_off_the_calling_thread() {
        let spy = Arc::new(ThreadSpy::default());
        let lab = Lab::with_store(spy.clone()).await;
        let input = with_env(
            new_claude("Acme"),
            vec![
                secret_in("A_KEY", Some("sk-a")),
                secret_in("B_KEY", Some("sk-b")),
            ],
        );

        // A set (create), a set and a delete (update), and deletes (remove).
        lab.create("a1", input).await.unwrap();
        let after_create = spy.changes.lock().unwrap().len();
        lab.update(edit("a1", vec![secret_in("A_KEY", Some("sk-a2"))]))
            .await
            .unwrap();
        let after_update = spy.changes.lock().unwrap().len();
        lab.remove("a1", false).await.unwrap();
        let after_remove = spy.changes.lock().unwrap().len();

        // The test runs on a current-thread runtime, so a keychain call made
        // inline would be recorded on this very thread.
        assert_eq!(after_create, 2, "create stores both secrets");
        assert_eq!(after_update, 4, "update stores one and forgets one");
        assert_eq!(after_remove, 5, "remove forgets the one that is left");
        let changes = spy.changes.lock().unwrap();
        assert!(
            !changes.contains(&std::thread::current().id()),
            "the keychain was changed on the async caller's thread"
        );
    }

    // -- snapshot --

    /// The harnesses that have account support, so a Default account in the
    /// snapshot, in the order the snapshot lists them.
    fn harnesses_with_account_support() -> Vec<&'static str> {
        AgentKind::all()
            .iter()
            .filter(|kind| kind.implementation().account_profile().is_some())
            .map(|kind| kind.as_str())
            .collect()
    }

    /// The harnesses the snapshot lists a Default account for.
    fn default_harnesses(snapshot: &AccountsSnapshot) -> Vec<&str> {
        snapshot
            .defaults
            .iter()
            .map(|view| view.agent_type.as_str())
            .collect()
    }

    #[tokio::test]
    async fn snapshot_includes_identities_and_claude_default() {
        let lab = Lab::new().await;
        let (signed_in, signed_out, keyed, gone) = (
            claude_dir(SIGNED_IN),
            claude_dir("{}"),
            claude_dir("{}"),
            claude_dir(SIGNED_IN),
        );
        // Created out of order: the snapshot lists them oldest first.
        for (id, dir, created_at) in [
            ("a4-gone", &gone, 4000),
            ("a3-keyed", &keyed, 3000),
            ("a1-in", &signed_in, 1000),
            ("a2-out", &signed_out, 2000),
        ] {
            let mut account = acme(id, dir);
            account.created_at = created_at;
            if id == "a3-keyed" {
                account.env = vec![secret_var("ANTHROPIC_API_KEY")];
            }
            upsert_account_confirmed(&lab.pool, account).await.unwrap();
        }
        mark_account_removed_confirmed(&lab.pool, "a4-gone", 4500)
            .await
            .unwrap();
        set_project_account_confirmed(&lab.pool, "p-001", "claude", Some("a1-in"))
            .await
            .unwrap();

        let snapshot = lab.snapshot().await;

        let listed: Vec<(&str, SignInStatus)> = snapshot
            .accounts
            .iter()
            .map(|view| (view.account.id.as_str(), view.identity.status))
            .collect();
        assert_eq!(
            listed,
            [
                ("a1-in", SignInStatus::SignedIn),
                ("a2-out", SignInStatus::SignedOut),
                ("a3-keyed", SignInStatus::ApiKey),
                // Removed: not read, though somebody is signed in to its folder.
                ("a4-gone", SignInStatus::Unknown),
            ]
        );
        assert_eq!(
            snapshot.accounts[0].identity.email.as_deref(),
            Some("dev@acme.com")
        );
        assert_eq!(snapshot.accounts[3].identity, AccountIdentity::default());
        // Rows come through as they are stored.
        assert_eq!(
            snapshot.accounts[2].account.env,
            vec![secret_var("ANTHROPIC_API_KEY")]
        );
        // Default is listed for every harness with account support, Claude's
        // included.
        let defaults = default_harnesses(&snapshot);
        assert_eq!(defaults, harnesses_with_account_support());
        assert!(defaults.contains(&"claude"));
        assert_eq!(
            snapshot.project_accounts,
            vec![ProjectAccount {
                project_id: "p-001".into(),
                agent_type: "claude".into(),
                account_id: "a1-in".into(),
            }]
        );
    }

    #[tokio::test]
    async fn snapshot_reads_the_identity_fresh_every_time() {
        let lab = Lab::new().await;
        let dir = claude_dir("{}");
        upsert_account_confirmed(&lab.pool, acme("a1", &dir))
            .await
            .unwrap();
        assert_eq!(
            lab.snapshot().await.accounts[0].identity.status,
            SignInStatus::SignedOut
        );

        // The CLI signs in behind Verun's back.
        std::fs::write(dir.path().join(".claude.json"), SIGNED_IN).unwrap();

        assert_eq!(
            lab.snapshot().await.accounts[0].identity.status,
            SignInStatus::SignedIn
        );
    }

    #[tokio::test]
    async fn snapshot_of_nothing_still_lists_the_default_accounts() {
        let pool = test_pool().await;
        let home = TempDir::new().unwrap();

        // The public entry point reads Verun's own env for the Default key.
        let snapshot = snapshot(&pool, home.path()).await.unwrap();

        assert!(snapshot.accounts.is_empty());
        assert!(snapshot.project_accounts.is_empty());
        assert_eq!(
            default_harnesses(&snapshot),
            harnesses_with_account_support()
        );
    }

    #[tokio::test]
    async fn snapshot_fails_with_the_database() {
        // No migrations ran, so every query fails.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        let home = TempDir::new().unwrap();

        assert!(snapshot_with(&pool, home.path(), |_| false).await.is_err());
    }

    #[test]
    fn default_view_reads_the_default_account_of_the_users_home() {
        let view = default_view(
            &StubHarness::signed(SignInStatus::SignedIn),
            Path::new("/Users/me"),
            &|_| false,
        )
        .unwrap();

        assert_eq!(view.agent_type, "claude");
        assert_eq!(view.identity.status, SignInStatus::SignedIn);
        assert_eq!(view.identity.email.as_deref(), Some("/Users/me"));
    }

    #[test]
    fn default_view_is_absent_for_a_harness_without_account_support() {
        assert_eq!(
            default_view(
                &StubHarness::without_profile(),
                Path::new("/Users/me"),
                &|_| false
            ),
            None
        );
    }

    #[test]
    fn default_view_counts_an_inherited_api_key_as_a_login() {
        let inherits = |key: &str| key == "STUB_API_KEY";
        // Nobody is signed in on disk, yet the CLI works on the key Verun
        // started with.
        for status in [SignInStatus::SignedOut, SignInStatus::Unknown] {
            let view = default_view(
                &StubHarness::signed(status),
                Path::new("/Users/me"),
                &inherits,
            )
            .unwrap();
            assert_eq!(
                view.identity.status,
                SignInStatus::ApiKey,
                "from {status:?}"
            );
            // The rest of what the files say stays.
            assert_eq!(view.identity.email.as_deref(), Some("/Users/me"));
        }
    }

    #[test]
    fn default_view_keeps_a_real_login_and_ignores_other_vars() {
        let signed_in = StubHarness::signed(SignInStatus::SignedIn);
        let signed_out = StubHarness::signed(SignInStatus::SignedOut);
        let home = Path::new("/Users/me");

        // A login the CLI really has is not replaced by a key.
        let kept = default_view(&signed_in, home, &|key: &str| key == "STUB_API_KEY").unwrap();
        assert_eq!(kept.identity.status, SignInStatus::SignedIn);
        // A var that is not a key does not make a login.
        let other = default_view(&signed_out, home, &|key: &str| key == "STUB_BASE_URL").unwrap();
        assert_eq!(other.identity.status, SignInStatus::SignedOut);
        let none = default_view(&signed_out, home, &|_| false).unwrap();
        assert_eq!(none.identity.status, SignInStatus::SignedOut);
    }

    #[test]
    fn snapshot_serializes_as_the_frontend_reads_it() {
        let mut account = make_account("a1", 1000);
        account.env = vec![secret_var("ANTHROPIC_API_KEY")];
        let identity = AccountIdentity {
            status: SignInStatus::SignedIn,
            email: Some("dev@acme.com".into()),
            ..AccountIdentity::default()
        };
        let snapshot = AccountsSnapshot {
            accounts: vec![AccountView {
                account,
                identity: identity.clone(),
            }],
            defaults: vec![DefaultAccountView {
                agent_type: "claude".into(),
                identity,
            }],
            project_accounts: vec![ProjectAccount {
                project_id: "p-001".into(),
                agent_type: "claude".into(),
                account_id: "a1".into(),
            }],
        };
        let identity_json = json!({
            "status": "signedIn",
            "email": "dev@acme.com",
            "orgName": null,
            "plan": null,
            "providers": [],
        });

        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({
                "accounts": [{
                    "id": "a1",
                    "agentType": "claude",
                    "label": "Account a1",
                    "color": "#d97757",
                    "configDir": "/tmp/verun-accounts/a1",
                    "managedDir": true,
                    "env": [{"key": "ANTHROPIC_API_KEY", "value": null, "secret": true}],
                    "removedAt": null,
                    "createdAt": 1000,
                    "identity": identity_json,
                }],
                "defaults": [{"agentType": "claude", "identity": identity_json}],
                "projectAccounts": [
                    {"projectId": "p-001", "agentType": "claude", "accountId": "a1"}
                ],
            })
        );
    }
}
