use super::codex_developer_instructions::{
    CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
};
use super::{
    Agent, AgentKind, CodexRpcDecision, CodexRpcItemDecision, CodexRpcPermissionsDecision,
    InputMode, SessionArgs,
};
use crate::policy::TrustLevel;
use serde_json::{json, Value};

/// OpenAI Codex CLI - open-source coding agent.
///
/// Transport: `codex app-server` speaks newline-delimited JSON-RPC 2.0 over
/// stdio. One CLI process persists across turns; each user turn is a
/// `turn/start` request on the same stdin. Plan mode is a `turn/start`
/// parameter (`collaborationMode.mode = "plan"`), not a CLI flag.
///
/// Binary: `codex`
/// Transport: `codex app-server` (JSON-RPC 2.0, NDJSON on stdio)
/// Docs: https://github.com/openai/codex
pub struct Codex;

fn trust_level_to_approval_policy(trust: TrustLevel) -> &'static str {
    match trust {
        TrustLevel::Supervised => "untrusted",
        TrustLevel::Normal => "on-request",
        TrustLevel::FullAuto => "never",
    }
}

fn trust_level_to_thread_sandbox(trust: TrustLevel) -> &'static str {
    match trust {
        TrustLevel::Supervised => "read-only",
        TrustLevel::Normal => "workspace-write",
        TrustLevel::FullAuto => "danger-full-access",
    }
}

fn trust_level_to_turn_sandbox_policy(trust: TrustLevel) -> Value {
    match trust {
        TrustLevel::Supervised => json!({ "type": "readOnly" }),
        TrustLevel::Normal => json!({ "type": "workspaceWrite" }),
        TrustLevel::FullAuto => json!({ "type": "dangerFullAccess" }),
    }
}

fn encode_rpc_frame(message: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(message).map_err(|e| format!("serialize rpc frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

impl Agent for Codex {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn display_name(&self) -> &'static str {
        "Codex"
    }
    fn cli_binary(&self) -> &'static str {
        "codex"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::JsonRpcStdio
    }

    fn install_hint(&self) -> &'static str {
        "npm i -g @openai/codex"
    }

    fn docs_url(&self) -> &'static str {
        "https://github.com/openai/codex#installation"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new(
                "gpt-5.6-sol",
                "GPT-5.6 Sol",
                "Latest frontier coding model — detail and polish",
            ),
            ModelOption::new(
                "gpt-5.6-terra",
                "GPT-5.6 Terra",
                "Everyday coding workhorse",
            ),
            ModelOption::new(
                "gpt-5.6-luna",
                "GPT-5.6 Luna",
                "Fast, clear, repeatable work",
            ),
            ModelOption::new("gpt-5.5", "GPT-5.5", "Previous frontier coding model"),
            ModelOption::new("gpt-5.4", "GPT-5.4", "Frontier coding model"),
            ModelOption::new(
                "gpt-5.4-mini",
                "GPT-5.4 Mini",
                "Smaller lower-latency coding model",
            ),
            ModelOption::new(
                "gpt-5.3-codex",
                "GPT-5.3 Codex",
                "Codex-optimized agentic coding model",
            ),
        ]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["app-server".into()]
    }

    fn persists_across_turns(&self) -> bool {
        true
    }
    fn abort_strategy(&self) -> super::AbortStrategy {
        super::AbortStrategy::Interrupt
    }

    fn supports_attachments(&self) -> bool {
        true
    }
    fn supports_plan_mode(&self) -> bool {
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn supports_fork(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        // Legacy `codex exec --json` line shape — kept so historical
        // transcripts still round-trip through `extract_resume_id`.
        if v.get("type").and_then(|t| t.as_str()) == Some("thread.started") {
            if let Some(id) = v.get("thread_id").and_then(|s| s.as_str()) {
                return Some(id.to_string());
            }
        }
        // JSON-RPC `thread/started` notification shape:
        //   { "method": "thread/started", "params": { "thread": { "id": "..." } } }
        if v.get("method").and_then(|m| m.as_str()) == Some("thread/started") {
            if let Some(id) = v.pointer("/params/thread/id").and_then(|s| s.as_str()) {
                return Some(id.to_string());
            }
        }
        None
    }

    fn defers_resume_id_until_turn_end(&self) -> bool {
        // `thread/started` now carries a persisted thread id — no need to
        // wait for `turn/completed` the way `exec --json` did.
        false
    }

    // ── JSON-RPC approval-response encoders ───────────────────────────
    // (Handshake/turn encoders live on the generic `rpc_*` methods below.
    // These three response encoders are still shared via
    // `stream::encode_codex_approval_response`.)

    fn encode_rpc_review_decision_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcDecision,
    ) -> Result<Vec<u8>, String> {
        let frame = json!({
            "id": server_request_id,
            "result": { "decision": decision.as_str() },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_item_approval_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcItemDecision,
    ) -> Result<Vec<u8>, String> {
        let frame = json!({
            "id": server_request_id,
            "result": { "decision": decision.as_str() },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_permissions_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcPermissionsDecision,
    ) -> Result<Vec<u8>, String> {
        // `item/permissions/requestApproval` expects
        // `{permissions: GrantedPermissionProfile, scope}` — NOT `{decision}`.
        // The deny path is an empty permissions object.
        let result = match decision {
            CodexRpcPermissionsDecision::Deny => json!({
                "permissions": {},
                "scope": "turn",
            }),
        };
        let frame = json!({
            "id": server_request_id,
            "result": result,
        });
        encode_rpc_frame(&frame)
    }

    // ── Generic RPC seam ────────────────────────────────────────────────
    fn uses_rpc(&self) -> bool {
        true
    }

    fn rpc_encode_initialize(
        &self,
        req_id: i64,
        ci: &super::RpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // `experimentalApi` is required by codex app-server >= 0.120 to accept
        // `collaborationMode` on `turn/start`; without it turn/start is
        // rejected with "requires experimentalApi capability".
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": ci.name, "version": ci.version },
                "capabilities": { "experimentalApi": true },
            },
        }))
    }

    fn rpc_encode_initialized(&self) -> Option<Result<Vec<u8>, String>> {
        Some(encode_rpc_frame(&json!({ "method": "initialized" })))
    }

    fn rpc_encode_start(
        &self,
        req_id: i64,
        p: &super::RpcStartParams<'_>,
    ) -> Result<Vec<u8>, String> {
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), json!(p.cwd));
        params.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(p.trust_level)),
        );
        params.insert(
            "sandbox".into(),
            json!(trust_level_to_thread_sandbox(p.trust_level)),
        );
        if let Some(model) = p.model {
            params.insert("model".into(), json!(model));
        }
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "thread/start",
            "params": Value::Object(params),
        }))
    }

    fn rpc_encode_resume(
        &self,
        req_id: i64,
        p: &super::RpcResumeParams<'_>,
    ) -> Result<Vec<u8>, String> {
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "thread/resume",
            "params": {
                "threadId": p.session_id,
                "cwd": p.cwd,
                "approvalPolicy": trust_level_to_approval_policy(p.trust_level),
                "sandbox": trust_level_to_thread_sandbox(p.trust_level),
            },
        }))
    }

    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.pointer("/thread/id").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
        let mut input: Vec<Value> = Vec::new();
        if !p.prompt.is_empty() {
            input.push(json!({ "type": "text", "text": p.prompt }));
        }
        for url in p.image_urls {
            input.push(json!({ "type": "image", "url": url }));
        }

        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(p.session_id));
        params.insert("input".into(), Value::Array(input));
        params.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(p.trust_level)),
        );
        params.insert(
            "sandboxPolicy".into(),
            trust_level_to_turn_sandbox_policy(p.trust_level),
        );
        if let Some(model) = p.model {
            params.insert("model".into(), json!(model));
        }
        if let Some(effort) = p.effort {
            params.insert("effort".into(), json!(effort));
        }

        let collab_mode = if p.plan_mode { "plan" } else { "default" };
        let developer_instructions = if p.plan_mode {
            CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        } else {
            CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS
        };
        let settings = json!({
            "model": p.model.unwrap_or("gpt-5.6-sol"),
            "reasoning_effort": p.effort.unwrap_or("medium"),
            "developer_instructions": developer_instructions,
        });
        params.insert(
            "collaborationMode".into(),
            json!({ "mode": collab_mode, "settings": settings }),
        );

        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "turn/start",
            "params": Value::Object(params),
        }))
    }

    fn rpc_parse_turn_id(&self, r: &Value) -> Option<String> {
        r.pointer("/turn/id").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_interrupt(
        &self,
        req_id: i64,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // codex app-server rejects `turn/interrupt` without BOTH ids; if we
        // don't yet know the turn id there is nothing to cancel.
        let Some(turn_id) = turn_id else {
            return Ok(None);
        };
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "turn/interrupt",
            "params": { "threadId": session_id, "turnId": turn_id },
        }))
        .map(Some)
    }

    fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
        super::rpc::is_recoverable_thread_resume_error(message)
    }

    fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
        crate::stream::process_codex_rpc_notification(method, params)
    }

    fn rpc_extract_usage(&self, method: &str, params: &Value) -> Option<super::RpcTokenUsage> {
        if method != "thread/tokenUsage/updated" {
            return None;
        }
        crate::stream::extract_codex_token_usage(params).map(|u| super::RpcTokenUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_input_tokens,
        })
    }

    fn rpc_is_approval(&self, method: &str) -> bool {
        crate::stream::is_codex_approval_method(method)
    }

    fn rpc_build_approval_entry(
        &self,
        session_id: &str,
        request_id: &str,
        method: &str,
        params: &Value,
    ) -> crate::task::PendingApprovalEntry {
        crate::stream::build_codex_approval_entry(session_id, request_id, method, params)
    }

    fn rpc_encode_approval_response(
        &self,
        method: &str,
        server_req_id: &Value,
        response: &crate::task::ApprovalResponse,
        _entry_input: &Value,
    ) -> Option<Result<Vec<u8>, String>> {
        // Codex derives everything from method + response; entry_input is a
        // Grok-only concern.
        crate::stream::encode_codex_approval_response(self, method, server_req_id, response)
    }
}
