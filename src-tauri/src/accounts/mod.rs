//! Multiple accounts per harness: separate CLI homes plus per-account env.

pub mod env;
pub mod identity;
pub mod paths;
pub mod secrets;

pub use secrets::Secrets;

use serde::Serialize;

/// Starts the `Err` string of an IPC command that failed with an
/// `AccountError`. The rest is the JSON `to_ipc` builds.
pub const ACCOUNT_ERROR_PREFIX: &str = "ACCOUNT_ERROR:";

/// Why an account cannot be used or changed. It crosses IPC as the `to_ipc`
/// string, and the UI turns each kind into a message with a way to fix it.
#[allow(dead_code)] // consumed by the account service
#[derive(Debug, Clone, PartialEq)]
pub enum AccountError {
    /// The account was removed, so nothing may run on it.
    Removed { account_id: String, label: String },
    /// Nobody is signed in to the account.
    SignedOut { account_id: String, label: String },
    /// No account has this id.
    Missing { account_id: String },
    /// The account belongs to a different harness than the one asking.
    WrongHarness { account_id: String },
    /// A secret env var of the account could not be read from the keychain.
    Secret {
        account_id: String,
        label: String,
        message: String,
    },
    /// A login or logout terminal is already open.
    Busy,
    /// Projects still use the account, so it cannot be removed.
    InUse {
        account_id: String,
        projects: Vec<String>,
    },
    /// The request itself is wrong, or the account cannot yield an env.
    Invalid { message: String },
}

/// The JSON after `ACCOUNT_ERROR_PREFIX`. The frontend parses it, so the field
/// names are part of the IPC contract. What an error does not have is null
/// (`projects`: empty).
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountErrorPayload<'a> {
    kind: &'static str,
    account_id: Option<&'a str>,
    label: Option<&'a str>,
    projects: &'a [String],
    message: Option<&'a str>,
}

impl AccountError {
    /// The error as the `Err` string of an IPC command: `ACCOUNT_ERROR:` and
    /// then a JSON object with `kind` (the variant name in camelCase),
    /// `accountId`, `label`, `projects` and `message`.
    #[allow(dead_code)] // consumed by the account service
    pub fn to_ipc(&self) -> String {
        let payload = match self {
            AccountError::Removed { account_id, label } => AccountErrorPayload {
                kind: "removed",
                account_id: Some(account_id),
                label: Some(label),
                ..Default::default()
            },
            AccountError::SignedOut { account_id, label } => AccountErrorPayload {
                kind: "signedOut",
                account_id: Some(account_id),
                label: Some(label),
                ..Default::default()
            },
            AccountError::Missing { account_id } => AccountErrorPayload {
                kind: "missing",
                account_id: Some(account_id),
                ..Default::default()
            },
            AccountError::WrongHarness { account_id } => AccountErrorPayload {
                kind: "wrongHarness",
                account_id: Some(account_id),
                ..Default::default()
            },
            AccountError::Secret {
                account_id,
                label,
                message,
            } => AccountErrorPayload {
                kind: "secret",
                account_id: Some(account_id),
                label: Some(label),
                message: Some(message),
                ..Default::default()
            },
            AccountError::Busy => AccountErrorPayload {
                kind: "busy",
                ..Default::default()
            },
            AccountError::InUse {
                account_id,
                projects,
            } => AccountErrorPayload {
                kind: "inUse",
                account_id: Some(account_id),
                projects,
                ..Default::default()
            },
            AccountError::Invalid { message } => AccountErrorPayload {
                kind: "invalid",
                message: Some(message),
                ..Default::default()
            },
        };
        // Strings only, so serializing cannot fail.
        let json = serde_json::to_string(&payload).unwrap_or_default();
        format!("{ACCOUNT_ERROR_PREFIX}{json}")
    }
}

/// Short messages for logs. The UI reads the `to_ipc` payload instead.
impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AccountError::Removed { label, .. } => write!(f, "Account \"{label}\" was removed"),
            AccountError::SignedOut { label, .. } => {
                write!(f, "Account \"{label}\" is signed out")
            }
            AccountError::Missing { account_id } => write!(f, "No account with id {account_id}"),
            AccountError::WrongHarness { account_id } => {
                write!(f, "Account {account_id} belongs to a different agent")
            }
            AccountError::Secret { label, message, .. } => {
                write!(
                    f,
                    "Couldn't read a secret for account \"{label}\": {message}"
                )
            }
            AccountError::Busy => f.write_str("Another account login is already open"),
            AccountError::InUse {
                account_id,
                projects,
            } => write!(
                f,
                "Account {account_id} is still used by {}",
                projects.join(", ")
            ),
            AccountError::Invalid { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for AccountError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// The JSON an error carries across IPC, after checking the prefix.
    fn payload(error: &AccountError) -> Value {
        let ipc = error.to_ipc();
        let json = ipc
            .strip_prefix(ACCOUNT_ERROR_PREFIX)
            .unwrap_or_else(|| panic!("no prefix: {ipc}"));
        serde_json::from_str(json).unwrap_or_else(|e| panic!("not JSON ({e}): {json}"))
    }

    #[test]
    fn account_error_to_ipc_is_prefixed_json() {
        let error = AccountError::SignedOut {
            account_id: "a1".into(),
            label: "Acme".into(),
        };
        // The frontend splits on this literal, so it is spelled out here.
        assert!(error.to_ipc().starts_with("ACCOUNT_ERROR:"));
        assert_eq!(
            payload(&error),
            json!({
                "kind": "signedOut",
                "accountId": "a1",
                "label": "Acme",
                "projects": [],
                "message": null,
            })
        );
    }

    #[test]
    fn every_account_error_carries_its_own_fields() {
        let cases = [
            (
                AccountError::Removed {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                },
                json!({"kind": "removed", "accountId": "a1", "label": "Acme", "projects": [], "message": null}),
            ),
            (
                AccountError::SignedOut {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                },
                json!({"kind": "signedOut", "accountId": "a1", "label": "Acme", "projects": [], "message": null}),
            ),
            (
                AccountError::Missing {
                    account_id: "a1".into(),
                },
                json!({"kind": "missing", "accountId": "a1", "label": null, "projects": [], "message": null}),
            ),
            (
                AccountError::WrongHarness {
                    account_id: "a1".into(),
                },
                json!({"kind": "wrongHarness", "accountId": "a1", "label": null, "projects": [], "message": null}),
            ),
            (
                AccountError::Secret {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                    message: "ANTHROPIC_API_KEY has no stored value".into(),
                },
                json!({"kind": "secret", "accountId": "a1", "label": "Acme", "projects": [], "message": "ANTHROPIC_API_KEY has no stored value"}),
            ),
            (
                AccountError::Busy,
                json!({"kind": "busy", "accountId": null, "label": null, "projects": [], "message": null}),
            ),
            (
                AccountError::InUse {
                    account_id: "a1".into(),
                    projects: vec!["Web".into(), "API".into()],
                },
                json!({"kind": "inUse", "accountId": "a1", "label": null, "projects": ["Web", "API"], "message": null}),
            ),
            (
                AccountError::Invalid {
                    message: "Choose a folder path.".into(),
                },
                json!({"kind": "invalid", "accountId": null, "label": null, "projects": [], "message": "Choose a folder path."}),
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(payload(&error), expected, "error: {error:?}");
        }
    }

    #[test]
    fn account_errors_read_as_plain_english_in_logs() {
        let copy = [
            (
                AccountError::Removed {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                },
                r#"Account "Acme" was removed"#,
            ),
            (
                AccountError::SignedOut {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                },
                r#"Account "Acme" is signed out"#,
            ),
            (
                AccountError::Missing {
                    account_id: "a1".into(),
                },
                "No account with id a1",
            ),
            (
                AccountError::WrongHarness {
                    account_id: "a1".into(),
                },
                "Account a1 belongs to a different agent",
            ),
            (
                AccountError::Secret {
                    account_id: "a1".into(),
                    label: "Acme".into(),
                    message: "ANTHROPIC_API_KEY has no stored value".into(),
                },
                r#"Couldn't read a secret for account "Acme": ANTHROPIC_API_KEY has no stored value"#,
            ),
            (AccountError::Busy, "Another account login is already open"),
            (
                AccountError::InUse {
                    account_id: "a1".into(),
                    projects: vec!["Web".into(), "API".into()],
                },
                "Account a1 is still used by Web, API",
            ),
            (
                AccountError::Invalid {
                    message: "Choose a folder path.".into(),
                },
                "Choose a folder path.",
            ),
        ];
        for (error, message) in copy {
            assert_eq!(error.to_string(), message);
            // UI copy and logs use plain hyphens, never dashes.
            assert!(
                !message.contains(['\u{2013}', '\u{2014}']),
                "dash: {message}"
            );
        }
    }
}
