use super::codex_developer_instructions::{
    CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
};
use super::{
    Agent, AgentKind, CodexRpcClientInfo, CodexRpcDecision, CodexRpcItemDecision,
    CodexRpcPermissionsDecision, CodexRpcThreadResumeParams, CodexRpcThreadStartParams,
    CodexRpcTurnStartParams, InputMode, SessionArgs,
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
            ModelOption::new("gpt-5.4", "GPT-5.4", "Latest frontier agentic coding model"),
            ModelOption::new(
                "gpt-5.4-mini",
                "GPT-5.4 Mini",
                "Smaller frontier agentic coding model",
            ),
            ModelOption::new(
                "gpt-5.3-codex",
                "GPT-5.3 Codex",
                "Codex-optimized agentic coding model",
            ),
            ModelOption::new(
                "gpt-5.3-codex-spark",
                "GPT-5.3 Codex Spark",
                "Lightweight Codex model",
            ),
            ModelOption::new(
                "gpt-5.2-codex",
                "GPT-5.2 Codex",
                "Codex-optimized agentic coding model",
            ),
            ModelOption::new(
                "gpt-5.2",
                "GPT-5.2",
                "Optimized for professional work and long-running tasks",
            ),
        ]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["app-server".into()]
    }

    fn uses_app_server(&self) -> bool {
        true
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

    // ── JSON-RPC encoders ─────────────────────────────────────────────

    fn encode_rpc_initialize(
        &self,
        request_id: i64,
        client_info: &CodexRpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // `experimentalApi` is required by codex app-server >= 0.120 to
        // accept `collaborationMode` on `turn/start`. Without it the server
        // rejects turn/start with:
        //   "turn/start.collaborationMode requires experimentalApi capability"
        let frame = json!({
            "id": request_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": client_info.name,
                    "version": client_info.version,
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_initialized_notification(&self) -> Result<Vec<u8>, String> {
        let frame = json!({ "method": "initialized" });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_thread_start(
        &self,
        request_id: i64,
        params: &CodexRpcThreadStartParams<'_>,
    ) -> Result<Vec<u8>, String> {
        let mut p = serde_json::Map::new();
        p.insert("cwd".into(), json!(params.cwd));
        p.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(params.trust_level)),
        );
        p.insert(
            "sandbox".into(),
            json!(trust_level_to_thread_sandbox(params.trust_level)),
        );
        if let Some(model) = params.model {
            p.insert("model".into(), json!(model));
        }
        let frame = json!({
            "id": request_id,
            "method": "thread/start",
            "params": Value::Object(p),
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_thread_resume(
        &self,
        request_id: i64,
        params: &CodexRpcThreadResumeParams<'_>,
    ) -> Result<Vec<u8>, String> {
        let frame = json!({
            "id": request_id,
            "method": "thread/resume",
            "params": {
                "threadId": params.thread_id,
                "cwd": params.cwd,
                "approvalPolicy": trust_level_to_approval_policy(params.trust_level),
                "sandbox": trust_level_to_thread_sandbox(params.trust_level),
            },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_turn_start(
        &self,
        request_id: i64,
        params: &CodexRpcTurnStartParams<'_>,
    ) -> Result<Vec<u8>, String> {
        let mut input: Vec<Value> = Vec::new();
        if !params.prompt.is_empty() {
            input.push(json!({ "type": "text", "text": params.prompt }));
        }
        for url in params.image_urls {
            input.push(json!({ "type": "image", "url": url }));
        }

        let mut p = serde_json::Map::new();
        p.insert("threadId".into(), json!(params.thread_id));
        p.insert("input".into(), Value::Array(input));
        p.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(params.trust_level)),
        );
        p.insert(
            "sandboxPolicy".into(),
            trust_level_to_turn_sandbox_policy(params.trust_level),
        );
        if let Some(model) = params.model {
            p.insert("model".into(), json!(model));
        }
        if let Some(effort) = params.effort {
            p.insert("effort".into(), json!(effort));
        }

        let collab_mode = if params.plan_mode { "plan" } else { "default" };
        let developer_instructions = if params.plan_mode {
            CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        } else {
            CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS
        };
        let settings = json!({
            "model": params.model.unwrap_or("gpt-5.4"),
            "reasoning_effort": params.effort.unwrap_or("medium"),
            "developer_instructions": developer_instructions,
        });
        p.insert(
            "collaborationMode".into(),
            json!({ "mode": collab_mode, "settings": settings }),
        );

        let frame = json!({
            "id": request_id,
            "method": "turn/start",
            "params": Value::Object(p),
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_turn_interrupt(
        &self,
        request_id: i64,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Vec<u8>, String> {
        // codex app-server rejects `turn/interrupt` unless BOTH `threadId` and
        // `turnId` are present — sending just the thread id returns
        // `Invalid request: missing field turnId`.
        let frame = json!({
            "id": request_id,
            "method": "turn/interrupt",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
            },
        });
        encode_rpc_frame(&frame)
    }

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
}
