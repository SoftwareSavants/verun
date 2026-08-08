use super::{Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use serde_json::{json, Value};

/// Serialize a JSON value into a single newline-delimited JSON-RPC frame.
fn frame(v: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(v).map_err(|e| format!("serialize acp frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

/// Map an ACP `stop_reason` to Verun's turn-end status vocabulary.
fn stop_reason_to_status(sr: &str) -> &'static str {
    match sr {
        "cancelled" | "canceled" | "interrupted" => "interrupted",
        "refusal" | "error" | "max_tokens" | "max_turn_requests" => "error",
        _ => "completed",
    }
}

/// ACP reports cost as integer "usd ticks" where ticks = usd * 1e10.
fn ticks_to_usd(ticks: i64) -> f64 {
    ticks as f64 / 1e10
}

/// Render an ACP `{oldText,newText}` file change as a git-style unified diff
/// string for display. Trims common leading/trailing lines so edits show only
/// the changed region; a brand-new file (empty `old`) yields `+` lines only.
fn render_unified_diff(path: &str, old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut start = 0;
    while start < old_lines.len()
        && start < new_lines.len()
        && old_lines[start] == new_lines[start]
    {
        start += 1;
    }
    let (mut eo, mut en) = (old_lines.len(), new_lines.len());
    while eo > start && en > start && old_lines[eo - 1] == new_lines[en - 1] {
        eo -= 1;
        en -= 1;
    }
    let mut s = format!("--- a/{path}\n+++ b/{path}\n");
    for line in &old_lines[start..eo] {
        s.push('-');
        s.push_str(line);
        s.push('\n');
    }
    for line in &new_lines[start..en] {
        s.push('+');
        s.push_str(line);
        s.push('\n');
    }
    s
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

    fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
        use crate::stream::OutputItem;
        if method != "session/update" {
            return vec![];
        }
        let Some(u) = params.get("update") else {
            return vec![];
        };
        match u.get("sessionUpdate").and_then(|s| s.as_str()).unwrap_or("") {
            "agent_thought_chunk" => u
                .pointer("/content/text")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .map(|t| vec![OutputItem::Thinking { text: t.to_string() }])
                .unwrap_or_default(),
            "agent_message_chunk" => u
                .pointer("/content/text")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .map(|t| vec![OutputItem::Text { text: t.to_string() }])
                .unwrap_or_default(),
            "tool_call" => {
                let tool = u
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = u
                    .get("rawInput")
                    .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
                    .unwrap_or_default();
                vec![OutputItem::ToolStart { tool, input }]
            }
            "tool_call_update" => {
                let status = u.get("status").and_then(|s| s.as_str()).unwrap_or("");
                // Only surface a result once the call resolves. Diffs and
                // command output both land on the same tool card started by
                // the earlier `tool_call` event.
                if status != "completed" && status != "failed" {
                    return vec![];
                }
                let is_error = status == "failed";
                let mut out = Vec::new();
                if let Some(items) = u.get("content").and_then(|c| c.as_array()) {
                    for it in items {
                        match it.get("type").and_then(|t| t.as_str()) {
                            Some("diff") => {
                                let path = it.get("path").and_then(|p| p.as_str()).unwrap_or("");
                                let old = it.get("oldText").and_then(|t| t.as_str()).unwrap_or("");
                                let new = it.get("newText").and_then(|t| t.as_str()).unwrap_or("");
                                out.push(OutputItem::ToolResult {
                                    text: render_unified_diff(path, old, new),
                                    is_error,
                                });
                            }
                            Some("content") => {
                                let text = it
                                    .pointer("/content/text")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                out.push(OutputItem::ToolResult { text, is_error });
                            }
                            _ => {}
                        }
                    }
                }
                out
            }
            "turn_completed" => {
                let status =
                    stop_reason_to_status(u.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("end_turn"));
                let usage = u.get("usage");
                let read = |key: &str| {
                    usage
                        .and_then(|g| g.get(key))
                        .and_then(|v| v.as_u64())
                };
                let cost = usage
                    .and_then(|g| g.get("costUsdTicks"))
                    .and_then(|v| v.as_i64())
                    .map(ticks_to_usd)
                    .filter(|c| *c > 0.0);
                vec![OutputItem::TurnEnd {
                    status: status.to_string(),
                    cost,
                    input_tokens: read("inputTokens"),
                    output_tokens: read("outputTokens"),
                    cache_read_tokens: read("cachedReadTokens"),
                    cache_write_tokens: None,
                    error: None,
                }]
            }
            _ => vec![],
        }
    }
}
