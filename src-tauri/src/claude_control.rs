//! Claude Code control-protocol pieces beyond plain tool approval: the extra
//! fields the CLI attaches to `can_use_tool`, MCP elicitations, and MCP
//! server status. All pure so the wire shapes can be unit tested.

use crate::policy::{PolicyDecision, PolicyResult};
use crate::task::ApprovalResponse;
use serde::Serialize;
use serde_json::{json, Value};

/// Pseudo tool name for an MCP elicitation routed through the approval queue.
pub const ELICITATION_TOOL_NAME: &str = "McpElicitation";

/// Extra presentation fields the CLI sends with `can_use_tool`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    /// The card itself is how the user responds; never auto-approve it.
    pub requires_user_interaction: bool,
    /// The safe default is Deny; Enter must not approve.
    pub default_to_no: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_server: Option<String>,
}

/// Read the presentation fields off a `can_use_tool` request. `None` when the
/// CLI sent none of them, so plain approvals stay unchanged on the wire.
pub fn parse_approval_prompt(request: &Value) -> Option<ApprovalPrompt> {
    let flag = |k: &str| request.get(k).and_then(Value::as_bool).unwrap_or(false);
    let text = |k: &str| {
        request
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let prompt = ApprovalPrompt {
        requires_user_interaction: flag("requires_user_interaction"),
        default_to_no: flag("default_to_no"),
        title: text("title"),
        display_name: text("display_name"),
        description: text("description"),
        mcp_server: text("mcp_server"),
    };
    (prompt != ApprovalPrompt::default()).then_some(prompt)
}

/// The CLI marks some tools as needing a person; they must reach the user
/// even when the trust level would auto-allow.
pub fn apply_prompt_policy(result: PolicyResult, prompt: Option<&ApprovalPrompt>) -> PolicyResult {
    if prompt.is_some_and(|p| p.requires_user_interaction) {
        return PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: "tool requires user interaction".into(),
        };
    }
    result
}

/// The mode to switch a process to before answering a `can_use_tool` with
/// `behavior`: the tier's `base_mode` when a plan is approved, else none.
///
/// Approving ExitPlanMode alone leaves Plan for the mode the session was in
/// before it, or the default mode for a session started in Plan. A
/// `set_permission_mode` sent first decides it instead, and unlike a
/// `setMode` in the answer it is refused when auto mode isn't available.
pub fn plan_exit_mode<'a>(tool_name: &str, behavior: &str, base_mode: &'a str) -> Option<&'a str> {
    (tool_name == "ExitPlanMode" && behavior == "allow").then_some(base_mode)
}

/// The permission mode a `system/init` message reports the turn starts in.
/// Each turn starts with one. (`system/status` reports changes too, but can
/// arrive after a later change, so it isn't read.)
pub fn init_permission_mode(v: &Value) -> Option<&str> {
    if v.get("type").and_then(Value::as_str) != Some("system")
        || v.get("subtype").and_then(Value::as_str) != Some("init")
    {
        return None;
    }
    v.get("permissionMode").and_then(Value::as_str)
}

/// Whether a session whose tier runs in `base_mode` reports another mode
/// because auto mode isn't available: Claude then starts in the default mode
/// without saying why. Plan is asked for on its own, so it doesn't count.
pub fn auto_mode_fell_back(base_mode: &str, reported_mode: &str) -> bool {
    base_mode == "auto" && reported_mode != "auto" && reported_mode != "plan"
}

/// Watches one Claude process's stream for auto mode it didn't get.
#[derive(Debug, Default)]
pub struct AutoModeWatch {
    reported: bool,
}

impl AutoModeWatch {
    /// The mode `v` reports instead of auto, the first time it does.
    pub fn observe(&mut self, v: &Value, base_mode: &str) -> Option<String> {
        if self.reported {
            return None;
        }
        let mode = init_permission_mode(v)?;
        if !auto_mode_fell_back(base_mode, mode) {
            return None;
        }
        self.reported = true;
        Some(mode.to_string())
    }
}

pub fn is_elicitation(request: &Value) -> bool {
    request.get("subtype").and_then(Value::as_str) == Some("elicitation")
}

/// The elicitation request minus its `subtype`, used as the approval's
/// `tool_input` so the frontend can render the form or link.
pub fn elicitation_tool_input(request: &Value) -> Value {
    let mut input = request.clone();
    if let Some(obj) = input.as_object_mut() {
        obj.remove("subtype");
    }
    input
}

/// Map the user's answer to the CLI's elicitation response. `None` means the
/// card went away unanswered (turn stopped, session closed).
pub fn encode_elicitation_response(response: Option<&ApprovalResponse>) -> Value {
    match response.map(|r| r.behavior.as_str()) {
        Some("allow") => match response.and_then(|r| r.updated_input.clone()) {
            Some(content) => json!({ "action": "accept", "content": content }),
            None => json!({ "action": "accept" }),
        },
        Some("deny") => json!({ "action": "decline" }),
        _ => json!({ "action": "cancel" }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    /// `connected` | `failed` | `needs-auth` | `pending` | `disabled`
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Servers listed in `system/init` (`mcp_servers`) or an `mcp_status`
/// response (`mcpServers`). `None` when the value carries neither.
pub fn parse_mcp_servers(v: &Value) -> Option<Vec<McpServerStatus>> {
    let list = v
        .get("mcp_servers")
        .or_else(|| v.get("mcpServers"))?
        .as_array()?;
    Some(
        list.iter()
            .filter_map(|s| {
                Some(McpServerStatus {
                    name: s.get("name")?.as_str()?.to_string(),
                    status: s.get("status")?.as_str()?.to_string(),
                    error: s.get("error").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect(),
    )
}

/// The URL to open from an `mcp_authenticate` response, if any.
pub fn mcp_auth_url(response: &Value) -> Option<String> {
    response
        .get("authUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow() -> PolicyResult {
        PolicyResult {
            decision: PolicyDecision::AutoAllow,
            reason: "trust level is full_auto".into(),
        }
    }

    #[test]
    fn plain_can_use_tool_has_no_prompt() {
        let req = json!({"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t"});
        assert_eq!(parse_approval_prompt(&req), None);
    }

    #[test]
    fn parses_prompt_fields() {
        let req = json!({
            "subtype":"can_use_tool","tool_name":"mcp__x__pick","input":{},"tool_use_id":"t",
            "requires_user_interaction":true,"default_to_no":true,"suppress_always_allow_rule":true,
            "title":"Pick a file","display_name":"Picker","description":"Choose one","mcp_server":"x"
        });
        assert_eq!(
            parse_approval_prompt(&req),
            Some(ApprovalPrompt {
                requires_user_interaction: true,
                default_to_no: true,
                title: Some("Pick a file".into()),
                display_name: Some("Picker".into()),
                description: Some("Choose one".into()),
                mcp_server: Some("x".into()),
            })
        );
    }

    #[test]
    fn requires_user_interaction_overrides_auto_allow() {
        let prompt = ApprovalPrompt {
            requires_user_interaction: true,
            ..Default::default()
        };
        let r = apply_prompt_policy(allow(), Some(&prompt));
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn prompt_without_interaction_keeps_policy() {
        let prompt = ApprovalPrompt {
            title: Some("t".into()),
            ..Default::default()
        };
        assert_eq!(
            apply_prompt_policy(allow(), Some(&prompt)).decision,
            PolicyDecision::AutoAllow
        );
        assert_eq!(
            apply_prompt_policy(allow(), None).decision,
            PolicyDecision::AutoAllow
        );
    }

    #[test]
    fn approving_a_plan_leaves_plan_for_the_tiers_base_mode() {
        // Left alone, a session started in Plan lands in the default mode and
        // asks for every edit of the plan it was just told to carry out.
        assert_eq!(plan_exit_mode("ExitPlanMode", "allow", "auto"), Some("auto"));
        assert_eq!(plan_exit_mode("ExitPlanMode", "allow", "default"), Some("default"));
        // Asking for changes keeps planning.
        assert_eq!(plan_exit_mode("ExitPlanMode", "deny", "auto"), None);
        assert_eq!(plan_exit_mode("Bash", "allow", "auto"), None);
    }

    #[test]
    fn reads_the_permission_mode_from_init() {
        let init = json!({"type":"system","subtype":"init","session_id":"s","permissionMode":"default"});
        assert_eq!(init_permission_mode(&init), Some("default"));
        // A status message reports mode changes late; only init is read.
        let status = json!({"type":"system","subtype":"status","permissionMode":"default"});
        assert_eq!(init_permission_mode(&status), None);
        assert_eq!(
            init_permission_mode(&json!({"type":"system","subtype":"init"})),
            None
        );
    }

    #[test]
    fn auto_mode_fell_back_only_when_auto_was_asked_for() {
        // Auto unavailable (older model, admin turned it off): manual instead.
        assert!(auto_mode_fell_back("auto", "default"));
        // Plan is asked for on its own, and auto is what was wanted.
        assert!(!auto_mode_fell_back("auto", "plan"));
        assert!(!auto_mode_fell_back("auto", "auto"));
        // Ask and Full auto never asked for auto.
        assert!(!auto_mode_fell_back("default", "default"));
        assert!(!auto_mode_fell_back("default", "plan"));
    }

    #[test]
    fn auto_mode_watch_reports_a_fall_back_once_per_process() {
        // Every turn starts with an init that reports the mode again.
        let init = |mode: &str| json!({"type":"system","subtype":"init","permissionMode":mode});
        let mut watch = AutoModeWatch::default();
        assert_eq!(watch.observe(&init("auto"), "auto"), None);
        assert_eq!(watch.observe(&init("plan"), "auto"), None);
        assert_eq!(watch.observe(&init("default"), "auto"), Some("default".into()));
        assert_eq!(watch.observe(&init("default"), "auto"), None);

        // The Ask tier asked for the default mode and got it.
        let mut ask = AutoModeWatch::default();
        assert_eq!(ask.observe(&init("default"), "default"), None);
    }

    #[test]
    fn detects_elicitation_and_strips_subtype() {
        let req = json!({"subtype":"elicitation","mcp_server_name":"s","message":"m","mode":"url","url":"https://x"});
        assert!(is_elicitation(&req));
        assert!(!is_elicitation(&json!({"subtype":"can_use_tool"})));
        let input = elicitation_tool_input(&req);
        assert!(input.get("subtype").is_none());
        assert_eq!(input["mcp_server_name"], "s");
        assert_eq!(input["url"], "https://x");
    }

    fn resp(behavior: &str, input: Option<Value>) -> ApprovalResponse {
        ApprovalResponse {
            behavior: behavior.into(),
            updated_input: input,
            message: None,
        }
    }

    #[test]
    fn elicitation_response_mapping() {
        let content = json!({"name":"a","count":2});
        assert_eq!(
            encode_elicitation_response(Some(&resp("allow", Some(content.clone())))),
            json!({"action":"accept","content":content})
        );
        assert_eq!(
            encode_elicitation_response(Some(&resp("allow", None))),
            json!({"action":"accept"})
        );
        assert_eq!(
            encode_elicitation_response(Some(&resp("deny", None))),
            json!({"action":"decline"})
        );
        assert_eq!(
            encode_elicitation_response(Some(&resp("cancel", None))),
            json!({"action":"cancel"})
        );
        assert_eq!(
            encode_elicitation_response(None),
            json!({"action":"cancel"})
        );
    }

    #[test]
    fn parses_mcp_servers_from_init_and_status() {
        let init = json!({"type":"system","subtype":"init","mcp_servers":[
            {"name":"github","status":"connected"},
            {"name":"linear","status":"needs-auth"},
            {"name":"broken","status":"failed","error":"spawn ENOENT"}
        ]});
        let servers = parse_mcp_servers(&init).unwrap();
        assert_eq!(servers.len(), 3);
        assert_eq!(servers[1].status, "needs-auth");
        assert_eq!(servers[2].error.as_deref(), Some("spawn ENOENT"));

        let status =
            json!({"mcpServers":[{"name":"github","status":"connected","config":{"secret":"x"}}]});
        assert_eq!(
            parse_mcp_servers(&status).unwrap(),
            vec![McpServerStatus {
                name: "github".into(),
                status: "connected".into(),
                error: None
            }]
        );
        assert_eq!(
            parse_mcp_servers(&json!({"type":"system","subtype":"init"})),
            None
        );
    }

    #[test]
    fn reads_auth_url() {
        assert_eq!(
            mcp_auth_url(&json!({"authUrl":"https://auth","requiresUserAction":true})).as_deref(),
            Some("https://auth")
        );
        assert_eq!(mcp_auth_url(&json!({"requiresUserAction":false})), None);
    }
}
