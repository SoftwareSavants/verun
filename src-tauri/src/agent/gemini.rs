use super::account_files::account_home_dir;
use super::{AccountHome, AccountProfile, Agent, AgentKind, InputMode, SessionArgs};
use crate::accounts::identity::{
    read_json_with_retry, unknown_identity, unread_file_identity, AccountIdentity, SignInStatus,
};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The env var that stands in for `HOME` as far as Gemini goes: it keeps its
/// files in `<dir>/.gemini`. Gemini CLI 0.25.0 is the first to read it.
const GEMINI_CLI_HOME_VAR: &str = "GEMINI_CLI_HOME";

/// Gemini CLI - Google's AI coding agent.
///
/// Binary: `gemini`
/// Non-interactive: `-p <prompt> --output-format stream-json`
/// Resume: `--resume <session_id>`
/// Model: `-m <model>`
/// Plan mode: `--approval-mode plan`
/// Docs: https://geminicli.com/docs/
pub struct Gemini;

impl Agent for Gemini {
    fn kind(&self) -> AgentKind {
        AgentKind::Gemini
    }
    fn display_name(&self) -> &'static str {
        "Gemini CLI"
    }
    fn cli_binary(&self) -> &'static str {
        "gemini"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::PositionalOrStdin
    }

    fn install_hint(&self) -> &'static str {
        "npm i -g @google/gemini-cli"
    }

    fn docs_url(&self) -> &'static str {
        "https://geminicli.com/docs/get-started"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("auto", "Auto", "Automatic model selection based on task"),
            ModelOption::new(
                "pro",
                "Gemini Pro",
                "Gemini 3 Pro - Complex reasoning tasks",
            ),
            ModelOption::new("flash", "Gemini Flash", "Gemini 2.5 Flash - Fast responses"),
            ModelOption::new(
                "flash-lite",
                "Gemini Flash Lite",
                "Lightweight flash variant",
            ),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v: Vec<String> = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--yolo".into(),
        ];

        if args.plan_mode {
            v.extend(["--approval-mode".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["-m".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }

        // -p with prompt as positional arg
        if !args.message.is_empty() {
            v.extend(["-p".into(), args.message.to_string()]);
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
        // Gemini stream-json emits an init event with session metadata.
        // Try common field names for the session identifier.
        v.get("sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .or_else(|| {
                v.get("session_id")
                    .and_then(|s| s.as_str())
                    .map(str::to_string)
            })
    }

    // ── Accounts ───────────────────────────────────────────────────────

    fn account_profile(&self) -> Option<AccountProfile> {
        Some(AccountProfile {
            // Everything that can point Gemini at another home, or sign it in
            // some other way than the account's own Google login. NO_BROWSER
            // and CI are here because they change how that sign-in runs. An
            // account that needs a key sets it in its own env.
            scrub_vars: &[
                GEMINI_CLI_HOME_VAR,
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_GENAI_USE_VERTEXAI",
                "NO_BROWSER",
                "CI",
            ],
            fixed_env: &[],
            // The one way to give an account a key of its own: a key typed
            // into Gemini's own dialog goes into a keychain entry that every
            // home shares. With no sign-in method chosen in settings.json (see
            // prepare_account_dir), Gemini takes such a key from the env, so an
            // account that has one works without a login.
            api_key_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            // Gemini has no login or logout command. The bare CLI asks how to
            // sign in (Login with Google opens the browser) and signs out with
            // `/auth signout`, so both terminals run it and the hints say what
            // to type.
            login_args: Some(&[]),
            logout_args: Some(&[]),
            login_hint: Some(
                "In Gemini, choose Login with Google and finish in your browser. When it is done, type /quit.",
            ),
            logout_hint: Some("Type /auth signout, then /quit."),
            allows_existing_dir: true,
            required_secret: None,
            in_project_env: true,
            min_cli_version: Some("0.25.0"),
        })
    }

    fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
        vec![(
            GEMINI_CLI_HOME_VAR.to_string(),
            dir.to_string_lossy().into_owned(),
        )]
    }

    fn account_standard_home(&self, user_home: &Path) -> Option<PathBuf> {
        // Where Gemini's home is when `GEMINI_CLI_HOME` is not set, whatever
        // Verun inherited.
        Some(standard_home(user_home))
    }

    /// Makes `<dir>/.gemini` and puts nothing in it. There is no settings.json
    /// to seed: Gemini's non-interactive runs take the sign-in method that
    /// settings.json names (`security.auth.selectedType`) before they look at
    /// the env, so a method chosen here would shut out an account that signs in
    /// with `GEMINI_API_KEY`. With none chosen, Gemini asks in the login
    /// terminal (Login with Google), or finds a key in the env, and records the
    /// choice itself.
    fn prepare_account_dir(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir.join(".gemini"))
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        gemini_identity(home, std::env::var_os(GEMINI_CLI_HOME_VAR))
    }
}

/// Gemini's home when `GEMINI_CLI_HOME` is not set: the user's home itself,
/// which has the files in its `.gemini`.
fn standard_home(user_home: &Path) -> PathBuf {
    user_home.to_path_buf()
}

/// Who `gemini` is signed in as at `home`. Gemini caches the Google account in
/// `.gemini/google_accounts.json` as `{"active": <email or null>, "old": [..]}`
/// and sign-out moves the active one to `old`; the credentials themselves are
/// never read. A home without the file, or with a null `active`, has nobody
/// signed in. A file that is there but cannot be read, or is not shaped the way
/// Gemini writes it, says nothing either way, so it is `Unknown` rather than a
/// guess at "signed out".
///
/// Gemini takes `$HOME` to be the dir of an added account, or for Default the
/// `GEMINI_CLI_HOME` Verun inherited, else the user's home: Default sessions
/// keep Verun's own env, so a `GEMINI_CLI_HOME` exported where Verun was
/// launched is the Default home. An empty or non-UTF-8 value counts as unset.
///
/// `inherited_gemini_home` is the `GEMINI_CLI_HOME` Verun itself was started
/// with, passed in so tests need not touch the process env.
fn gemini_identity(
    home: AccountHome<'_>,
    inherited_gemini_home: Option<OsString>,
) -> AccountIdentity {
    let path = account_home_dir(home, inherited_gemini_home, standard_home)
        .join(".gemini")
        .join("google_accounts.json");
    let Some(accounts) = read_json_with_retry(&path) else {
        return unread_file_identity(&path);
    };
    let Some(accounts) = accounts.as_object() else {
        return unknown_identity(&path, "is not a JSON object");
    };
    match accounts.get("active") {
        None | Some(Value::Null) => AccountIdentity::with_status(SignInStatus::SignedOut),
        Some(Value::String(email)) if !email.is_empty() => AccountIdentity {
            status: SignInStatus::SignedIn,
            email: Some(email.clone()),
            ..AccountIdentity::default()
        },
        Some(_) => unknown_identity(&path, "has an active account that is not an email"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── Accounts ────────────────────────────────────────────────────────

    #[test]
    fn gemini_profile_values() {
        assert_eq!(
            Gemini.account_profile(),
            Some(AccountProfile {
                scrub_vars: &[
                    "GEMINI_CLI_HOME",
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    "GOOGLE_GENAI_USE_VERTEXAI",
                    "NO_BROWSER",
                    "CI",
                ],
                fixed_env: &[],
                api_key_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
                // Gemini has no login or logout command: both run the bare CLI.
                login_args: Some(&[]),
                logout_args: Some(&[]),
                login_hint: Some(
                    "In Gemini, choose Login with Google and finish in your browser. When it is done, type /quit."
                ),
                logout_hint: Some("Type /auth signout, then /quit."),
                allows_existing_dir: true,
                required_secret: None,
                in_project_env: true,
                min_cli_version: Some("0.25.0"),
            })
        );
    }

    #[test]
    fn gemini_home_env_sets_gemini_cli_home_verbatim() {
        // Gemini takes the value as it is, so nothing may tidy the spelling on
        // the way to the env.
        for dir in [
            "/x/Client Accounts/acme",
            "/x/Client Accounts/acme/",
            "/x/./acme/../acme",
            "/x/o'brien-é",
        ] {
            assert_eq!(
                Gemini.account_home_env(Path::new(dir)),
                vec![("GEMINI_CLI_HOME".to_string(), dir.to_string())],
                "dir: {dir}"
            );
        }
    }

    #[test]
    fn gemini_standard_home_is_the_user_home() {
        // `GEMINI_CLI_HOME` stands in for `$HOME`, so with nothing set the home
        // itself is where Gemini looks (for `.gemini`).
        assert_eq!(
            Gemini.account_standard_home(Path::new("/Users/me")),
            Some(PathBuf::from("/Users/me"))
        );
    }

    #[test]
    fn gemini_prepare_dir_makes_the_gemini_dir_and_writes_no_settings() {
        // How to sign in is the user's choice, made in Gemini. A settings.json
        // from Verun would make it for them, and Gemini's non-interactive runs
        // go by it before they look at the env.
        let tmp = TempDir::new().unwrap();
        // The whole path is made, `.gemini` included, and it is empty.
        let dir = tmp.path().join("accounts").join("g1");
        Gemini.prepare_account_dir(&dir).unwrap();
        let gemini_dir = dir.join(".gemini");
        assert!(gemini_dir.is_dir());
        assert!(!gemini_dir.join("settings.json").exists());
        assert_eq!(fs::read_dir(&gemini_dir).unwrap().count(), 0);

        // Preparing it again leaves what is there alone and still writes none.
        fs::write(dir.join("marker"), "").unwrap();
        fs::write(gemini_dir.join("oauth_creds.json"), "{}").unwrap();
        Gemini.prepare_account_dir(&dir).unwrap();
        assert!(dir.join("marker").exists());
        assert_eq!(
            fs::read_to_string(gemini_dir.join("oauth_creds.json")).unwrap(),
            "{}"
        );
        assert!(!gemini_dir.join("settings.json").exists());
    }

    #[test]
    fn gemini_prepare_dir_leaves_existing_settings_as_they_are() {
        // Whoever wrote it, a settings.json that is there is not Verun's to
        // change, and an empty one is as much there as any.
        let tmp = TempDir::new().unwrap();
        let gemini_dir = tmp.path().join(".gemini");
        fs::create_dir(&gemini_dir).unwrap();
        let settings = gemini_dir.join("settings.json");
        for contents in ["", r#"{"theme":"Dracula"}"#] {
            fs::write(&settings, contents).unwrap();
            Gemini.prepare_account_dir(tmp.path()).unwrap();
            assert_eq!(fs::read_to_string(&settings).unwrap(), contents);
        }
    }

    /// Writes `json` as the `google_accounts.json` of the Gemini home `dir`.
    fn write_accounts(dir: &Path, json: &str) {
        let gemini_dir = dir.join(".gemini");
        fs::create_dir_all(&gemini_dir).unwrap();
        fs::write(gemini_dir.join("google_accounts.json"), json).unwrap();
    }

    fn identity_at(dir: &Path) -> AccountIdentity {
        Gemini.read_account_identity(AccountHome::Dir(dir))
    }

    fn only_status(status: SignInStatus) -> AccountIdentity {
        AccountIdentity::with_status(status)
    }

    #[test]
    fn gemini_identity_reads_active_account() {
        let dir = TempDir::new().unwrap();
        // `old` lists the accounts that signed out; only the active one counts.
        write_accounts(dir.path(), r#"{"active":"dev@acme.com","old":[]}"#);
        assert_eq!(
            identity_at(dir.path()),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                email: Some("dev@acme.com".into()),
                ..AccountIdentity::default()
            }
        );

        write_accounts(dir.path(), r#"{"active":null}"#);
        assert_eq!(
            identity_at(dir.path()),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn gemini_identity_signed_out_without_an_active_account() {
        // Sign-out moves the active account to `old`; a file without the key
        // says the same.
        for json in [
            r#"{"active":null,"old":["dev@acme.com"]}"#,
            r#"{"old":["dev@acme.com"]}"#,
            "{}",
        ] {
            let dir = TempDir::new().unwrap();
            write_accounts(dir.path(), json);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedOut),
                "file: {json}"
            );
        }
    }

    #[test]
    fn gemini_identity_missing_is_signed_out() {
        // A home that never saw a login has no file, and maybe no `.gemini`
        // either.
        let without_gemini_dir = TempDir::new().unwrap();
        let with_empty_gemini_dir = TempDir::new().unwrap();
        fs::create_dir(with_empty_gemini_dir.path().join(".gemini")).unwrap();
        for dir in [&without_gemini_dir, &with_empty_gemini_dir] {
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedOut)
            );
        }
    }

    #[test]
    fn gemini_identity_unknown_when_the_file_cannot_be_read() {
        // The file is there, so someone may well be signed in; "signed out"
        // would refuse the account on a guess.
        let unknown = only_status(SignInStatus::Unknown);
        // Not JSON, and empty, which is what a truncating rewrite leaves.
        for json in ["not json", "", r#"{"active":"#] {
            let dir = TempDir::new().unwrap();
            write_accounts(dir.path(), json);
            assert_eq!(identity_at(dir.path()), unknown, "file: {json:?}");
        }
        // Not a file.
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join(".gemini").join("google_accounts.json")).unwrap();
        assert_eq!(identity_at(dir.path()), unknown);
    }

    #[test]
    fn gemini_identity_unknown_for_an_unexpected_shape() {
        // Valid JSON, but not what Gemini writes: not a sign-out either.
        for json in [
            "[]",
            r#""dev@acme.com""#,
            "42",
            "null",
            r#"{"active":42}"#,
            r#"{"active":true}"#,
            r#"{"active":[]}"#,
            r#"{"active":{}}"#,
            // Gemini writes an email or null, never an empty string.
            r#"{"active":""}"#,
        ] {
            let dir = TempDir::new().unwrap();
            write_accounts(dir.path(), json);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::Unknown),
                "file: {json}"
            );
        }
    }

    #[test]
    fn gemini_identity_default_reads_dot_gemini_in_the_users_home() {
        let home = TempDir::new().unwrap();
        write_accounts(home.path(), r#"{"active":"dev@acme.com","old":[]}"#);
        // A google_accounts.json in the home folder itself is not Gemini's.
        fs::write(
            home.path().join("google_accounts.json"),
            r#"{"active":"wrong@acme.com"}"#,
        )
        .unwrap();

        let identity = gemini_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            None,
        );

        assert_eq!(identity.status, SignInStatus::SignedIn);
        assert_eq!(identity.email.as_deref(), Some("dev@acme.com"));
    }

    #[test]
    fn gemini_identity_default_without_a_login_is_signed_out() {
        let home = TempDir::new().unwrap();
        assert_eq!(
            gemini_identity(
                AccountHome::Default {
                    user_home: home.path(),
                },
                None,
            ),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn gemini_identity_default_follows_the_inherited_gemini_cli_home() {
        // Default sessions keep Verun's env, so a GEMINI_CLI_HOME exported
        // where Verun was launched is the Default home.
        let home = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_accounts(home.path(), r#"{"active":"home@x.dev"}"#);
        write_accounts(inherited.path(), r#"{"active":"inherited@x.dev"}"#);
        let default_email = |inherited: Option<OsString>| {
            let default = AccountHome::Default {
                user_home: home.path(),
            };
            gemini_identity(default, inherited).email
        };

        assert_eq!(
            default_email(Some(inherited.path().into())).as_deref(),
            Some("inherited@x.dev")
        );
        // An empty value counts as unset.
        assert_eq!(
            default_email(Some(OsString::new())).as_deref(),
            Some("home@x.dev")
        );
        assert_eq!(default_email(None).as_deref(), Some("home@x.dev"));
    }

    #[cfg(unix)]
    #[test]
    fn gemini_identity_default_treats_a_non_utf8_inherited_gemini_cli_home_as_unset() {
        use std::os::unix::ffi::OsStringExt;
        let home = TempDir::new().unwrap();
        write_accounts(home.path(), r#"{"active":"home@x.dev"}"#);
        let inherited = OsString::from_vec(vec![b'/', 0xff, b'x']);

        let identity = gemini_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            Some(inherited),
        );

        assert_eq!(identity.email.as_deref(), Some("home@x.dev"));
    }

    #[test]
    fn gemini_identity_of_an_added_dir_ignores_the_inherited_gemini_cli_home() {
        let dir = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_accounts(dir.path(), r#"{"active":"acme@x.dev"}"#);
        write_accounts(inherited.path(), r#"{"active":"inherited@x.dev"}"#);

        let identity = gemini_identity(AccountHome::Dir(dir.path()), Some(inherited.path().into()));

        assert_eq!(identity.email.as_deref(), Some("acme@x.dev"));
    }
}
