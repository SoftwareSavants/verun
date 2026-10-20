//! The env an account adds to a spawn, as a patch over the env the process
//! would otherwise inherit.
//!
//! An added account runs with its own home and env vars, and nothing Verun
//! inherited may override them. `account_env` turns one account into a patch,
//! and `project_env` and `session_env` combine the patches of the accounts a
//! spawn follows. The spawn sites apply the result. Default sessions have no
//! account and get an empty patch, so they keep the env they have today.

use super::secrets::SecretStore;
use super::AccountError;
use crate::agent::{Agent, AgentKind};
use crate::db::{Account, AccountEnvVar};
use std::path::Path;

/// Changes to the env a spawned process inherits: vars to remove, and vars to
/// set.
///
/// A patch is applied remove-first, then set, so a var in both lists ends up
/// set. That is how an account with its own `ANTHROPIC_API_KEY` works: the
/// harness's scrub list removes the key Verun inherited and the account sets
/// its own.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvPatch {
    pub remove: Vec<String>,
    pub set: Vec<(String, String)>,
}

impl EnvPatch {
    /// A patch that only sets `vars`. A key given twice keeps its last value.
    #[allow(dead_code)] // consumed by the account service
    pub fn from_vars(vars: Vec<(String, String)>) -> Self {
        let mut patch = Self::default();
        for (key, value) in vars {
            patch.set_var(key, value);
        }
        patch
    }

    /// Whether applying the patch would change nothing.
    #[allow(dead_code)] // consumed by the account service
    pub fn is_empty(&self) -> bool {
        self.remove.is_empty() && self.set.is_empty()
    }

    /// Adds `other`, the later patch, to this one. For a key both set,
    /// `other`'s value wins, and a key `other` sets is dropped from this
    /// patch's removals: an earlier account's scrub does not stand against a
    /// later account's own value.
    pub fn merge(&mut self, other: EnvPatch) {
        self.remove
            .retain(|key| !other.set.iter().any(|(set_key, _)| set_key == key));
        for key in other.remove {
            if !self.remove.contains(&key) {
                self.remove.push(key);
            }
        }
        for (key, value) in other.set {
            self.set_var(key, value);
        }
    }

    /// Applies the patch to a command: every var in `remove`, then every var
    /// in `set`. The order matters because a command keeps one entry per var
    /// and the last call wins, so a var in both lists is set only if it is
    /// removed first.
    #[allow(dead_code)] // consumed by the account service
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

    /// Sets `key`, replacing any value already set for it. The var moves to
    /// the end, so `set` stays in the order the values took effect.
    fn set_var(&mut self, key: String, value: String) {
        self.set.retain(|(existing, _)| *existing != key);
        self.set.push((key, value));
    }
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
#[allow(dead_code)] // consumed by the account service
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
#[allow(dead_code)] // consumed by the account service
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
/// `session_account` is an account of `session_agent_type`'s harness, and it
/// is applied whether or not that harness reaches the project's shells. May
/// block on the keychain like `account_env`.
#[allow(dead_code)] // consumed by the account service
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
/// wants them in a project's env. Both combinations are built from this.
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
        let a1 = account("a1", vec![plain("ANTHROPIC_BASE_URL", "https://proxy")]);

        assert_eq!(
            project_env(std::slice::from_ref(&a1), &secrets).unwrap(),
            account_env(&Claude, &a1, &secrets).unwrap()
        );
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
        assert_eq!(patch, account_env(&Claude, &a2, &secrets).unwrap());
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
    fn merge_into_an_empty_patch_changes_nothing() {
        // A patch may remove and set the same var (an API key account scrubs
        // the inherited key and sets its own); merging must keep both.
        let account_patch = EnvPatch {
            remove: strings(&["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]),
            set: pairs(&[
                ("CLAUDE_CONFIG_DIR", "/acc/a1"),
                ("ANTHROPIC_API_KEY", "sk"),
            ]),
        };
        let mut patch = EnvPatch::default();
        patch.merge(account_patch.clone());
        assert_eq!(patch, account_patch);

        patch.merge(EnvPatch::default());
        assert_eq!(patch, account_patch);
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
}
