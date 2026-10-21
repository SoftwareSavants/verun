//! Multiple accounts per harness: separate CLI homes plus per-account env.

pub mod env;
pub mod identity;
pub mod manage;
pub mod paths;
pub mod secrets;
pub mod service;

pub use secrets::Secrets;

use crate::agent::AgentKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Starts the `Err` string of an IPC command that failed with an
/// `AccountError`. The rest is the JSON `to_ipc` builds.
pub const ACCOUNT_ERROR_PREFIX: &str = "ACCOUNT_ERROR:";

/// What the user chose for a new session's account. The frontend sends this
/// (or nothing) with `create_task` and `create_session`; the JSON shape is the
/// `AccountSelection` union in `src/types/index.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccountSelection {
    /// The project's account for the session's harness. Same as no choice.
    ProjectDefault,
    /// The Default account (the user's own CLI login), whatever the project uses.
    Default,
    /// One added account.
    Account { id: String },
}

/// The account a new session is bound to: the one picked when starting it,
/// else the project's account for the harness, else Default (`None`).
/// `project_accounts` is the project's `agent_type -> account_id` bindings.
/// This only chooses. `service::resolve_new_session_account` also checks that
/// a picked account can be used.
pub fn resolve_session_account(
    selection: Option<&AccountSelection>,
    agent_type: &str,
    project_accounts: &HashMap<String, String>,
) -> Option<String> {
    match selection {
        Some(AccountSelection::Default) => None,
        Some(AccountSelection::Account { id }) => Some(id.clone()),
        Some(AccountSelection::ProjectDefault) | None => project_accounts.get(agent_type).cloned(),
    }
}

/// The Claude login that may name a session and its task. Naming sends the
/// user's first message to Claude's API, whatever harness the session runs on,
/// so it may only go to a login the session is allowed to use.
#[derive(Debug, Clone, PartialEq)]
pub enum TitleAccount {
    /// Run the Haiku call on this Claude account (`None`: the Default Claude
    /// login, the user's own).
    Use(Option<String>),
    /// No Claude login is safe for the message, so nothing is sent to one and
    /// the title is a plain one cut from the message.
    Skip,
}

/// The Claude login that names a session of `session_agent_type` which runs on
/// `session_account_id` (`None`: Default), given the project's Claude account
/// `project_claude_account_id` (`None`: Default).
///
/// - A Claude session uses its own account.
/// - A session of another harness on Default uses the project's Claude account,
///   which is Default as well when the project has none: what naming always did.
/// - A session of another harness on an added account uses the project's Claude
///   account only if that is an added account too. If it is Default, the only
///   Claude login left is the user's own, and the message of a session on an
///   added account must not reach it: `Skip`.
///
/// The project's account is not consulted for a Claude session.
pub fn title_account(
    session_agent_type: &str,
    session_account_id: Option<&str>,
    project_claude_account_id: Option<&str>,
) -> TitleAccount {
    if AgentKind::parse(session_agent_type) == AgentKind::Claude {
        return TitleAccount::Use(session_account_id.map(str::to_string));
    }
    match (session_account_id, project_claude_account_id) {
        (None, project) => TitleAccount::Use(project.map(str::to_string)),
        (Some(_), Some(project)) => TitleAccount::Use(Some(project.to_string())),
        (Some(_), None) => TitleAccount::Skip,
    }
}

/// Why an account cannot be used or changed. It crosses IPC as the `to_ipc`
/// string, and the UI turns each kind into a message with a way to fix it.
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
    #[allow(dead_code)] // constructed by the login terminal
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

    /// A project's bindings as `agent_type -> account_id`.
    fn bindings(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(agent_type, account_id)| (agent_type.to_string(), account_id.to_string()))
            .collect()
    }

    #[test]
    fn resolve_uses_project_default_when_unspecified() {
        let project = bindings(&[("claude", "a1")]);
        assert_eq!(
            resolve_session_account(None, "claude", &project),
            Some("a1".to_string())
        );
        assert_eq!(
            resolve_session_account(Some(&AccountSelection::ProjectDefault), "claude", &project),
            Some("a1".to_string())
        );
    }

    #[test]
    fn resolve_explicit_default_ignores_project_account() {
        let project = bindings(&[("claude", "a1")]);
        assert_eq!(
            resolve_session_account(Some(&AccountSelection::Default), "claude", &project),
            None
        );
    }

    #[test]
    fn resolve_explicit_account_wins() {
        let project = bindings(&[("claude", "a1")]);
        let picked = AccountSelection::Account { id: "a2".into() };
        assert_eq!(
            resolve_session_account(Some(&picked), "claude", &project),
            Some("a2".to_string())
        );
    }

    #[test]
    fn resolve_other_harness_binding_not_used() {
        let project = bindings(&[("claude", "a1")]);
        assert_eq!(resolve_session_account(None, "codex", &project), None);
        assert_eq!(
            resolve_session_account(Some(&AccountSelection::ProjectDefault), "codex", &project),
            None
        );
    }

    fn use_account(id: &str) -> TitleAccount {
        TitleAccount::Use(Some(id.to_string()))
    }

    /// The harnesses that name their sessions through Claude's Haiku.
    const OTHER_HARNESSES: [&str; 5] = ["codex", "cursor", "gemini", "grok", "opencode"];

    #[test]
    fn title_account_claude_session_uses_its_account() {
        // Whatever Claude account the project has, a Claude session names
        // itself on the one it runs on.
        assert_eq!(
            title_account("claude", Some("a1"), Some("a2")),
            use_account("a1")
        );
        assert_eq!(title_account("claude", Some("a1"), None), use_account("a1"));
        // A Default Claude session stays on Default: the project's Claude
        // account is for the sessions of other harnesses.
        assert_eq!(
            title_account("claude", None, Some("a2")),
            TitleAccount::Use(None)
        );
        assert_eq!(title_account("claude", None, None), TitleAccount::Use(None));
    }

    #[test]
    fn title_account_default_non_claude_uses_project_claude() {
        for harness in OTHER_HARNESSES {
            // The Claude the project would run, which is Default as well when
            // the project has no Claude account: what naming did before.
            assert_eq!(
                title_account(harness, None, Some("a2")),
                use_account("a2"),
                "{harness}"
            );
            assert_eq!(
                title_account(harness, None, None),
                TitleAccount::Use(None),
                "{harness}"
            );
        }
    }

    #[test]
    fn title_account_added_non_claude_uses_added_project_claude() {
        for harness in OTHER_HARNESSES {
            assert_eq!(
                title_account(harness, Some("x1"), Some("a2")),
                use_account("a2"),
                "{harness}"
            );
        }
    }

    #[test]
    fn title_account_added_non_claude_without_added_claude_skips() {
        // The message belongs to the session's account. With no Claude account
        // of the project's to take it, the only Claude left is Default's, and
        // that must never see it.
        for harness in OTHER_HARNESSES {
            assert_eq!(
                title_account(harness, Some("x1"), None),
                TitleAccount::Skip,
                "{harness}"
            );
        }
    }

    #[test]
    fn account_selection_reads_the_shapes_the_frontend_sends() {
        // Mirrors the `AccountSelection` union in src/types/index.ts.
        let cases = [
            (
                json!({"kind": "projectDefault"}),
                AccountSelection::ProjectDefault,
            ),
            (json!({"kind": "default"}), AccountSelection::Default),
            (
                json!({"kind": "account", "id": "a1"}),
                AccountSelection::Account { id: "a1".into() },
            ),
        ];
        for (input, expected) in cases {
            let parsed: AccountSelection = serde_json::from_value(input.clone())
                .unwrap_or_else(|e| panic!("not an AccountSelection ({e}): {input}"));
            assert_eq!(parsed, expected, "input: {input}");
        }
    }
}
