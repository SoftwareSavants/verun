use super::{Agent, AgentKind, InputMode, SessionArgs};

/// Claude Code - Anthropic's CLI coding agent.
///
/// Binary: `claude`
/// Streaming: `--output-format stream-json --input-format stream-json`
/// Resume: `--resume <session_id>`
/// Docs: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code
pub struct Claude;

impl Agent for Claude {
    fn kind(&self) -> AgentKind { AgentKind::Claude }
    fn display_name(&self) -> &'static str { "Claude Code" }
    fn cli_binary(&self) -> &'static str { "claude" }
    fn input_mode(&self) -> InputMode { InputMode::StreamJsonStdin }

    fn install_hint(&self) -> &'static str {
        "npm i -g @anthropic-ai/claude-code"
    }

    fn docs_url(&self) -> &'static str {
        "https://docs.anthropic.com/en/docs/claude-code/quickstart"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("sonnet", "Sonnet", "Balanced"),
            ModelOption::new("opus", "Opus", "Most capable"),
            ModelOption::new("haiku", "Haiku", "Fastest"),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--input-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--permission-prompt-tool".into(), "stdio".into(),
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

    fn supports_plan_mode(&self) -> bool { true }
    fn supports_effort(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn supports_attachments(&self) -> bool { true }
    fn supports_fork(&self) -> bool { true }
    fn uses_claude_jsonl(&self) -> bool { true }

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
}
