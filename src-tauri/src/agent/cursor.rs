use super::account_files::inherited_home_dir;
use super::{AccountHome, AccountProfile, Agent, AgentKind, InputMode, SessionArgs};
use crate::accounts::identity::{
    non_empty_str, read_identity_object, AccountIdentity, SignInStatus,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Cursor Agent CLI - headless coding agent from Cursor.
///
/// Binary: `agent`
/// Non-interactive: `agent -p --output-format stream-json`
/// Resume: `--resume <chat_id>` or `--continue` (most recent)
/// Model: `--model <model>`
/// Approval: `--force` / `--yolo` (auto-approve file modifications)
/// Plan mode: `--mode plan`
/// Docs: https://cursor.com/docs/cli/overview
pub struct Cursor;

impl Agent for Cursor {
    fn kind(&self) -> AgentKind {
        AgentKind::Cursor
    }
    fn display_name(&self) -> &'static str {
        "Cursor Agent"
    }
    fn cli_binary(&self) -> &'static str {
        "agent"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::PositionalOrStdin
    }

    fn install_hint(&self) -> &'static str {
        "curl https://cursor.com/install -fsSL | bash"
    }

    fn docs_url(&self) -> &'static str {
        "https://cursor.com/docs/cli/overview#installation"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        // Fallback used when `agent --list-models` is unavailable or fails.
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("auto", "Auto", ""),
            ModelOption::new("composer-2-fast", "Composer 2 Fast", "Default"),
            ModelOption::new("composer-2", "Composer 2", "Balanced"),
            ModelOption::new("gpt-5.3-codex", "Codex 5.3", "Coding"),
            ModelOption::new("gpt-5.2", "GPT-5.2", "OpenAI"),
        ]
    }

    fn model_list_args(&self) -> Option<Vec<String>> {
        Some(vec!["--list-models".into()])
    }

    fn parse_model_list(&self, output: &str) -> Vec<crate::agent::ModelOption> {
        // Output format (one per line):
        //   <id> - <Name>  (default)
        // Skip "Available models" header and "Tip:" footer.
        output
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let sep = line.find(" - ")?;
                let id = line[..sep].trim();
                if id.is_empty() {
                    return None;
                }
                // Strip trailing "(default)" from the display name
                let name = line[sep + 3..]
                    .trim()
                    .trim_end_matches("(default)")
                    .trim()
                    .to_string();
                if name.is_empty() {
                    return None;
                }
                Some(crate::agent::ModelOption::new(id, &name, ""))
            })
            .collect()
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--stream-partial-output".into(),
            "--force".into(),
            "--trust".into(),
        ];

        if args.plan_mode {
            v.extend(["--mode".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }

        // Prompt as positional arg — agent -p [flags] <prompt>
        if !args.message.is_empty() {
            v.push(args.message.to_string());
        }

        v
    }

    fn supports_plan_mode(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        let t = v.get("type")?.as_str()?;
        match t {
            "system" if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                v.get("session_id")?.as_str().map(str::to_string)
            }
            "result" => v.get("session_id")?.as_str().map(str::to_string),
            _ => None,
        }
    }

    fn account_profile(&self) -> Option<AccountProfile> {
        // Cursor's login lives in fixed keychain entries that every config dir
        // shares, so an added account has no login of its own: it is an API key
        // account. The in-memory credential store keeps that key from replacing
        // the user's own login in the keychain.
        Some(AccountProfile {
            scrub_vars: &[
                CONFIG_DIR_VAR,
                DATA_DIR_VAR,
                API_KEY_VAR,
                CREDENTIAL_STORE_VAR,
            ],
            fixed_env: &[(CREDENTIAL_STORE_VAR, "memory")],
            api_key_vars: &[API_KEY_VAR],
            login_args: None,
            logout_args: None,
            login_hint: None,
            logout_hint: None,
            allows_existing_dir: false,
            required_secret: Some(API_KEY_VAR),
            in_project_env: true,
            min_cli_version: None,
        })
    }

    fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
        vec![
            (
                CONFIG_DIR_VAR.to_string(),
                config_dir(dir).to_string_lossy().into_owned(),
            ),
            (
                DATA_DIR_VAR.to_string(),
                data_dir(dir).to_string_lossy().into_owned(),
            ),
        ]
    }

    fn prepare_account_dir(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(config_dir(dir))?;
        std::fs::create_dir_all(data_dir(dir))
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        cursor_identity(home, std::env::var_os(CONFIG_DIR_VAR))
    }
}

const CONFIG_DIR_VAR: &str = "CURSOR_CONFIG_DIR";
const DATA_DIR_VAR: &str = "CURSOR_DATA_DIR";
const API_KEY_VAR: &str = "CURSOR_API_KEY";
const CREDENTIAL_STORE_VAR: &str = "AGENT_CLI_CREDENTIAL_STORE";

/// Where an account keeps Cursor's config (`cli-config.json`) and its data.
fn config_dir(dir: &Path) -> PathBuf {
    dir.join("cfg")
}

fn data_dir(dir: &Path) -> PathBuf {
    dir.join("data")
}

/// Who `agent` is set up as at `home`: the `authInfo.email` of
/// `cli-config.json`. The file says nothing about whether the credentials are
/// still good (they are in the keychain), so the status is `Unknown`; an added
/// account that holds an API key shows as such (see `with_api_key_overlay`).
///
/// Default's config dir is the `CURSOR_CONFIG_DIR` Verun inherited, else
/// `~/.cursor`. `inherited_config_dir` is passed in so tests need not touch the
/// process env.
fn cursor_identity(
    home: AccountHome<'_>,
    inherited_config_dir: Option<OsString>,
) -> AccountIdentity {
    let dir = match home {
        AccountHome::Dir(dir) => config_dir(dir),
        AccountHome::Default { user_home } => inherited_home_dir(inherited_config_dir)
            .map_or_else(|| user_home.join(".cursor"), PathBuf::from),
    };
    let config = match read_identity_object(&dir.join("cli-config.json")) {
        Ok(config) => config,
        Err(identity) => return identity,
    };
    AccountIdentity {
        status: SignInStatus::Unknown,
        email: config
            .get("authInfo")
            .and_then(|auth| non_empty_str(auth, "email")),
        ..AccountIdentity::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::env::account_env;
    use crate::accounts::identity::SignInStatus;
    use crate::accounts::secrets::{MemorySecretStore, SecretStore};
    use crate::db::{Account, AccountEnvVar};
    use tempfile::TempDir;

    #[test]
    fn cursor_profile_values() {
        assert_eq!(
            Cursor.account_profile(),
            Some(AccountProfile {
                scrub_vars: &[
                    "CURSOR_CONFIG_DIR",
                    "CURSOR_DATA_DIR",
                    "CURSOR_API_KEY",
                    "AGENT_CLI_CREDENTIAL_STORE",
                ],
                fixed_env: &[("AGENT_CLI_CREDENTIAL_STORE", "memory")],
                api_key_vars: &["CURSOR_API_KEY"],
                login_args: None,
                logout_args: None,
                login_hint: None,
                logout_hint: None,
                allows_existing_dir: false,
                required_secret: Some("CURSOR_API_KEY"),
                in_project_env: true,
                min_cli_version: None,
            })
        );
    }

    #[test]
    fn cursor_home_env_layout() {
        assert_eq!(
            Cursor.account_home_env(Path::new("/acc/c1")),
            vec![
                ("CURSOR_CONFIG_DIR".to_string(), "/acc/c1/cfg".to_string()),
                ("CURSOR_DATA_DIR".to_string(), "/acc/c1/data".to_string()),
            ]
        );
    }

    #[test]
    fn cursor_prepare_dir_creates_cfg_and_data() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("accounts").join("c1");
        Cursor.prepare_account_dir(&dir).unwrap();
        assert!(dir.join("cfg").is_dir());
        assert!(dir.join("data").is_dir());
    }

    #[test]
    fn cursor_account_env_pairs_api_key_with_memory_store() {
        let account = Account {
            id: "c1".into(),
            agent_type: "cursor".into(),
            label: "Work".into(),
            color: "#000000".into(),
            config_dir: "/acc/c1".into(),
            managed_dir: true,
            env: vec![AccountEnvVar {
                key: "CURSOR_API_KEY".into(),
                value: None,
                secret: true,
            }],
            removed_at: None,
            created_at: 0,
        };
        let secrets = MemorySecretStore::default();
        secrets.set("c1", "CURSOR_API_KEY", "key-1").unwrap();

        let patch = account_env(&Cursor, &account, &secrets).unwrap();

        // The key and the memory store always come together, so the key never
        // lands in the user's own keychain login.
        for (key, value) in [
            ("CURSOR_API_KEY", "key-1"),
            ("AGENT_CLI_CREDENTIAL_STORE", "memory"),
        ] {
            assert!(
                patch.set.contains(&(key.to_string(), value.to_string())),
                "missing {key}"
            );
        }
    }

    fn write_config(dir: &Path, text: &str) {
        let cfg = dir.join("cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("cli-config.json"), text).unwrap();
    }

    #[test]
    fn cursor_identity_reads_auth_info_email() {
        let dir = TempDir::new().unwrap();
        write_config(dir.path(), r#"{"authInfo":{"email":"dev@acme.com"}}"#);
        assert_eq!(
            Cursor.read_account_identity(AccountHome::Dir(dir.path())),
            AccountIdentity {
                status: SignInStatus::Unknown,
                email: Some("dev@acme.com".into()),
                ..AccountIdentity::default()
            }
        );
    }

    #[test]
    fn cursor_identity_without_email_or_file() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            Cursor
                .read_account_identity(AccountHome::Dir(dir.path()))
                .status,
            SignInStatus::SignedOut
        );
        write_config(dir.path(), "{}");
        assert_eq!(
            Cursor.read_account_identity(AccountHome::Dir(dir.path())),
            AccountIdentity::with_status(SignInStatus::Unknown)
        );
        write_config(dir.path(), "not json");
        assert_eq!(
            Cursor
                .read_account_identity(AccountHome::Dir(dir.path()))
                .status,
            SignInStatus::Unknown
        );
    }

    #[test]
    fn cursor_default_identity_reads_the_standard_config() {
        let user_home = TempDir::new().unwrap();
        let cursor = user_home.path().join(".cursor");
        std::fs::create_dir_all(&cursor).unwrap();
        std::fs::write(
            cursor.join("cli-config.json"),
            r#"{"authInfo":{"email":"me@acme.com"}}"#,
        )
        .unwrap();
        let identity = Cursor.read_account_identity(AccountHome::Default {
            user_home: user_home.path(),
        });
        assert_eq!(identity.email.as_deref(), Some("me@acme.com"));
    }
}
