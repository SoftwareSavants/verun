use super::account_files::inherited_home_dir;
use super::{AccountHome, AccountProfile, Agent, AgentKind, InputMode, SessionArgs};
use crate::accounts::identity::{read_identity_object, AccountIdentity, SignInStatus};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// OpenCode - open-source AI coding agent by SST.
///
/// Binary: `opencode`
/// Non-interactive: `opencode run <prompt> --format json`
/// Resume: `--session <session_id>` or `--continue` (most recent)
/// Model: `--model <provider/model>` (e.g. `anthropic/claude-sonnet-4-5`)
/// Plan mode: `--agent plan` (read-only, all tools set to ask)
/// Install: `curl -fsSL https://opencode.ai/install | bash`
///          or `npm i -g opencode-ai`
/// Docs: https://opencode.ai/docs/cli/
pub struct OpenCode;

impl Agent for OpenCode {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }
    fn display_name(&self) -> &'static str {
        "OpenCode"
    }
    fn cli_binary(&self) -> &'static str {
        "opencode"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::PositionalOrStdin
    }

    fn install_hint(&self) -> &'static str {
        "curl -fsSL https://opencode.ai/install | bash"
    }

    fn docs_url(&self) -> &'static str {
        "https://opencode.ai/docs#install"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        // Fallback — OpenCode's model list is user/provider-specific.
        // If `opencode models` succeeds at runtime this is replaced entirely.
        vec![]
    }

    fn model_list_args(&self) -> Option<Vec<String>> {
        Some(vec!["models".into()])
    }

    fn parse_model_list(&self, output: &str) -> Vec<crate::agent::ModelOption> {
        // Output format (one per line): provider/model-id
        // Ignore migration messages and any line that isn't provider/model format.
        output
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                // Must contain exactly one '/' and no whitespace
                if !line.contains('/') || line.contains(' ') {
                    return None;
                }
                let label = line.split('/').next_back().unwrap_or(line).to_string();
                Some(crate::agent::ModelOption::new(line, &label, ""))
            })
            .collect()
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v: Vec<String> = vec!["run".into(), "--format".into(), "json".into()];

        if args.plan_mode {
            v.extend(["--agent".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--session".into(), rid.to_string()]);
        }

        // Prompt as positional arg — opencode run <prompt> [flags]
        if !args.message.is_empty() {
            v.push(args.message.to_string());
        }

        v
    }

    fn supports_plan_mode(&self) -> bool {
        true
    }
    fn supports_attachments(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        v.get("sessionID")?.as_str().map(str::to_string)
    }

    fn account_profile(&self) -> Option<AccountProfile> {
        Some(AccountProfile {
            // OpenCode has no home var of its own: the XDG dirs move its login
            // and sessions, and whatever Verun inherited must not override them.
            // The provider keys also sign it in, outside the account's login.
            scrub_vars: &[
                XDG_DATA_HOME_VAR,
                XDG_STATE_HOME_VAR,
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "OPENROUTER_API_KEY",
                "XAI_API_KEY",
                "GROQ_API_KEY",
                "MISTRAL_API_KEY",
                "DEEPSEEK_API_KEY",
            ],
            fixed_env: &[],
            api_key_vars: PROVIDER_KEY_VARS,
            login_args: Some(&["auth", "login"]),
            logout_args: Some(&["auth", "logout"]),
            login_hint: None,
            logout_hint: None,
            allows_existing_dir: false,
            required_secret: None,
            // The XDG vars would reach every tool a shell, hook or other
            // harness runs, so the account applies to OpenCode's own sessions
            // only.
            in_project_env: false,
            min_cli_version: None,
        })
    }

    fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
        vec![
            (
                XDG_DATA_HOME_VAR.to_string(),
                data_home(dir).to_string_lossy().into_owned(),
            ),
            (
                XDG_STATE_HOME_VAR.to_string(),
                state_home(dir).to_string_lossy().into_owned(),
            ),
        ]
    }

    fn prepare_account_dir(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_home(dir))?;
        std::fs::create_dir_all(state_home(dir))
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        opencode_identity(home, std::env::var_os(XDG_DATA_HOME_VAR))
    }
}

const XDG_DATA_HOME_VAR: &str = "XDG_DATA_HOME";
const XDG_STATE_HOME_VAR: &str = "XDG_STATE_HOME";

/// The provider keys OpenCode reads from the env, which sign it in without a
/// login.
const PROVIDER_KEY_VARS: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
];

/// Where an account keeps OpenCode's data (`auth.json`, sessions) and state.
fn data_home(dir: &Path) -> PathBuf {
    dir.join("data")
}

fn state_home(dir: &Path) -> PathBuf {
    dir.join("state")
}

/// Who `opencode` is signed in as at `home`. `<data>/opencode/auth.json` is a
/// JSON object keyed by provider id; it stores no email. Any provider means
/// signed in, an empty or missing file nobody. A file that is there but cannot
/// be read, or is not an object, is `Unknown`.
///
/// Default's data home is the `XDG_DATA_HOME` Verun inherited, else
/// `~/.local/share`. `inherited_data_home` is passed in so tests need not touch
/// the process env.
fn opencode_identity(
    home: AccountHome<'_>,
    inherited_data_home: Option<OsString>,
) -> AccountIdentity {
    let data = match home {
        AccountHome::Dir(dir) => data_home(dir),
        AccountHome::Default { user_home } => inherited_home_dir(inherited_data_home)
            .map_or_else(|| user_home.join(".local").join("share"), PathBuf::from),
    };
    let auth = match read_identity_object(&data.join("opencode").join("auth.json")) {
        Ok(auth) => auth,
        Err(identity) => return identity,
    };
    let mut providers: Vec<String> = auth.keys().cloned().collect();
    providers.sort();
    AccountIdentity {
        status: if providers.is_empty() {
            SignInStatus::SignedOut
        } else {
            SignInStatus::SignedIn
        },
        providers,
        ..AccountIdentity::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn opencode_profile_values() {
        assert_eq!(
            OpenCode.account_profile(),
            Some(AccountProfile {
                scrub_vars: &[
                    "XDG_DATA_HOME",
                    "XDG_STATE_HOME",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "GEMINI_API_KEY",
                    "GOOGLE_GENERATIVE_AI_API_KEY",
                    "OPENROUTER_API_KEY",
                    "XAI_API_KEY",
                    "GROQ_API_KEY",
                    "MISTRAL_API_KEY",
                    "DEEPSEEK_API_KEY",
                ],
                fixed_env: &[],
                api_key_vars: &[
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "GEMINI_API_KEY",
                    "GOOGLE_GENERATIVE_AI_API_KEY",
                    "OPENROUTER_API_KEY",
                    "XAI_API_KEY",
                    "GROQ_API_KEY",
                    "MISTRAL_API_KEY",
                    "DEEPSEEK_API_KEY",
                ],
                login_args: Some(&["auth", "login"]),
                logout_args: Some(&["auth", "logout"]),
                login_hint: None,
                logout_hint: None,
                allows_existing_dir: false,
                required_secret: None,
                in_project_env: false,
                min_cli_version: None,
            })
        );
    }

    #[test]
    fn opencode_home_env_layout() {
        assert_eq!(
            OpenCode.account_home_env(Path::new("/acc/o1")),
            vec![
                ("XDG_DATA_HOME".to_string(), "/acc/o1/data".to_string()),
                ("XDG_STATE_HOME".to_string(), "/acc/o1/state".to_string()),
            ]
        );
    }

    #[test]
    fn opencode_prepare_dir_creates_data_and_state() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("accounts").join("o1");
        OpenCode.prepare_account_dir(&dir).unwrap();
        assert!(dir.join("data").is_dir());
        assert!(dir.join("state").is_dir());
    }

    fn write_auth(data_home: &Path, text: &str) {
        let dir = data_home.join("opencode");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("auth.json"), text).unwrap();
    }

    fn account_identity(dir: &Path) -> AccountIdentity {
        OpenCode.read_account_identity(AccountHome::Dir(dir))
    }

    #[test]
    fn opencode_identity_lists_providers() {
        let dir = TempDir::new().unwrap();
        write_auth(
            &dir.path().join("data"),
            r#"{"openai":{"type":"oauth","access":"a"},"anthropic":{"type":"api","key":"k"}}"#,
        );
        assert_eq!(
            account_identity(dir.path()),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                providers: vec!["anthropic".into(), "openai".into()],
                ..AccountIdentity::default()
            }
        );
    }

    #[test]
    fn opencode_identity_signed_out_when_empty_or_missing() {
        let dir = TempDir::new().unwrap();
        assert_eq!(account_identity(dir.path()).status, SignInStatus::SignedOut);
        write_auth(&dir.path().join("data"), "{}");
        assert_eq!(
            account_identity(dir.path()),
            AccountIdentity::with_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn opencode_identity_unreadable_auth_is_unknown() {
        let dir = TempDir::new().unwrap();
        for text in ["not json", "[]"] {
            write_auth(&dir.path().join("data"), text);
            assert_eq!(
                account_identity(dir.path()).status,
                SignInStatus::Unknown,
                "text: {text}"
            );
        }
    }

    #[test]
    fn opencode_default_identity_reads_the_inherited_data_home_else_local_share() {
        let user_home = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_auth(&user_home.path().join(".local/share"), r#"{"groq":{}}"#);
        write_auth(inherited.path(), r#"{"openai":{}}"#);
        let default = AccountHome::Default {
            user_home: user_home.path(),
        };

        let providers =
            |inherited: Option<std::ffi::OsString>| opencode_identity(default, inherited).providers;
        assert_eq!(providers(None), vec!["groq".to_string()]);
        // An empty value counts as unset.
        assert_eq!(providers(Some("".into())), vec!["groq".to_string()]);
        assert_eq!(
            providers(Some(inherited.path().as_os_str().to_owned())),
            vec!["openai".to_string()]
        );
    }
}
