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
    SignedOut,
    /// No login of its own, but the account's env supplies an API key.
    ApiKey,
    /// Nothing on disk says either way.
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
#[allow(dead_code)] // consumed by the account service
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

    fn with_status(status: SignInStatus) -> AccountIdentity {
        AccountIdentity {
            status,
            ..AccountIdentity::default()
        }
    }

    #[test]
    fn api_key_overlay_marks_signed_out_account_with_key() {
        let profile = profile_with(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], None);
        let env = [secret_env("ANTHROPIC_AUTH_TOKEN")];
        for status in [SignInStatus::SignedOut, SignInStatus::Unknown] {
            let identity = with_api_key_overlay(with_status(status), &profile, &env);
            assert_eq!(identity.status, SignInStatus::ApiKey, "from {status:?}");
        }
    }

    #[test]
    fn api_key_overlay_marks_account_with_required_secret() {
        let profile = profile_with(&[], Some("CURSOR_API_KEY"));
        let env = [secret_env("CURSOR_API_KEY")];
        let identity = with_api_key_overlay(with_status(SignInStatus::Unknown), &profile, &env);
        assert_eq!(identity.status, SignInStatus::ApiKey);
    }

    #[test]
    fn api_key_overlay_changes_nothing_without_a_key_or_with_a_login() {
        let profile = profile_with(&["ANTHROPIC_API_KEY"], None);
        let other_env = [secret_env("ANTHROPIC_BASE_URL")];
        let key_env = [secret_env("ANTHROPIC_API_KEY")];
        // No key in the env: still signed out, however much other env there is.
        for env in [&[][..], &other_env[..]] {
            let identity =
                with_api_key_overlay(with_status(SignInStatus::SignedOut), &profile, env);
            assert_eq!(identity, with_status(SignInStatus::SignedOut));
        }
        // A login the CLI really has is not replaced by a key.
        let signed_in = with_status(SignInStatus::SignedIn);
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
}
