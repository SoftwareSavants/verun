use super::{Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use crate::policy::TrustLevel;
use serde_json::{json, Map, Value};

/// Serialize a JSON value into a single newline-delimited JSON-RPC frame.
fn frame(v: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(v).map_err(|e| format!("serialize msp frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

/// Every MSP command carries a client-minted UUIDv7 idempotency handle.
fn command_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn request(id: Value, method: &str, params: Value) -> Result<Vec<u8>, String> {
    frame(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
}

/// MSP approval modes are selected from the host's preconfigured set.
fn trust_level_to_approval_mode(trust: TrustLevel) -> &'static str {
    match trust {
        TrustLevel::Supervised => "promptUnmatched",
        TrustLevel::Normal => "onRequest",
        TrustLevel::FullAuto => "allowAll",
    }
}

/// Map an MSP `turn/completed.terminal` to Verun's turn-end status vocabulary.
fn terminal_to_status(terminal: &str) -> &'static str {
    match terminal {
        "completed" => "completed",
        "cancelled" => "interrupted",
        _ => "error",
    }
}

/// Split a `data:<mime>;base64,<payload>` URL into an MSP image input part.
fn image_part(data_url: &str) -> Option<Value> {
    let rest = data_url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    Some(json!({ "type": "image", "mediaType": media_type, "base64Data": data }))
}

/// Tool-call `args` are the model's argument JSON verbatim; pretty-print when
/// it parses, pass through as-is otherwise.
fn pretty_args(args: &str) -> String {
    serde_json::from_str::<Value>(args)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| args.to_string())
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|s| s.as_str())
}

/// Meta Muse Code - Meta's terminal coding agent.
///
/// Transport: `muse serve` hosts sessions over stdio and speaks MSP (Muse
/// Session Protocol), newline-delimited JSON-RPC 2.0. One process persists
/// across turns; each turn is a `turn/start` command. Every command carries a
/// client-minted UUIDv7 `commandId`. Transcript items stream as
/// `item/started` / `item/delta` / `item/completed` view notifications and
/// the turn ends on `turn/completed`. Approvals arrive as `approval/request`
/// notifications and are answered with an `approval/decide` command.
///
/// Binary: `muse`
/// Protocol reference: `@muse-code/sdk` (bundled MSP types)
/// Docs: https://dev.meta.ai/docs/muse-code
pub struct Muse;

impl Agent for Muse {
    fn kind(&self) -> AgentKind {
        AgentKind::Muse
    }
    fn display_name(&self) -> &'static str {
        "Muse Code"
    }
    fn cli_binary(&self) -> &'static str {
        "muse"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::JsonRpcStdio
    }

    fn install_hint(&self) -> &'static str {
        "curl -fsSL https://dev.meta.ai/install.sh | bash"
    }
    fn docs_url(&self) -> &'static str {
        "https://dev.meta.ai/docs/muse-code"
    }

    /// First entry is the default.
    fn available_models(&self) -> Vec<ModelOption> {
        vec![
            ModelOption::new("muse-spark-1.3", "Muse Spark 1.3", "Meta's latest coding model"),
            ModelOption::new("muse-spark-1.2", "Muse Spark 1.2", "Previous Muse Spark model"),
        ]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["serve".into()]
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
    fn supports_effort(&self) -> bool {
        true
    }
    fn supports_attachments(&self) -> bool {
        true
    }

    // ── MSP RPC seam ────────────────────────────────────────────────────

    fn rpc_encode_initialize(
        &self,
        req_id: i64,
        ci: &super::RpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // Verun has no UI for `userInput/request` dialogs; ask the host to
        // withhold them so a turn never blocks on an unanswerable request.
        request(
            json!(req_id),
            "initialize",
            json!({
                "clientInfo": { "name": ci.name, "version": ci.version },
                "capabilities": { "userInputDialogs": false }
            }),
        )
    }

    fn rpc_encode_start(&self, req_id: i64, p: &super::RpcStartParams<'_>) -> Result<Vec<u8>, String> {
        let mut params = json!({
            "commandId": command_id(),
            "workspaceRoot": p.cwd,
            "approvalMode": trust_level_to_approval_mode(p.trust_level),
        });
        if let Some(m) = p.model {
            params["modelId"] = json!(m);
        }
        request(json!(req_id), "session/start", params)
    }

    fn rpc_encode_resume(&self, req_id: i64, p: &super::RpcResumeParams<'_>) -> Result<Vec<u8>, String> {
        // History is already persisted in Verun's DB — skip the replay.
        request(
            json!(req_id),
            "session/resume",
            json!({
                "commandId": command_id(),
                "sessionId": p.session_id,
                "excludeItems": true
            }),
        )
    }

    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.pointer("/session/sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string)
    }

    fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
        let mut input = vec![json!({ "type": "text", "text": p.prompt })];
        input.extend(p.image_urls.iter().filter_map(|u| image_part(u)));
        let mut params = json!({
            "commandId": command_id(),
            "sessionId": p.session_id,
            "input": input,
        });
        if let Some(e) = p.effort {
            params["reasoningEffort"] = json!(e);
        }
        request(json!(req_id), "turn/start", params)
    }

    fn rpc_parse_turn_id(&self, r: &Value) -> Option<String> {
        str_field(r, "turnId").map(str::to_string)
    }

    fn rpc_encode_interrupt(
        &self,
        req_id: i64,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // Without a turn id the host targets the current foreground turn.
        let mut params = json!({ "commandId": command_id(), "sessionId": session_id });
        if let Some(t) = turn_id {
            params["turnId"] = json!(t);
        }
        request(json!(req_id), "turn/interrupt", params).map(Some)
    }

    fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
        let m = message.to_lowercase();
        m.contains("sessionnotfound")
            || (m.contains("session")
                && (m.contains("not found") || m.contains("does not exist") || m.contains("unknown")))
    }

    fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
        use crate::stream::OutputItem;
        match method {
            // Streamed appends to an open item. An absent field means `text`
            // (agentMessage); reasoning summaries stream as `summary.<n>`.
            // Tool output also streams (`output`) but its final text lands on
            // `item/completed`, so it is ignored here.
            "item/delta" => {
                let Some(delta) = str_field(params, "delta").filter(|d| !d.is_empty()) else {
                    return vec![];
                };
                match str_field(params, "field").unwrap_or("text") {
                    "text" => vec![OutputItem::Text { text: delta.to_string() }],
                    f if f.starts_with("summary.") => {
                        vec![OutputItem::Thinking { text: delta.to_string() }]
                    }
                    _ => vec![],
                }
            }
            "item/started" => {
                let Some(item) = params.get("item") else {
                    return vec![];
                };
                match str_field(item, "kind").unwrap_or("") {
                    "toolCall" => vec![OutputItem::ToolStart {
                        tool: str_field(item, "tool").unwrap_or("tool").to_string(),
                        input: str_field(item, "args").map(pretty_args).unwrap_or_default(),
                    }],
                    "subagent" => vec![OutputItem::ToolStart {
                        tool: "Subagent".to_string(),
                        input: str_field(item, "objective").unwrap_or("").to_string(),
                    }],
                    _ => vec![],
                }
            }
            // `agentMessage` / `reasoning` already streamed via `item/delta`;
            // re-emitting the final text would duplicate it.
            "item/completed" => {
                let Some(item) = params.get("item") else {
                    return vec![];
                };
                let is_error = str_field(item, "status") != Some("completed");
                match str_field(item, "kind").unwrap_or("") {
                    "toolCall" => {
                        let text = str_field(item, "visibleOutput")
                            .filter(|s| !s.is_empty())
                            .or_else(|| str_field(item, "failureReason"))
                            .or_else(|| str_field(item, "fallbackText"))
                            .unwrap_or("")
                            .to_string();
                        vec![OutputItem::ToolResult { text, is_error }]
                    }
                    "subagent" => {
                        let text = item
                            .pointer("/result/summary")
                            .and_then(|s| s.as_str())
                            .or_else(|| str_field(item, "failureReason"))
                            .or_else(|| str_field(item, "fallbackText"))
                            .unwrap_or("")
                            .to_string();
                        vec![OutputItem::ToolResult { text, is_error }]
                    }
                    _ => vec![],
                }
            }
            "turn/completed" => {
                let status = terminal_to_status(str_field(params, "terminal").unwrap_or("completed"));
                let usage = params.get("usage");
                let read = |key: &str| usage.and_then(|u| u.get(key)).and_then(|v| v.as_u64());
                let error = params
                    .pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        (status == "error")
                            .then(|| str_field(params, "reason"))
                            .flatten()
                    })
                    .map(str::to_string);
                vec![OutputItem::TurnEnd {
                    status: status.to_string(),
                    cost: None,
                    input_tokens: read("inputTokens"),
                    output_tokens: read("outputTokens"),
                    cache_read_tokens: read("cacheReadTokens").or_else(|| read("cachedTokens")),
                    cache_write_tokens: read("cacheWriteTokens"),
                    error,
                }]
            }
            _ => vec![],
        }
    }

    /// MSP delivers approvals as view notifications (no JSON-RPC id); the
    /// stream loop promotes them via `rpc::promote_approval_notification`.
    fn rpc_is_approval(&self, method: &str) -> bool {
        method == "approval/request"
    }

    fn rpc_build_approval_entry(
        &self,
        session_id: &str,
        request_id: &str,
        _method: &str,
        params: &Value,
    ) -> crate::task::PendingApprovalEntry {
        let subject = params.get("subject").cloned().unwrap_or(Value::Null);
        let tool = str_field(params, "toolName").unwrap_or("Tool");
        let mut input: Map<String, Value> = serde_json::from_str::<Value>(
            str_field(params, "rawArgs").unwrap_or(""),
        )
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
        let tool_name = match str_field(&subject, "kind").unwrap_or("") {
            "shell" => {
                if let Some(c) = str_field(&subject, "command") {
                    input.insert("command".into(), json!(c));
                }
                "Bash".to_string()
            }
            "fileAccess" => {
                if let Some(p) = str_field(&subject, "path") {
                    input.insert("file_path".into(), json!(p));
                }
                match str_field(&subject, "access") {
                    Some("read") => "Read".to_string(),
                    _ => "Edit".to_string(),
                }
            }
            _ => tool.to_string(),
        };
        // Stash what `approval/decide` needs: the approval + stage ids and the
        // server-minted choices the decision must pick from.
        input.insert(
            "_muse".into(),
            json!({
                "approvalId": params.get("approvalId"),
                "sessionId": params.get("sessionId"),
                "requirementId": params.get("currentRequirementId"),
                "choices": params.get("availableChoices").cloned().unwrap_or(json!([])),
            }),
        );
        crate::task::PendingApprovalEntry {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            tool_name,
            tool_input: Value::Object(input),
        }
    }

    fn rpc_encode_approval_response(
        &self,
        _method: &str,
        _server_req_id: &Value,
        response: &crate::task::ApprovalResponse,
        entry_input: &Value,
    ) -> Option<Result<Vec<u8>, String>> {
        let ctx = entry_input.get("_muse")?;
        let choices = ctx.get("choices").and_then(|c| c.as_array())?;
        let allow = response.behavior == "allow";
        fn decision(c: &Value) -> &str {
            str_field(c, "decision").unwrap_or("")
        }
        fn once(c: &Value) -> bool {
            str_field(c, "scope") == Some("once")
        }
        // Prefer a one-shot choice so Verun stays in charge of later calls.
        let pick = if allow {
            choices
                .iter()
                .find(|c| decision(c) == "approved" && once(c))
                .or_else(|| choices.iter().find(|c| decision(c) == "approved"))
                .or_else(|| choices.iter().find(|c| decision(c).starts_with("approved")))
        } else {
            choices
                .iter()
                .find(|c| decision(c) == "denied" && once(c))
                .or_else(|| choices.iter().find(|c| decision(c) == "denied"))
                .or_else(|| choices.iter().find(|c| decision(c).starts_with("denied")))
        }?;
        let mut params = json!({
            "approvalId": ctx.get("approvalId"),
            "choiceId": pick.get("choiceId"),
            "commandId": command_id(),
            "requirementId": ctx.get("requirementId"),
            "sessionId": ctx.get("sessionId"),
        });
        let accepts_feedback = pick.get("acceptsFeedback").and_then(|b| b.as_bool()) == Some(true);
        if let Some(msg) = response.message.as_deref().filter(|m| accepts_feedback && !m.is_empty()) {
            params["feedback"] = json!(msg);
        }
        // A string id: the ack is admission-only (the outcome arrives as
        // `approval/resolved`), and the reader drops non-numeric responses.
        Some(request(
            json!(format!("verun-approval-{}", command_id())),
            "approval/decide",
            params,
        ))
    }
}
