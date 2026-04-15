use super::{Agent, AgentKind, InputMode, SessionArgs};

/// Gemini CLI - Google's AI coding agent.
///
/// Binary: `gemini`
/// Non-interactive: `-p <prompt> --output-format stream-json`
/// Resume: `--resume <session_id>`
/// Model: `-m <model>`
/// Plan mode: `--approval-mode plan`
/// Docs: https://geminicli.com/docs/
pub struct Gemini;

impl Agent for Gemini {
    fn kind(&self) -> AgentKind { AgentKind::Gemini }
    fn display_name(&self) -> &'static str { "Gemini CLI" }
    fn cli_binary(&self) -> &'static str { "gemini" }
    fn input_mode(&self) -> InputMode { InputMode::PositionalOrStdin }

    fn install_hint(&self) -> &'static str {
        "npm i -g @google/gemini-cli"
    }

    fn docs_url(&self) -> &'static str {
        "https://geminicli.com/docs/get-started"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("auto", "Auto", "Automatic model selection based on task"),
            ModelOption::new("pro", "Gemini Pro", "Gemini 3 Pro - Complex reasoning tasks"),
            ModelOption::new("flash", "Gemini Flash", "Gemini 2.5 Flash - Fast responses"),
            ModelOption::new("flash-lite", "Gemini Flash Lite", "Lightweight flash variant"),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v: Vec<String> = vec![
            "--output-format".into(), "stream-json".into(),
            "--yolo".into(),
        ];

        if args.plan_mode {
            v.extend(["--approval-mode".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["-m".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }

        // -p with prompt as positional arg
        if !args.message.is_empty() {
            v.extend(["-p".into(), args.message.to_string()]);
        }

        v
    }

    fn supports_plan_mode(&self) -> bool { true }
    fn supports_attachments(&self) -> bool { true }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        // Gemini stream-json emits an init event with session metadata.
        // Try common field names for the session identifier.
        v.get("sessionId").and_then(|s| s.as_str()).map(str::to_string)
            .or_else(|| v.get("session_id").and_then(|s| s.as_str()).map(str::to_string))
    }
}
