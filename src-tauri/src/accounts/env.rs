//! The env an account adds to a spawn, as a patch over the env the process
//! would otherwise inherit.
//!
//! An added account runs with its own home and env vars, and nothing Verun
//! inherited may override them. `account_env` turns one account into a patch,
//! and `project_env` and `session_env` combine the patches of the accounts a
//! spawn follows. The spawn sites apply the result. Default sessions have no
//! account and get an empty patch, so they keep the env they have today.
//!
//! A spawn through the user's login shell cannot just apply the patch to the
//! shell: the profile runs after it and can undo it. `shell_wrap` applies the
//! patch from inside the shell instead.

use super::secrets::SecretStore;
use super::AccountError;
use crate::agent::{Agent, AgentKind};
use crate::claude_terminal::shell_quote;
use crate::db::{Account, AccountEnvVar};
use std::path::Path;

/// Changes to the env a spawned process inherits: vars to remove, and vars to
/// set.
///
/// A patch is applied remove-first, then set, so a var in both lists ends up
/// set. That is how an account with its own `ANTHROPIC_API_KEY` works: the
/// harness's scrub list removes the key Verun inherited and the account sets
/// its own.
#[derive(Clone, Default, PartialEq)]
pub struct EnvPatch {
    pub remove: Vec<String>,
    pub set: Vec<(String, String)>,
}

/// Shows which vars the patch removes and sets, with every set value masked as
/// `***`. A value can be a secret read from the keychain, and a patch ends up
/// in log lines, panic messages and failed assertions.
impl std::fmt::Debug for EnvPatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let masked: Vec<(&str, &str)> = self
            .set
            .iter()
            .map(|(key, _)| (key.as_str(), "***"))
            .collect();
        f.debug_struct("EnvPatch")
            .field("remove", &self.remove)
            .field("set", &masked)
            .finish()
    }
}

impl EnvPatch {
    /// A patch that only sets `vars`. A key given twice keeps its last value.
    pub fn from_vars(vars: Vec<(String, String)>) -> Self {
        let mut patch = Self::default();
        for (key, value) in vars {
            patch.set_var(key, value);
        }
        patch
    }

    /// Whether applying the patch would change nothing.
    pub fn is_empty(&self) -> bool {
        self.remove.is_empty() && self.set.is_empty()
    }

    /// Adds `other`, the later patch, to this one, so the result does what
    /// applying this patch and then `other` would. The later patch wins
    /// outright, its removals included: a var it removes is deleted from this
    /// patch's `set`, and a var it sets replaces any earlier value and is no
    /// longer removed. That holds for a var `other` both removes and sets too,
    /// which ends up set, as when `other` is applied alone.
    pub fn merge(&mut self, other: EnvPatch) {
        // Removals first, then sets: the order a patch is applied in.
        for key in other.remove {
            self.set.retain(|(set_key, _)| *set_key != key);
            if !self.remove.contains(&key) {
                self.remove.push(key);
            }
        }
        for (key, value) in other.set {
            self.remove.retain(|removed| *removed != key);
            self.set_var(key, value);
        }
    }

    /// Applies the patch to a command: every var in `remove`, then every var
    /// in `set`. The order matters because a command keeps one entry per var
    /// and the last call wins, so a var in both lists is set only if it is
    /// removed first.
    pub fn apply_to_command(&self, cmd: &mut tokio::process::Command) {
        self.apply_to_std_command(cmd.as_std_mut());
    }

    /// `apply_to_command` for a `std::process::Command`.
    pub fn apply_to_std_command(&self, cmd: &mut std::process::Command) {
        for key in &self.remove {
            cmd.env_remove(key);
        }
        for (key, value) in &self.set {
            cmd.env(key, value);
        }
    }

    /// `apply_to_command` for the `CommandBuilder` of a PTY. A builder keeps
    /// one entry per var as well, so the order matters in the same way.
    pub fn apply_to_pty(&self, cmd: &mut portable_pty::CommandBuilder) {
        for key in &self.remove {
            cmd.env_remove(key);
        }
        for (key, value) in &self.set {
            cmd.env(key, value);
        }
    }

    /// Sets `key`, replacing any value already set for it. The var moves to
    /// the end, so `set` stays in the order the values took effect.
    fn set_var(&mut self, key: String, value: String) {
        self.set.retain(|(existing, _)| *existing != key);
        self.set.push((key, value));
    }
}

/// The env var that carries the script `shell_wrap` builds.
pub const ACCOUNT_SCRIPT_VAR: &str = "VERUN_ACCOUNT_SCRIPT";

/// Wraps `command` so that `env` is applied by `/bin/sh` after the user's
/// login shell has loaded its profile. Returns the command to run under
/// `$SHELL -lic` and the env vars to spawn that shell with.
///
/// Setting the patch on the shell itself would lose to the profile, which can
/// export `CLAUDE_CONFIG_DIR` or a provider key over the account's. The
/// returned command only execs `/bin/sh` to eval the script in
/// `ACCOUNT_SCRIPT_VAR`. The script unsets that var and the patch's removals,
/// exports its sets and then runs `command`, so a var in both lists ends up
/// set, as in `apply_to_std_command`. A `sh -c` reads no profile, so nothing
/// undoes the exports. The command is plain enough to parse the same way in
/// zsh, bash and fish.
///
/// Values reach `command` only through its environment: no process has them in
/// its arguments. The returned command holds none, and the sh reads the script
/// from its own environment and evals it instead of getting it as an argument.
/// The script drops its own var first so that what `command` starts cannot
/// read the values back from it.
///
/// An empty patch needs none of this: `command` comes back as it is, with no
/// vars.
///
/// `command` runs in `sh`, not in the user's shell, so it must be plain POSIX
/// sh. It sees the profile's exports but not its aliases or functions. The
/// keys of `env` go into the script as they are, so they must be valid shell
/// names. The returned vars hold the secret values: never log them.
#[allow(dead_code)] // consumed by the PTY spawn sites
pub fn shell_wrap(command: &str, env: &EnvPatch) -> (String, Vec<(String, String)>) {
    if env.is_empty() {
        return (command.to_string(), Vec::new());
    }
    let unset = std::iter::once(ACCOUNT_SCRIPT_VAR)
        .chain(env.remove.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let mut script = format!("unset {unset}; ");
    // No `export` clause for a patch that only removes: a bare `export` prints
    // the whole env, secrets included, to the terminal.
    if !env.set.is_empty() {
        let exports = env
            .set
            .iter()
            .map(|(key, value)| format!("{key}={}", shell_quote(value)))
            .collect::<Vec<_>>()
            .join(" ");
        script.push_str(&format!("export {exports}; "));
    }
    script.push_str(command);
    // The single quotes make the login shell pass `eval "$VAR"` on as it is.
    // The sh expands the var from its own env, so the script, secrets and all,
    // is never an argument of any process.
    let outer = format!("exec /bin/sh -c 'eval \"${ACCOUNT_SCRIPT_VAR}\"'");
    (outer, vec![(ACCOUNT_SCRIPT_VAR.to_string(), script)])
}

/// The env of one added account. `agent` is the account's harness.
///
/// `remove` is the harness's whole scrub list, so nothing Verun inherited can
/// override the account. `set` is the home var for the account's dir, the
/// harness's fixed env, then the account's own vars in the order they are
/// stored; a later var replaces an earlier one of the same name. Secret values
/// come from `secrets`, never from the account row. Whether the account is
/// signed in or removed is not checked here.
///
/// Reading a secret may block on the OS keychain, so async callers run this
/// inside `spawn_blocking`.
pub fn account_env(
    agent: &dyn Agent,
    account: &Account,
    secrets: &dyn SecretStore,
) -> Result<EnvPatch, AccountError> {
    let Some(profile) = agent.account_profile() else {
        return Err(AccountError::Invalid {
            message: format!(
                "{} does not support multiple accounts",
                agent.display_name()
            ),
        });
    };
    let mut patch = EnvPatch {
        remove: profile
            .scrub_vars
            .iter()
            .map(|var| var.to_string())
            .collect(),
        set: Vec::new(),
    };
    for (key, value) in agent.account_home_env(Path::new(&account.config_dir)) {
        patch.set_var(key, value);
    }
    for (key, value) in profile.fixed_env {
        patch.set_var(key.to_string(), value.to_string());
    }
    for var in &account.env {
        patch.set_var(var.key.clone(), env_value(account, var, secrets)?);
    }
    Ok(patch)
}

/// The env of a project's task shells, hooks and start command: the accounts
/// the project is bound to, for every harness whose account is meant to reach
/// them. A harness on Default has no account and contributes nothing.
///
/// May block on the keychain like `account_env`.
pub fn project_env(
    project_accounts: &[Account],
    secrets: &dyn SecretStore,
) -> Result<EnvPatch, AccountError> {
    merged_project_env(project_accounts.iter(), secrets)
}

/// The env of one session: the project's accounts for the other harnesses, so
/// the CLIs the agent runs itself follow the project, and then the session's
/// own account. A session on Default has none, so its own harness keeps the
/// env it inherited, and the project's account for that harness is not used.
///
/// The session's account is merged last and wins outright, so its harness's
/// scrub list also removes what the other accounts set: another account's
/// custom `ANTHROPIC_API_KEY` cannot override a Claude account.
///
/// `session_account` is an account of `session_agent_type`'s harness, and it
/// is applied whether or not that harness reaches the project's shells. May
/// block on the keychain like `account_env`.
pub fn session_env(
    session_agent_type: &str,
    session_account: Option<&Account>,
    project_accounts: &[Account],
    secrets: &dyn SecretStore,
) -> Result<EnvPatch, AccountError> {
    let session_harness = AgentKind::parse(session_agent_type);
    let other_harnesses = project_accounts
        .iter()
        .filter(|account| AgentKind::parse(&account.agent_type) != session_harness);
    let mut patch = merged_project_env(other_harnesses, secrets)?;
    if let Some(account) = session_account {
        patch.merge(account_env(agent_of(account).as_ref(), account, secrets)?);
    }
    Ok(patch)
}

/// The accounts' patches merged in order, for the accounts whose harness
/// wants them in a project's env, so a later account wins outright (see
/// `EnvPatch::merge`). Both combinations are built from this.
fn merged_project_env<'a>(
    accounts: impl Iterator<Item = &'a Account>,
    secrets: &dyn SecretStore,
) -> Result<EnvPatch, AccountError> {
    let mut patch = EnvPatch::default();
    for account in accounts {
        let agent = agent_of(account);
        if agent
            .account_profile()
            .is_some_and(|profile| profile.in_project_env)
        {
            patch.merge(account_env(agent.as_ref(), account, secrets)?);
        }
    }
    Ok(patch)
}

/// The harness an account belongs to.
fn agent_of(account: &Account) -> Box<dyn Agent> {
    AgentKind::parse(&account.agent_type).implementation()
}

/// The value of one env var of `account`: a secret's is in the keychain, any
/// other is in the row.
fn env_value(
    account: &Account,
    var: &AccountEnvVar,
    secrets: &dyn SecretStore,
) -> Result<String, AccountError> {
    if !var.secret {
        return var.value.clone().ok_or_else(|| AccountError::Invalid {
            message: format!(
                "Env var {} of account {} has no value",
                var.key, account.label
            ),
        });
    }
    let secret_error = |message: String| AccountError::Secret {
        account_id: account.id.clone(),
        label: account.label.clone(),
        message,
    };
    match secrets.get(&account.id, &var.key) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(secret_error(format!("{} has no stored value", var.key))),
        Err(e) => Err(secret_error(format!("{}: {e}", var.key))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::secrets::MemorySecretStore;
    use crate::agent::{AccountProfile, Claude, InputMode, ModelOption, SessionArgs};

    // -- Fixtures --

    fn account(id: &str, env: Vec<AccountEnvVar>) -> Account {
        Account {
            id: id.into(),
            agent_type: "claude".into(),
            label: "Acme".into(),
            color: "#d97757".into(),
            config_dir: format!("/acc/{id}"),
            managed_dir: true,
            env,
            removed_at: None,
            created_at: 0,
        }
    }

    fn plain(key: &str, value: &str) -> AccountEnvVar {
        AccountEnvVar {
            key: key.into(),
            value: Some(value.into()),
            secret: false,
        }
    }

    fn secret(key: &str) -> AccountEnvVar {
        AccountEnvVar {
            key: key.into(),
            value: None,
            secret: true,
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn pairs(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        vars.iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// A harness whose account support the test chooses, for the cases no real
    /// harness pins down: no profile at all, and a profile with a fixed env
    /// (Claude's has none).
    struct FakeHarness(Option<AccountProfile>);

    impl Agent for FakeHarness {
        fn kind(&self) -> AgentKind {
            AgentKind::Claude
        }
        fn display_name(&self) -> &'static str {
            "Fake CLI"
        }
        fn cli_binary(&self) -> &'static str {
            "fake"
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
            self.0
        }
        fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
            vec![("FAKE_HOME".into(), dir.to_string_lossy().into_owned())]
        }
    }

    fn fake_profile(
        scrub_vars: &'static [&'static str],
        fixed_env: &'static [(&'static str, &'static str)],
    ) -> AccountProfile {
        AccountProfile {
            scrub_vars,
            fixed_env,
            api_key_vars: &[],
            login_args: None,
            logout_args: None,
            login_hint: None,
            logout_hint: None,
            allows_existing_dir: false,
            required_secret: None,
            in_project_env: true,
            min_cli_version: None,
        }
    }

    /// A keychain that refuses every read.
    struct LockedKeychain;

    impl SecretStore for LockedKeychain {
        fn get(&self, _account_id: &str, _key: &str) -> Result<Option<String>, String> {
            Err("keychain is locked".into())
        }
        fn set(&self, _account_id: &str, _key: &str, _value: &str) -> Result<(), String> {
            Err("keychain is locked".into())
        }
        fn delete(&self, _account_id: &str, _key: &str) -> Result<(), String> {
            Err("keychain is locked".into())
        }
    }

    /// What a command will do to the env of its child: `Some` sets, `None`
    /// removes. Vars the command never mentions are left out.
    fn recorded_env(cmd: &std::process::Command) -> Vec<(String, Option<String>)> {
        cmd.get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    /// What applying `patch` does to the env of a command, sorted: `Some` sets
    /// a var and `None` removes it. Patches with the same effect are
    /// interchangeable, however they list their vars.
    fn effect(patch: &EnvPatch) -> Vec<(String, Option<String>)> {
        let mut cmd = std::process::Command::new("claude");
        patch.apply_to_std_command(&mut cmd);
        let mut env = recorded_env(&cmd);
        env.sort();
        env
    }

    fn sets(patch: &EnvPatch, key: &str, value: &str) -> bool {
        effect(patch).contains(&(key.to_string(), Some(value.to_string())))
    }

    fn removes(patch: &EnvPatch, key: &str) -> bool {
        effect(patch).contains(&(key.to_string(), None))
    }

    // -- account_env --

    #[test]
    fn account_env_scrubs_inherited_auth_vars() {
        let patch = account_env(
            &Claude,
            &account("a1", vec![]),
            &MemorySecretStore::default(),
        )
        .unwrap();

        assert!(patch.remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(patch.remove.contains(&"CLAUDE_CONFIG_DIR".to_string()));
        // All of the profile's scrub list, not only those two.
        assert_eq!(patch.remove, Claude.account_profile().unwrap().scrub_vars);
    }

    #[test]
    fn account_env_sets_home_then_custom_vars() {
        let account = account("a1", vec![plain("ANTHROPIC_BASE_URL", "https://proxy")]);
        let patch = account_env(&Claude, &account, &MemorySecretStore::default()).unwrap();

        assert_eq!(
            patch.set,
            pairs(&[
                ("CLAUDE_CONFIG_DIR", "/acc/a1"),
                ("ANTHROPIC_BASE_URL", "https://proxy"),
            ])
        );
    }

    #[test]
    fn account_env_reads_secret_values_from_store() {
        let secrets = MemorySecretStore::default();
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();
        // Another account's secret under the same name must not leak in.
        secrets
            .set("a2", "ANTHROPIC_API_KEY", "sk-ant-two")
            .unwrap();
        let account = account(
            "a1",
            vec![
                secret("ANTHROPIC_API_KEY"),
                plain("ANTHROPIC_BASE_URL", "https://proxy"),
            ],
        );

        let patch = account_env(&Claude, &account, &secrets).unwrap();

        // The var is in the scrub list too: the patch removes the inherited
        // one first and then sets the account's own.
        assert!(patch.remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert_eq!(
            patch.set,
            pairs(&[
                ("CLAUDE_CONFIG_DIR", "/acc/a1"),
                ("ANTHROPIC_API_KEY", "sk-ant-one"),
                ("ANTHROPIC_BASE_URL", "https://proxy"),
            ])
        );
    }

    #[test]
    fn account_env_errors_when_secret_missing() {
        let account = account("a1", vec![secret("ANTHROPIC_API_KEY")]);
        let err = account_env(&Claude, &account, &MemorySecretStore::default()).unwrap_err();

        assert_eq!(
            err,
            AccountError::Secret {
                account_id: "a1".into(),
                label: "Acme".into(),
                message: "ANTHROPIC_API_KEY has no stored value".into(),
            }
        );
    }

    #[test]
    fn account_env_reports_a_keychain_failure_as_a_secret_error() {
        let account = account("a1", vec![secret("ANTHROPIC_API_KEY")]);
        let err = account_env(&Claude, &account, &LockedKeychain).unwrap_err();

        assert_eq!(
            err,
            AccountError::Secret {
                account_id: "a1".into(),
                label: "Acme".into(),
                message: "ANTHROPIC_API_KEY: keychain is locked".into(),
            }
        );
    }

    #[test]
    fn account_env_uses_the_store_for_a_secret_whatever_the_row_holds() {
        // A secret's value must not be in the row, but if one is it is stale.
        let secrets = MemorySecretStore::default();
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();
        let stale = AccountEnvVar {
            key: "ANTHROPIC_API_KEY".into(),
            value: Some("sk-ant-stale".into()),
            secret: true,
        };

        let patch = account_env(&Claude, &account("a1", vec![stale]), &secrets).unwrap();

        assert!(patch
            .set
            .contains(&("ANTHROPIC_API_KEY".to_string(), "sk-ant-one".to_string())));
        assert!(!patch.set.iter().any(|(_, value)| value == "sk-ant-stale"));
    }

    #[test]
    fn account_env_rejects_a_plain_var_without_a_value() {
        let valueless = AccountEnvVar {
            key: "ANTHROPIC_BASE_URL".into(),
            value: None,
            secret: false,
        };
        let err = account_env(
            &Claude,
            &account("a1", vec![valueless]),
            &MemorySecretStore::default(),
        )
        .unwrap_err();

        assert_eq!(
            err,
            AccountError::Invalid {
                message: "Env var ANTHROPIC_BASE_URL of account Acme has no value".into(),
            }
        );
    }

    #[test]
    fn account_env_puts_fixed_env_between_home_and_custom_vars() {
        let harness = FakeHarness(Some(fake_profile(
            &["FAKE_HOME", "FAKE_LOG"],
            &[("FAKE_STORE", "memory"), ("FAKE_LOG", "off")],
        )));
        let secrets = MemorySecretStore::default();
        secrets.set("a1", "FAKE_KEY", "key-one").unwrap();
        let account = account("a1", vec![plain("FAKE_LOG", "debug"), secret("FAKE_KEY")]);

        let patch = account_env(&harness, &account, &secrets).unwrap();

        // The account's own var is applied after the fixed one and replaces it.
        assert_eq!(
            patch.set,
            pairs(&[
                ("FAKE_HOME", "/acc/a1"),
                ("FAKE_STORE", "memory"),
                ("FAKE_LOG", "debug"),
                ("FAKE_KEY", "key-one"),
            ])
        );
        assert_eq!(patch.remove, strings(&["FAKE_HOME", "FAKE_LOG"]));
    }

    #[test]
    fn account_env_without_account_support_is_invalid() {
        let err = account_env(
            &FakeHarness(None),
            &account("a1", vec![]),
            &MemorySecretStore::default(),
        )
        .unwrap_err();

        assert_eq!(
            err,
            AccountError::Invalid {
                message: "Fake CLI does not support multiple accounts".into(),
            }
        );
    }

    // -- project_env and session_env --

    #[test]
    fn project_env_without_accounts_is_empty() {
        let patch = project_env(&[], &MemorySecretStore::default()).unwrap();
        assert_eq!(patch, EnvPatch::default());
    }

    #[test]
    fn project_env_carries_a_bound_claude_account() {
        let secrets = MemorySecretStore::default();
        secrets
            .set("a1", "ANTHROPIC_API_KEY", "sk-ant-one")
            .unwrap();
        let a1 = account(
            "a1",
            vec![
                secret("ANTHROPIC_API_KEY"),
                plain("ANTHROPIC_BASE_URL", "https://proxy"),
            ],
        );

        let patch = project_env(std::slice::from_ref(&a1), &secrets).unwrap();

        // The account's own key and URL still beat its scrub list, and the rest
        // of the list is removed: the same effect as the account alone.
        assert_eq!(
            effect(&patch),
            effect(&account_env(&Claude, &a1, &secrets).unwrap())
        );
        assert!(sets(&patch, "ANTHROPIC_API_KEY", "sk-ant-one"));
        assert!(sets(&patch, "ANTHROPIC_BASE_URL", "https://proxy"));
        assert!(sets(&patch, "CLAUDE_CONFIG_DIR", "/acc/a1"));
        assert!(removes(&patch, "ANTHROPIC_AUTH_TOKEN"));
    }

    #[test]
    fn project_env_fails_when_an_account_secret_is_missing() {
        let a1 = account("a1", vec![secret("ANTHROPIC_API_KEY")]);
        let err = project_env(&[a1], &MemorySecretStore::default()).unwrap_err();
        assert!(matches!(err, AccountError::Secret { .. }), "got {err:?}");
    }

    #[test]
    fn default_session_env_is_empty() {
        let patch = session_env("claude", None, &[], &MemorySecretStore::default()).unwrap();
        assert_eq!(patch, EnvPatch::default());
    }

    #[test]
    fn session_env_session_account_overrides_project_account() {
        let secrets = MemorySecretStore::default();
        let a1 = account("a1", vec![plain("ANTHROPIC_BASE_URL", "https://project")]);
        let a2 = account("a2", vec![]);

        let patch = session_env("claude", Some(&a2), &[a1], &secrets).unwrap();

        // The session's account alone: nothing of the project's account is left.
        assert_eq!(patch.set, pairs(&[("CLAUDE_CONFIG_DIR", "/acc/a2")]));
        assert_eq!(
            effect(&patch),
            effect(&account_env(&Claude, &a2, &secrets).unwrap())
        );
    }

    #[test]
    fn session_env_default_session_follows_project_account_of_another_harness() {
        // A Default Codex session in a project bound to a Claude account: the
        // `claude` the agent runs itself uses the project's account.
        let secrets = MemorySecretStore::default();
        let a1 = account("a1", vec![plain("ANTHROPIC_BASE_URL", "https://proxy")]);

        let patch = session_env("codex", None, std::slice::from_ref(&a1), &secrets).unwrap();

        assert_eq!(
            effect(&patch),
            effect(&account_env(&Claude, &a1, &secrets).unwrap())
        );
        assert!(sets(&patch, "CLAUDE_CONFIG_DIR", "/acc/a1"));
        assert!(sets(&patch, "ANTHROPIC_BASE_URL", "https://proxy"));
    }

    #[test]
    fn session_env_session_scrub_beats_other_account_custom_var() {
        // Only Claude has a profile so far, so two Claude accounts stand in for
        // two harnesses: `other` defines a var that the session account's
        // scrub list names. It is merged first, as session_env merges the
        // project's other accounts before the session's own.
        let secrets = MemorySecretStore::default();
        let other = account("a1", vec![plain("ANTHROPIC_API_KEY", "sk-other")]);
        let own = account("a2", vec![]);

        let mut patch = account_env(&Claude, &other, &secrets).unwrap();
        assert!(sets(&patch, "ANTHROPIC_API_KEY", "sk-other"));
        patch.merge(account_env(&Claude, &own, &secrets).unwrap());

        // The key is gone from the env, not just from `set`.
        assert!(!patch.set.iter().any(|(key, _)| key == "ANTHROPIC_API_KEY"));
        assert!(removes(&patch, "ANTHROPIC_API_KEY"));
        assert!(sets(&patch, "CLAUDE_CONFIG_DIR", "/acc/a2"));
    }

    #[test]
    fn session_env_merges_the_session_account_after_the_other_accounts() {
        // The same case through session_env. Claude accounts stand in again, and
        // the session reports another harness so the project's Claude account
        // counts as an other harness's.
        let secrets = MemorySecretStore::default();
        let other = account("a1", vec![plain("ANTHROPIC_API_KEY", "sk-other")]);
        let own = account("a2", vec![]);

        let patch = session_env("codex", Some(&own), &[other], &secrets).unwrap();

        assert_eq!(
            effect(&patch),
            effect(&account_env(&Claude, &own, &secrets).unwrap())
        );
        assert!(removes(&patch, "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn session_env_default_session_drops_project_account_for_same_harness() {
        let a1 = account("a1", vec![]);
        let patch = session_env("claude", None, &[a1], &MemorySecretStore::default()).unwrap();
        assert_eq!(patch, EnvPatch::default());
    }

    #[test]
    fn session_env_fails_when_the_session_account_secret_is_missing() {
        let a2 = account("a2", vec![secret("ANTHROPIC_API_KEY")]);
        let err = session_env("claude", Some(&a2), &[], &MemorySecretStore::default()).unwrap_err();
        assert!(matches!(err, AccountError::Secret { .. }), "got {err:?}");
    }

    // -- EnvPatch --

    #[test]
    fn from_vars_sets_without_removing() {
        let patch =
            EnvPatch::from_vars(pairs(&[("VERUN_PORT_0", "3000"), ("VERUN_TASK_ID", "t1")]));

        assert_eq!(
            patch,
            EnvPatch {
                remove: vec![],
                set: pairs(&[("VERUN_PORT_0", "3000"), ("VERUN_TASK_ID", "t1")]),
            }
        );
        // A key given twice keeps its last value.
        assert_eq!(
            EnvPatch::from_vars(pairs(&[("A", "1"), ("B", "1"), ("A", "2")])).set,
            pairs(&[("B", "1"), ("A", "2")])
        );
    }

    #[test]
    fn is_empty_only_without_removals_and_sets() {
        assert!(EnvPatch::default().is_empty());
        assert!(EnvPatch::from_vars(vec![]).is_empty());
        assert!(!EnvPatch {
            remove: strings(&["A"]),
            set: vec![],
        }
        .is_empty());
        assert!(!EnvPatch::from_vars(pairs(&[("A", "1")])).is_empty());
    }

    #[test]
    fn merge_later_set_wins_and_unremoves() {
        let mut patch = EnvPatch {
            remove: strings(&["A", "B"]),
            set: pairs(&[("X", "1"), ("Y", "1")]),
        };
        patch.merge(EnvPatch {
            remove: strings(&["B", "C"]),
            set: pairs(&[("A", "2"), ("X", "2")]),
        });

        // A was removed before and is set by the later patch, so it is no
        // longer removed. B is removed by both and listed once.
        assert_eq!(patch.remove, strings(&["B", "C"]));
        // X takes the later value, and the later patch's vars come last.
        assert_eq!(patch.set, pairs(&[("Y", "1"), ("A", "2"), ("X", "2")]));
    }

    #[test]
    fn merge_later_remove_deletes_earlier_set() {
        let mut patch = EnvPatch::from_vars(pairs(&[("FOO", "1"), ("BAR", "1")]));
        patch.merge(EnvPatch {
            remove: strings(&["FOO"]),
            set: vec![],
        });

        // FOO is only removed now. What the earlier patch set for BAR stays.
        assert_eq!(patch.remove, strings(&["FOO"]));
        assert_eq!(patch.set, pairs(&[("BAR", "1")]));
    }

    #[test]
    fn merge_a_var_the_later_patch_removes_and_sets_ends_up_set() {
        // An API key account scrubs the inherited key and sets its own. Merged
        // after anything else it must still set it.
        let mut patch = EnvPatch {
            remove: strings(&["TOKEN"]),
            set: pairs(&[("KEY", "old")]),
        };
        patch.merge(EnvPatch {
            remove: strings(&["KEY", "TOKEN"]),
            set: pairs(&[("KEY", "new")]),
        });

        assert_eq!(patch.remove, strings(&["TOKEN"]));
        assert_eq!(patch.set, pairs(&[("KEY", "new")]));
    }

    #[test]
    fn merge_into_an_empty_patch_keeps_the_effect_of_the_later_one() {
        let account_patch = EnvPatch {
            remove: strings(&[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CONFIG_DIR",
            ]),
            set: pairs(&[
                ("CLAUDE_CONFIG_DIR", "/acc/a1"),
                ("ANTHROPIC_API_KEY", "sk"),
            ]),
        };
        let mut patch = EnvPatch::default();
        patch.merge(account_patch.clone());

        // The vars it both removes and sets are just set now.
        assert_eq!(patch.remove, strings(&["ANTHROPIC_AUTH_TOKEN"]));
        assert_eq!(patch.set, account_patch.set);
        assert_eq!(effect(&patch), effect(&account_patch));
    }

    #[test]
    fn merging_an_empty_patch_changes_nothing() {
        let mut patch = EnvPatch {
            remove: strings(&["A"]),
            set: pairs(&[("B", "1")]),
        };
        let before = patch.clone();

        patch.merge(EnvPatch::default());

        assert_eq!(patch, before);
    }

    #[test]
    fn apply_to_std_command_removes_first_then_sets() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: pairs(&[("CLAUDE_CONFIG_DIR", "/acc/a1")]),
        };
        let mut cmd = std::process::Command::new("claude");
        cmd.env("VERUN_PORT_0", "3000");

        patch.apply_to_std_command(&mut cmd);

        // The key in both lists ends up set, the other one removed, and what
        // the command already had is left alone.
        let mut env = recorded_env(&cmd);
        env.sort();
        assert_eq!(
            env,
            vec![
                ("ANTHROPIC_API_KEY".to_string(), None),
                ("CLAUDE_CONFIG_DIR".to_string(), Some("/acc/a1".to_string())),
                ("VERUN_PORT_0".to_string(), Some("3000".to_string())),
            ]
        );
    }

    #[test]
    fn apply_to_command_removes_first_then_sets() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: pairs(&[("CLAUDE_CONFIG_DIR", "/acc/a1")]),
        };
        let mut cmd = tokio::process::Command::new("claude");
        cmd.env("VERUN_PORT_0", "3000");

        patch.apply_to_command(&mut cmd);

        let mut env = recorded_env(cmd.as_std());
        env.sort();
        assert_eq!(
            env,
            vec![
                ("ANTHROPIC_API_KEY".to_string(), None),
                ("CLAUDE_CONFIG_DIR".to_string(), Some("/acc/a1".to_string())),
                ("VERUN_PORT_0".to_string(), Some("3000".to_string())),
            ]
        );
    }

    #[test]
    fn env_patch_applies_to_pty_builder() {
        let patch = EnvPatch {
            remove: strings(&["HOME"]),
            set: pairs(&[("FOO", "bar")]),
        };
        let mut builder = portable_pty::CommandBuilder::new("sh");
        // The builder starts from Verun's own env. Give it a HOME of its own
        // so the test does not depend on the one it ran under.
        builder.env("HOME", "/Users/me");

        patch.apply_to_pty(&mut builder);

        assert_eq!(builder.get_env("HOME"), None);
        assert_eq!(builder.get_env("FOO"), Some(std::ffi::OsStr::new("bar")));
    }

    #[test]
    fn apply_to_pty_removes_first_then_sets() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: pairs(&[("CLAUDE_CONFIG_DIR", "/acc/a1")]),
        };
        let mut builder = portable_pty::CommandBuilder::new("sh");
        builder.env("ANTHROPIC_API_KEY", "sk-inherited");
        builder.env("CLAUDE_CONFIG_DIR", "/Users/me/.claude");
        builder.env("VERUN_PORT_0", "3000");

        patch.apply_to_pty(&mut builder);

        // The key in both lists ends up set, the other one removed, and what
        // the builder already had is left alone.
        assert_eq!(builder.get_env("ANTHROPIC_API_KEY"), None);
        assert_eq!(
            builder.get_env("CLAUDE_CONFIG_DIR"),
            Some(std::ffi::OsStr::new("/acc/a1"))
        );
        assert_eq!(
            builder.get_env("VERUN_PORT_0"),
            Some(std::ffi::OsStr::new("3000"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_child_sees_the_account_env_and_none_of_the_scrubbed_vars() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: pairs(&[("CLAUDE_CONFIG_DIR", "/acc/a1")]),
        };
        let mut cmd = std::process::Command::new("sh");
        cmd.args([
            "-c",
            r#"printf '%s|%s' "${ANTHROPIC_API_KEY-unset}" "${CLAUDE_CONFIG_DIR-unset}""#,
        ]);
        // What Verun itself would have inherited.
        cmd.env("ANTHROPIC_API_KEY", "sk-inherited")
            .env("CLAUDE_CONFIG_DIR", "/Users/me/.claude");

        patch.apply_to_std_command(&mut cmd);

        let output = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset|/acc/a1");
    }

    #[test]
    fn an_empty_patch_leaves_the_command_alone() {
        let mut cmd = std::process::Command::new("claude");
        EnvPatch::default().apply_to_std_command(&mut cmd);
        assert_eq!(recorded_env(&cmd), vec![]);
    }

    #[test]
    fn env_patch_debug_masks_values() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY"]),
            set: pairs(&[
                ("CLAUDE_CONFIG_DIR", "/acc/a1"),
                ("ANTHROPIC_API_KEY", "sk-ant-secret"),
            ]),
        };

        // The keys show and every value is masked: a patch cannot tell a
        // secret from a plain value.
        assert_eq!(
            format!("{patch:?}"),
            r#"EnvPatch { remove: ["ANTHROPIC_API_KEY"], set: [("CLAUDE_CONFIG_DIR", "***"), ("ANTHROPIC_API_KEY", "***")] }"#
        );
        // The pretty form goes through the same impl.
        let pretty = format!("{patch:#?}");
        assert!(!pretty.contains("sk-ant-secret"), "{pretty}");
        assert!(!pretty.contains("/acc/a1"), "{pretty}");
    }

    // -- shell_wrap --

    /// What `shell_wrap(inner, patch)` prints when run the way a spawn site
    /// runs it: in a plain `/bin/sh` that inherited `ANTHROPIC_API_KEY=leak`,
    /// with the script var set. `profile` is shell code that runs first in the
    /// same shell, standing in for what the user's profile exports before the
    /// outer command. The sh gets no other env, so the result depends neither
    /// on the developer's env nor on their profile.
    #[cfg(unix)]
    fn run_wrapped(profile: &str, inner: &str, patch: &EnvPatch) -> String {
        let (outer, vars) = shell_wrap(inner, patch);
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &format!("{profile}{outer}")])
            .env_clear()
            .env("ANTHROPIC_API_KEY", "leak");
        for (key, value) in &vars {
            cmd.env(key, value);
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// The patch of the cases below: drop an inherited key, set a dir whose
    /// name has a space and a quote.
    fn client_patch() -> EnvPatch {
        EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY"]),
            set: pairs(&[("CLAUDE_CONFIG_DIR", "/x/Client Accounts/o'brien")]),
        }
    }

    #[test]
    fn shell_wrap_is_identity_for_empty_env() {
        let (outer, vars) = shell_wrap("exec claude --model 'opus'", &EnvPatch::default());

        assert_eq!(outer, "exec claude --model 'opus'");
        assert_eq!(vars, vec![]);
    }

    #[test]
    fn shell_wrap_outer_command_contains_no_values() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY"]),
            set: pairs(&[
                ("ANTHROPIC_API_KEY", "sk-ant-secret"),
                ("CLAUDE_CONFIG_DIR", "/x/acc"),
            ]),
        };

        let (outer, vars) = shell_wrap("exec claude", &patch);

        assert!(!outer.contains("sk-ant-secret"), "{outer}");
        assert!(!outer.contains("/x/acc"), "{outer}");
        // The values travel in the script var instead.
        assert_eq!(vars.len(), 1);
        assert!(vars[0].1.contains("sk-ant-secret"));
    }

    #[test]
    fn shell_wrap_script_unsets_then_exports_then_runs() {
        let (outer, vars) = shell_wrap("exec claude --model 'opus'", &client_patch());

        assert_eq!(outer, r#"exec /bin/sh -c 'eval "$VERUN_ACCOUNT_SCRIPT"'"#);
        assert_eq!(
            vars,
            pairs(&[(
                ACCOUNT_SCRIPT_VAR,
                "unset VERUN_ACCOUNT_SCRIPT ANTHROPIC_API_KEY; export CLAUDE_CONFIG_DIR='/x/Client Accounts/o'\\''brien'; exec claude --model 'opus'"
            )])
        );
    }

    #[test]
    fn shell_wrap_without_removals_still_unsets_the_script_var() {
        let patch = EnvPatch::from_vars(pairs(&[
            ("CLAUDE_CONFIG_DIR", "/x/a"),
            ("ANTHROPIC_BASE_URL", "https://proxy"),
        ]));

        let (_, vars) = shell_wrap("exec claude", &patch);

        assert_eq!(
            vars,
            pairs(&[(
                ACCOUNT_SCRIPT_VAR,
                "unset VERUN_ACCOUNT_SCRIPT; export CLAUDE_CONFIG_DIR='/x/a' ANTHROPIC_BASE_URL='https://proxy'; exec claude"
            )])
        );
    }

    #[test]
    fn shell_wrap_without_sets_omits_the_export_clause() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: vec![],
        };

        let (_, vars) = shell_wrap("exec claude", &patch);

        // No bare `export`, which would print the whole env.
        assert_eq!(
            vars,
            pairs(&[(
                ACCOUNT_SCRIPT_VAR,
                "unset VERUN_ACCOUNT_SCRIPT ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR; exec claude"
            )])
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_runs_in_real_sh() {
        let printed = run_wrapped(
            "",
            r#"printf '%s|%s' "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}""#,
            &client_patch(),
        );

        // The dir arrives byte-identical and the inherited key is gone.
        assert_eq!(printed, "/x/Client Accounts/o'brien|unset");
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_beats_profile_exports() {
        // The profile runs before the outer command and re-exports a var the
        // account sets and one it removes.
        let printed = run_wrapped(
            "export CLAUDE_CONFIG_DIR=/wrong ANTHROPIC_API_KEY=from-profile; ",
            r#"printf '%s|%s' "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}""#,
            &client_patch(),
        );

        assert_eq!(printed, "/x/Client Accounts/o'brien|unset");
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_applies_an_account_patch_over_a_profile() {
        // The patch account_env builds removes CLAUDE_CONFIG_DIR and
        // ANTHROPIC_BASE_URL and sets them too: they must end up set.
        let account = account("a1", vec![plain("ANTHROPIC_BASE_URL", "https://proxy")]);
        let patch = account_env(&Claude, &account, &MemorySecretStore::default()).unwrap();

        let printed = run_wrapped(
            "export CLAUDE_CONFIG_DIR=/wrong ANTHROPIC_BASE_URL=https://profile; ",
            r#"printf '%s|%s|%s' "$CLAUDE_CONFIG_DIR" "$ANTHROPIC_BASE_URL" "${ANTHROPIC_API_KEY-unset}""#,
            &patch,
        );

        assert_eq!(printed, "/acc/a1|https://proxy|unset");
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_hides_the_script_from_the_command() {
        // The script holds the secrets, so the command and what it starts must
        // not inherit it. The inner sh reads its own inherited env.
        let patch = EnvPatch::from_vars(pairs(&[("ANTHROPIC_API_KEY", "sk-ant-secret")]));

        let printed = run_wrapped(
            "",
            r#"/bin/sh -c 'printf "%s|%s" "${VERUN_ACCOUNT_SCRIPT-unset}" "$ANTHROPIC_API_KEY"'"#,
            &patch,
        );

        assert_eq!(printed, "unset|sk-ant-secret");
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_exports_cross_exec() {
        // The command replaces the sh with `exec`, as terminal mode's does, so
        // the exports have to reach a separate program and not only the
        // builtins of the sh that ran them. `env` prints what it inherited.
        let account = account("a1", vec![]);
        let patch = account_env(&Claude, &account, &MemorySecretStore::default()).unwrap();

        let printed = run_wrapped(
            "export CLAUDE_CONFIG_DIR=/wrong; ",
            "exec /usr/bin/env",
            &patch,
        );

        let lines: Vec<&str> = printed.lines().collect();
        assert!(
            lines.contains(&"CLAUDE_CONFIG_DIR=/acc/a1"),
            "env printed {lines:?}"
        );
        // `run_wrapped` inherited ANTHROPIC_API_KEY=leak, which the patch
        // removes, and the script var must be gone by now.
        assert!(
            !lines
                .iter()
                .any(|line| line.starts_with("ANTHROPIC_API_KEY=")),
            "env printed {lines:?}"
        );
        assert!(
            !lines
                .iter()
                .any(|line| line.starts_with("VERUN_ACCOUNT_SCRIPT=")),
            "env printed {lines:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_keeps_values_out_of_argv() {
        let patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY"]),
            set: pairs(&[
                ("ANTHROPIC_API_KEY", "sk-ant-secret"),
                ("CLAUDE_CONFIG_DIR", "/x/Client Accounts/o'brien"),
            ]),
        };

        // The login shell gets the outer command as an argument: no value in
        // it, and no assignment either.
        let (outer, _) = shell_wrap("exec claude", &patch);
        assert!(!outer.contains("sk-ant-secret"), "{outer}");
        assert!(!outer.contains("o'brien"), "{outer}");
        assert!(!outer.contains('='), "{outer}");

        // The sh that runs the script reads it from its env, so its own
        // arguments hold no value either. The command does not start with
        // exec, so that sh is still there for ps to show.
        let printed = run_wrapped("", "ps -o args= -p $$", &patch);
        assert!(printed.contains("eval"), "ps printed {printed:?}");
        assert!(!printed.contains("sk-ant-secret"), "{printed}");
        assert!(!printed.contains("o'brien"), "{printed}");
    }

    #[cfg(unix)]
    #[test]
    fn shell_wrap_delivers_awkward_values_byte_identical() {
        let values = [
            "/Users/me/Client Accounts/o'brien",
            "/Users/müller/日本語/🙂",
            "$HOME `id` $(id) \"quoted\" back\\slash",
            "semi;colon && pipe | glob * ? [a] #hash ~ !bang",
            "line one\nline two\n",
            "  padded\twith tab  ",
            "'",
            "''a''",
            "-n",
            "",
        ];
        for value in values {
            let patch = EnvPatch::from_vars(pairs(&[("ACCOUNT_VALUE", value)]));

            let printed = run_wrapped("", r#"printf '%s' "$ACCOUNT_VALUE""#, &patch);

            assert_eq!(printed, value, "value {value:?}");
        }
    }
}
