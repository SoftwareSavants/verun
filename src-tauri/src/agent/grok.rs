use super::{Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use serde_json::{json, Value};

/// Serialize a JSON value into a single newline-delimited JSON-RPC frame.
fn frame(v: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(v).map_err(|e| format!("serialize acp frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

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

    // ── ACP RPC seam ────────────────────────────────────────────────────

    fn rpc_encode_initialize(
        &self,
        req_id: i64,
        ci: &super::RpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // Advertise NO `fs` client capability: Grok then does its own file
        // I/O rather than routing reads/writes back through us.
        frame(&json!({
            "id": req_id,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": { "name": ci.name, "version": ci.version },
                "clientCapabilities": {}
            }
        }))
    }

    fn rpc_encode_start(&self, req_id: i64, p: &super::RpcStartParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/new",
            "params": { "cwd": p.cwd, "mcpServers": [] }
        }))
    }

    fn rpc_encode_resume(&self, req_id: i64, p: &super::RpcResumeParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/load",
            "params": { "sessionId": p.session_id, "cwd": p.cwd, "mcpServers": [] }
        }))
    }

    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/prompt",
            "params": {
                "sessionId": p.session_id,
                "prompt": [{ "type": "text", "text": p.prompt }]
            }
        }))
    }

    fn rpc_encode_interrupt(
        &self,
        req_id: i64,
        session_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // ACP cancels by session id; no per-turn id needed.
        frame(&json!({
            "id": req_id,
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }))
        .map(Some)
    }

    fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
        let m = message.to_lowercase();
        m.contains("session")
            && (m.contains("not found")
                || m.contains("does not exist")
                || m.contains("unknown")
                || m.contains("no such"))
    }
}
