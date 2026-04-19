use super::{Agent, AgentKind, AbortStrategy, InputMode, SessionArgs};

/// Claude Code - Anthropic's CLI coding agent.
///
/// Binary: `claude`
/// Streaming: `--output-format stream-json --input-format stream-json`
/// Resume: `--resume <session_id>`
/// Docs: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code
pub struct Claude;

impl Agent for Claude {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }
    fn cli_binary(&self) -> &'static str {
        "claude"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::StreamJsonStdin
    }

    fn install_hint(&self) -> &'static str {
        "npm i -g @anthropic-ai/claude-code"
    }

    fn update_hint(&self) -> &'static str {
        "claude update"
    }

    fn docs_url(&self) -> &'static str {
        "https://docs.anthropic.com/en/docs/claude-code/quickstart"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new(
                "claude-opus-4-7",
                "Claude Opus 4.7",
                "Latest and most capable",
            )
            .with_min_version("2.1.111"),
            ModelOption::new(
                "claude-opus-4-6",
                "Claude Opus 4.6",
                "Most capable for complex tasks",
            ),
            ModelOption::new(
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6",
                "Best for everyday tasks",
            ),
            ModelOption::new(
                "claude-haiku-4-5",
                "Claude Haiku 4.5",
                "Fastest for quick answers",
            ),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        // No `-p`: the CLI stays alive reading NDJSON on stdin across turns,
        // matching claude-agent-sdk-python (subprocess_cli.py:207).
        let mut v = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
        ];

        if args.plan_mode {
            v.extend(["--permission-mode".into(), "plan".into()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if args.thinking_mode {
            v.extend(["--effort".into(), "max".into()]);
        }
        if args.fast_mode {
            v.extend(["--effort".into(), "low".into()]);
        }
        v
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
    fn supports_attachments(&self) -> bool {
        true
    }
    fn supports_fork(&self) -> bool {
        true
    }
    fn uses_claude_jsonl(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        let t = v.get("type")?.as_str()?;
        match t {
            "system" if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                v.get("session_id")?.as_str().map(str::to_string)
            }
            "result" => v.get("session_id")?.as_str().map(str::to_string),
            _ => None,
        }
    }

    fn persists_across_turns(&self) -> bool {
        true
    }

    fn abort_strategy(&self) -> AbortStrategy {
        AbortStrategy::Interrupt
    }

    fn encode_stream_user_message(
        &self,
        message: &str,
        attachments: &[crate::task::Attachment],
    ) -> Result<Vec<u8>, String> {
        let mut content_blocks: Vec<serde_json::Value> = Vec::new();
        for attachment in attachments {
            content_blocks.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": attachment.mime_type,
                    "data": attachment.data_base64,
                }
            }));
        }
        if !message.is_empty() {
            content_blocks.push(serde_json::json!({ "type": "text", "text": message }));
        }

        let user_msg = serde_json::json!({
            "type": "user",
            "session_id": "",
            "parent_tool_use_id": null,
            "message": { "role": "user", "content": content_blocks },
        });

        let mut payload =
            serde_json::to_vec(&user_msg).map_err(|e| format!("serialize user msg: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_interrupt(&self, request_id: &str) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" },
        });
        let mut payload =
            serde_json::to_vec(&envelope).map_err(|e| format!("serialize interrupt: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_set_permission_mode(
        &self,
        request_id: &str,
        mode: &str,
    ) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "set_permission_mode", "mode": mode },
        });
        let mut payload = serde_json::to_vec(&envelope)
            .map_err(|e| format!("serialize set_permission_mode: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_set_model(
        &self,
        request_id: &str,
        model: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "set_model", "model": model },
        });
        let mut payload =
            serde_json::to_vec(&envelope).map_err(|e| format!("serialize set_model: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }
}
