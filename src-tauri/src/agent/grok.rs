use super::{Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use serde_json::Value;

/// xAI Grok CLI - agentic coding CLI.
///
/// Transport: `grok agent stdio` speaks ACP (Agent Client Protocol),
/// newline-delimited JSON-RPC 2.0 over stdio. One process persists across
/// turns; each turn is a `session/prompt` request. Grok does its own file
/// I/O (we advertise no client `fs` capability), surfaces tool calls, diffs,
/// and interactive permission requests.
///
/// Binary: `grok`
/// Transport: `grok agent stdio` (ACP / JSON-RPC 2.0, NDJSON on stdio)
/// Docs: https://x.ai/cli
pub struct Grok;

impl Agent for Grok {
    fn kind(&self) -> AgentKind {
        AgentKind::Grok
    }
    fn display_name(&self) -> &'static str {
        "Grok"
    }
    fn cli_binary(&self) -> &'static str {
        "grok"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::JsonRpcStdio
    }

    fn install_hint(&self) -> &'static str {
        "curl -fsSL https://x.ai/cli/install.sh | bash"
    }
    fn update_hint(&self) -> &'static str {
        "grok update"
    }
    fn docs_url(&self) -> &'static str {
        "https://x.ai/cli"
    }

    fn available_models(&self) -> Vec<ModelOption> {
        vec![ModelOption::new(
            "grok-4.5",
            "Grok 4.5",
            "xAI frontier coding model",
        )]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["agent".into(), "stdio".into()]
    }

    fn uses_rpc(&self) -> bool {
        true
    }
    fn persists_across_turns(&self) -> bool {
        true
    }
    fn abort_strategy(&self) -> super::AbortStrategy {
        super::AbortStrategy::Interrupt
    }

    fn supports_resume(&self) -> bool {
        true
    }
    fn defers_resume_id_until_turn_end(&self) -> bool {
        false
    }
    fn supports_effort(&self) -> bool {
        false
    }
    fn supports_attachments(&self) -> bool {
        false
    }
    fn supports_plan_mode(&self) -> bool {
        false
    }
    fn supports_skills(&self) -> bool {
        false
    }
    fn supports_fork(&self) -> bool {
        false
    }

    // ── ACP RPC seam (encoders in Task 10, decode in Task 11, approvals in
    // Task 12) ──────────────────────────────────────────────────────────
    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string())
    }
}
