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

    /// Static fallback, used when `grok models` is unavailable (e.g. not
    /// logged in). First entry is the default.
    fn available_models(&self) -> Vec<ModelOption> {
        vec![
            ModelOption::new("grok-4.6", "Grok 4.6", "xAI frontier coding model"),
            ModelOption::new("grok-4.5", "Grok 4.5", "Previous Grok model"),
        ]
    }

    fn model_list_args(&self) -> Option<Vec<String>> {
        Some(vec!["models".into()])
    }

    /// Parse `grok models`. Lines look like `  * grok-4.6 (default)` for the
    /// default and `  - grok-4.5` for the rest; the default is moved first
    /// since Verun treats index 0 as the default.
    fn parse_model_list(&self, output: &str) -> Vec<ModelOption> {
        let mut default: Option<ModelOption> = None;
        let mut rest = Vec::new();
        for line in output.lines() {
            let t = line.trim();
            let (is_default, body) = match t.strip_prefix('*') {
                Some(b) => (true, b),
                None => match t.strip_prefix('-') {
                    Some(b) => (false, b),
                    None => continue,
                },
            };
            let Some(id) = body.split_whitespace().next() else {
                continue;
            };
            let opt = ModelOption::new(id, id, "");
            if is_default {
                default = Some(opt);
            } else {
                rest.push(opt);
            }
        }
        let mut out = Vec::new();
        out.extend(default);
        out.extend(rest);
        out
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

    fn rpc_is_approval(&self, method: &str) -> bool {
        method == "session/request_permission"
    }

    fn rpc_build_approval_entry(
        &self,
        session_id: &str,
        request_id: &str,
        _method: &str,
        params: &Value,
    ) -> crate::task::PendingApprovalEntry {
        let tc = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let kind = tc.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let tool_name = match kind {
            "edit" => "Edit",
            "execute" => "Bash",
            "read" => "Read",
            _ => tc.get("title").and_then(|t| t.as_str()).unwrap_or("Tool"),
        }
        .to_string();
        // Stash the ACP option list so the responder can map an allow/deny
        // decision back to a concrete `optionId`.
        let tool_input = json!({
            "toolCall": tc,
            "_grokOptions": params.get("options").cloned().unwrap_or(json!([])),
        });
        crate::task::PendingApprovalEntry {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            tool_name,
            tool_input,
        }
    }

    fn rpc_encode_approval_response(
        &self,
        _method: &str,
        server_req_id: &Value,
        response: &crate::task::ApprovalResponse,
        entry_input: &Value,
    ) -> Option<Result<Vec<u8>, String>> {
        let allow = response.behavior == "allow";
        let options = entry_input.get("_grokOptions").and_then(|o| o.as_array())?;
        let want_prefix = if allow { "allow" } else { "reject" };
        // Prefer the *_once option matching the behavior; else any option whose
        // kind starts with the desired prefix.
        let once = format!("{want_prefix}_once");
        let pick = options
            .iter()
            .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some(once.as_str()))
            .or_else(|| {
                options.iter().find(|o| {
                    o.get("kind")
                        .and_then(|k| k.as_str())
                        .map(|k| k.starts_with(want_prefix))
                        .unwrap_or(false)
                })
            });
        let option_id = pick.and_then(|o| o.get("optionId")).cloned().unwrap_or(Value::Null);
        Some(frame(&json!({
            "id": server_req_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
        })))
    }
}
