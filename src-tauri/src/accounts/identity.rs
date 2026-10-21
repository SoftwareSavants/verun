//! Who a harness is signed in as, read from the files its CLI keeps on disk.
//!
//! Nothing here spawns a process or touches a credential: an identity is the
//! email, org and plan the CLI itself wrote next to its tokens. Every reader
//! does blocking file I/O, so async callers go through `spawn_blocking`.

use crate::agent::AccountProfile;
use crate::db::AccountEnvVar;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

/// Whether an account has a login the CLI can use.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SignInStatus {
    SignedIn,
    /// Nobody is signed in: logged out, or never logged in. A session on a
    /// signed-out account is refused, so a reader says this only when the
    /// files show it.
    SignedOut,
    /// No login of its own, but the account's env supplies an API key.
    ApiKey,
    /// Nothing on disk says either way: a file that cannot be read, or that
    /// is not shaped the way the CLI writes it. It never blocks an account, so
    /// a reader reports it instead of guessing `SignedOut`.
    #[default]
    Unknown,
}

/// What the CLI's files say about the account. Harnesses differ in what they
/// record, so everything but the status is optional.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub status: SignInStatus,
    pub email: Option<String>,
    pub org_name: Option<String>,
    pub plan: Option<String>,
    /// Signed-in providers, for harnesses where one login holds several
    /// (OpenCode). Empty for the rest.
    pub providers: Vec<String>,
}

impl AccountIdentity {
    /// An identity that knows only the sign-in status.
    pub fn with_status(status: SignInStatus) -> Self {
        Self {
            status,
            ..Self::default()
        }
    }
}

/// How many times a JSON file is read before its parse error is believed, and
/// the pause between those reads.
const JSON_READ_ATTEMPTS: u32 = 3;
const JSON_READ_RETRY_DELAY: Duration = Duration::from_millis(50);

/// The claims of a JWT: its middle segment, base64url without padding, as a
/// JSON object. The signature is not checked, because the token is only read
/// from the CLI's own file to learn who is signed in, never to authorize
/// anything.
#[allow(dead_code)] // consumed by the Codex and Grok identity readers
pub fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let segments: Vec<&str> = token.split('.').collect();
    let [_header, payload, _signature] = segments[..] else {
        return None;
    };
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes)
        .ok()
        .filter(serde_json::Value::is_object)
}

/// Reads a JSON file, or `None` when it is missing, unreadable or not JSON.
///
/// A CLI may rewrite its file in place (Codex truncates and writes
/// `auth.json` without a rename), so a read can catch half a file. A parse
/// error is therefore read again, up to 3 reads 50 ms apart, before it is
/// believed. A file that cannot be read at all is not retried. Blocks the
/// thread, so async callers go through `spawn_blocking`.
pub fn read_json_with_retry(path: &Path) -> Option<serde_json::Value> {
    read_json_retrying(path, JSON_READ_ATTEMPTS, || {
        std::thread::sleep(JSON_READ_RETRY_DELAY);
    })
}

/// `read_json_with_retry` with the number of reads and the pause between them
/// supplied, so tests need not sleep.
fn read_json_retrying(
    path: &Path,
    attempts: u32,
    mut wait: impl FnMut(),
) -> Option<serde_json::Value> {
    for attempt in 1..=attempts {
        // Missing or unreadable: waiting does not change that.
        let bytes = std::fs::read(path).ok()?;
        if let Ok(value) = serde_json::from_slice(&bytes) {
            return Some(value);
        }
        if attempt < attempts {
            wait();
        }
    }
    None
}

/// What to report when `read_json_with_retry` found nothing at `path`.
///
/// A file that is not there is a home nobody has signed in to: `SignedOut`. A
/// file that is there but could not be read or parsed says nothing either
/// way, so it is `Unknown`; `SignedOut` is the status that makes an account
/// refuse to run, and a file that is merely unreadable must not do that.
/// Every harness's reader goes through here, so they all decide the same way.
pub fn unread_file_identity(path: &Path) -> AccountIdentity {
    match path.try_exists() {
        Ok(false) => AccountIdentity::with_status(SignInStatus::SignedOut),
        Ok(true) => unknown_identity(path, "exists but could not be read as JSON"),
        Err(e) => unknown_identity(path, &format!("could not be checked: {e}")),
    }
}

/// `Unknown`, for a file at `path` that is there but gives no answer, with the
/// reason on stderr so it can be diagnosed. `reason` must not quote the file:
/// it may hold tokens.
pub fn unknown_identity(path: &Path, reason: &str) -> AccountIdentity {
    eprintln!("[verun][accounts] {} {reason}", path.display());
    AccountIdentity::with_status(SignInStatus::Unknown)
}

/// The string at `key` of a JSON object, when it is there and not empty.
pub fn non_empty_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// An account that is signed out, or whose sign-in is unknown, but defines an
/// API key in its env is usable, so it reports `ApiKey` instead. Only the keys
/// of `env` are consulted: a secret's value lives in the keychain, not here. A
/// real login (`SignedIn`) is left as it is.
pub fn with_api_key_overlay(
    identity: AccountIdentity,
    profile: &AccountProfile,
    env: &[AccountEnvVar],
) -> AccountIdentity {
    let without_login = matches!(
        identity.status,
        SignInStatus::SignedOut | SignInStatus::Unknown
    );
    let holds_key = env.iter().any(|var| {
        profile.api_key_vars.contains(&var.key.as_str())
            || profile.required_secret == Some(var.key.as_str())
    });
    if without_login && holds_key {
        return AccountIdentity {
            status: SignInStatus::ApiKey,
            ..identity
        };
    }
    identity
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;
    use tempfile::TempDir;

    fn jwt(payload: &str) -> String {
        format!(
            "eyJhbGciOiJub25lIn0.{}.c2ln",
            URL_SAFE_NO_PAD.encode(payload)
        )
    }

    #[test]
    fn decode_jwt_payload_reads_middle_segment() {
        let payload = decode_jwt_payload(&jwt(r#"{"email":"a@b.c"}"#)).unwrap();
        assert_eq!(payload["email"], "a@b.c");
    }

    #[test]
    fn decode_jwt_payload_reads_url_safe_segments_without_padding() {
        // `???` and `>>>` encode to `/` and `+` in the standard alphabet, which
        // base64url spells `_` and `-`, and 14 bytes of JSON need a trailing `=`.
        let payload = r#"{"x":"???>>>"}"#;
        let standard = STANDARD.encode(payload);
        assert!(standard.contains('/') && standard.contains('+') && standard.ends_with('='));
        let segment = URL_SAFE_NO_PAD.encode(payload);
        assert!(segment.contains('_') && segment.contains('-') && !segment.contains('='));
        assert_eq!(decode_jwt_payload(&jwt(payload)).unwrap()["x"], "???>>>");
    }

    #[test]
    fn decode_jwt_payload_rejects_garbage() {
        let not_json = jwt("not json");
        let array = jwt("[1,2]");
        let number = jwt("42");
        for token in [
            "",
            "garbage",
            // Not three segments.
            "a.b",
            "a.b.c.d",
            // Middle segment is not base64url without padding.
            "a.!!!.c",
            "a.eyJhIjoxfQ==.c",
            // Decodes, but is not JSON.
            not_json.as_str(),
            // JSON, but not a claims object.
            array.as_str(),
            number.as_str(),
        ] {
            assert_eq!(decode_jwt_payload(token), None, "token: {token}");
        }
    }

    fn profile_with(
        api_key_vars: &'static [&'static str],
        required_secret: Option<&'static str>,
    ) -> AccountProfile {
        AccountProfile {
            scrub_vars: &[],
            fixed_env: &[],
            api_key_vars,
            login_args: None,
            logout_args: None,
            login_hint: None,
            logout_hint: None,
            allows_existing_dir: false,
            required_secret,
            in_project_env: false,
            min_cli_version: None,
        }
    }

    fn secret_env(key: &str) -> AccountEnvVar {
        AccountEnvVar {
            key: key.into(),
            value: None,
            secret: true,
        }
    }

    #[test]
    fn api_key_overlay_marks_signed_out_account_with_key() {
        let profile = profile_with(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], None);
        let env = [secret_env("ANTHROPIC_AUTH_TOKEN")];
        for status in [SignInStatus::SignedOut, SignInStatus::Unknown] {
            let identity =
                with_api_key_overlay(AccountIdentity::with_status(status), &profile, &env);
            assert_eq!(identity.status, SignInStatus::ApiKey, "from {status:?}");
        }
    }

    #[test]
    fn api_key_overlay_marks_account_with_required_secret() {
        let profile = profile_with(&[], Some("CURSOR_API_KEY"));
        let env = [secret_env("CURSOR_API_KEY")];
        let identity = with_api_key_overlay(
            AccountIdentity::with_status(SignInStatus::Unknown),
            &profile,
            &env,
        );
        assert_eq!(identity.status, SignInStatus::ApiKey);
    }

    #[test]
    fn api_key_overlay_changes_nothing_without_a_key_or_with_a_login() {
        let profile = profile_with(&["ANTHROPIC_API_KEY"], None);
        let other_env = [secret_env("ANTHROPIC_BASE_URL")];
        let key_env = [secret_env("ANTHROPIC_API_KEY")];
        // No key in the env: still signed out, however much other env there is.
        for env in [&[][..], &other_env[..]] {
            let identity = with_api_key_overlay(
                AccountIdentity::with_status(SignInStatus::SignedOut),
                &profile,
                env,
            );
            assert_eq!(
                identity,
                AccountIdentity::with_status(SignInStatus::SignedOut)
            );
        }
        // A login the CLI really has is not replaced by a key.
        let signed_in = AccountIdentity::with_status(SignInStatus::SignedIn);
        assert_eq!(
            with_api_key_overlay(signed_in.clone(), &profile, &key_env),
            signed_in
        );
    }

    #[test]
    fn api_key_overlay_keeps_the_rest_of_the_identity() {
        // Cursor can record an email in API-key mode, with no sign-in status.
        let identity = AccountIdentity {
            status: SignInStatus::Unknown,
            email: Some("dev@acme.com".into()),
            ..AccountIdentity::default()
        };
        let overlaid = with_api_key_overlay(
            identity,
            &profile_with(&["CURSOR_API_KEY"], Some("CURSOR_API_KEY")),
            &[secret_env("CURSOR_API_KEY")],
        );
        assert_eq!(overlaid.status, SignInStatus::ApiKey);
        assert_eq!(overlaid.email.as_deref(), Some("dev@acme.com"));
    }

    #[test]
    fn identity_serializes_as_camel_case_for_the_frontend() {
        let identity = AccountIdentity {
            status: SignInStatus::SignedIn,
            email: Some("dev@acme.com".into()),
            org_name: Some("Acme".into()),
            plan: Some("Max".into()),
            providers: vec!["openai".into()],
        };
        assert_eq!(
            serde_json::to_value(&identity).unwrap(),
            json!({
                "status": "signedIn",
                "email": "dev@acme.com",
                "orgName": "Acme",
                "plan": "Max",
                "providers": ["openai"],
            })
        );
        assert_eq!(
            serde_json::to_value(AccountIdentity::default()).unwrap(),
            json!({
                "status": "unknown",
                "email": null,
                "orgName": null,
                "plan": null,
                "providers": [],
            })
        );
        for (status, name) in [
            (SignInStatus::SignedOut, "signedOut"),
            (SignInStatus::ApiKey, "apiKey"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
        }
    }

    #[test]
    fn non_empty_str_skips_missing_empty_and_non_string_values() {
        let value = json!({"a": "x", "empty": "", "n": 1, "nested": {"a": "y"}});
        assert_eq!(non_empty_str(&value, "a").as_deref(), Some("x"));
        assert_eq!(non_empty_str(&value, "empty"), None);
        assert_eq!(non_empty_str(&value, "n"), None);
        assert_eq!(non_empty_str(&value, "nested"), None);
        assert_eq!(non_empty_str(&value, "missing"), None);
        // A value that is not an object has no keys.
        assert_eq!(non_empty_str(&json!("a"), "a"), None);
    }

    #[test]
    fn read_json_with_retry_missing_is_none() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(read_json_with_retry(&tmp.path().join("missing.json")), None);
    }

    #[test]
    fn read_json_with_retry_reads_a_valid_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("auth.json");
        std::fs::write(&path, r#"{"auth_mode":"chatgpt"}"#).unwrap();
        assert_eq!(
            read_json_with_retry(&path),
            Some(json!({"auth_mode": "chatgpt"}))
        );
    }

    #[test]
    fn read_json_does_not_retry_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        let mut waits = 0;
        let value = read_json_retrying(&tmp.path().join("missing.json"), 3, || waits += 1);
        assert_eq!(value, None);
        assert_eq!(waits, 0);
    }

    #[test]
    fn read_json_retries_a_file_caught_mid_rewrite() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("auth.json");
        // Half a file, as a reader sees an in-place rewrite that is under way.
        std::fs::write(&path, r#"{"auth_mode":"#).unwrap();
        let mut waits = 0;
        let value = read_json_retrying(&path, 3, || {
            waits += 1;
            // The writer finishes while the reader waits.
            std::fs::write(&path, r#"{"auth_mode":"chatgpt"}"#).unwrap();
        });
        assert_eq!(value, Some(json!({"auth_mode": "chatgpt"})));
        assert_eq!(waits, 1);
    }

    #[test]
    fn read_json_gives_up_after_the_last_attempt() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("auth.json");
        // An empty file is what a truncating rewrite leaves for a moment.
        std::fs::write(&path, "").unwrap();
        let mut waits = 0;
        assert_eq!(read_json_retrying(&path, 3, || waits += 1), None);
        // Three reads, so two pauses: none after the last one.
        assert_eq!(waits, 2);
    }

    #[test]
    fn unread_file_identity_is_signed_out_for_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(
            unread_file_identity(&tmp.path().join("auth.json")),
            AccountIdentity::with_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn unread_file_identity_is_unknown_for_a_file_that_is_there() {
        // The caller got nothing from a file that exists, so it could not
        // be read or parsed. That says nothing about a login, and a guess of
        // "signed out" would make the account refuse to run.
        let tmp = TempDir::new().unwrap();
        let corrupt = tmp.path().join("corrupt.json");
        std::fs::write(&corrupt, "{").unwrap();
        let folder = tmp.path().join("folder.json");
        std::fs::create_dir(&folder).unwrap();
        for path in [corrupt, folder] {
            assert_eq!(
                unread_file_identity(&path),
                AccountIdentity::with_status(SignInStatus::Unknown),
                "path: {path:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unread_file_identity_counts_a_dangling_symlink_as_missing() {
        let tmp = TempDir::new().unwrap();
        let link = tmp.path().join("auth.json");
        std::os::unix::fs::symlink(tmp.path().join("gone.json"), &link).unwrap();
        assert_eq!(
            unread_file_identity(&link),
            AccountIdentity::with_status(SignInStatus::SignedOut)
        );
    }

    #[cfg(unix)]
    #[test]
    fn unread_file_identity_is_unknown_when_existence_cannot_be_checked() {
        use std::os::unix::fs::PermissionsExt;

        // Puts the permissions back so the temp dir can be removed, even when
        // the assertion fails.
        struct Unlock(std::path::PathBuf);
        impl Drop for Unlock {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }

        let tmp = TempDir::new().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        let file = locked.join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let _unlock = Unlock(locked);

        // A folder nobody may search hides even whether the file is there.
        // root ignores the permission bits, and then there is nothing to test.
        if file.try_exists().is_ok() {
            return;
        }
        assert_eq!(
            unread_file_identity(&file),
            AccountIdentity::with_status(SignInStatus::Unknown)
        );
    }

    #[test]
    fn unknown_identity_is_unknown_and_carries_nothing_else() {
        assert_eq!(
            unknown_identity(Path::new("/x/.claude.json"), "has a shape nobody expected"),
            AccountIdentity::with_status(SignInStatus::Unknown)
        );
    }
}
