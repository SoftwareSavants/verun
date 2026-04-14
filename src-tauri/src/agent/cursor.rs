use super::{Agent, AgentKind, InputMode, SessionArgs};

/// Cursor Agent CLI - headless coding agent from Cursor.
///
/// Binary: `agent`
/// Non-interactive: `agent -p --output-format stream-json`
/// Resume: `--resume <chat_id>` or `--continue` (most recent)
/// Model: `--model <model>`
/// Approval: `--force` / `--yolo` (auto-approve file modifications)
/// Plan mode: `--mode plan`
/// Docs: https://cursor.com/docs/cli/overview
pub struct Cursor;

impl Agent for Cursor {
    fn kind(&self) -> AgentKind { AgentKind::Cursor }
    fn display_name(&self) -> &'static str { "Cursor Agent" }
    fn cli_binary(&self) -> &'static str { "agent" }
    fn input_mode(&self) -> InputMode { InputMode::PositionalOrStdin }

    fn install_hint(&self) -> &'static str {
        "curl https://cursor.com/install -fsSL | bash"
    }

    fn docs_url(&self) -> &'static str {
        "https://cursor.com/docs/cli/overview#installation"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("claude-3-5-sonnet-20241022", "Claude Sonnet", "Balanced"),
            ModelOption::new("gpt-4o", "GPT-4o", "Versatile"),
            ModelOption::new("gemini-2.0-flash-exp", "Gemini Flash", "Fast"),
            ModelOption::new("cursor-small", "Cursor Small", "Lightweight"),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--force".into(),
            "--trust".into(),
        ];

        if args.plan_mode {
            v.extend(["--mode".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }

        v
    }

    fn supports_plan_mode(&self) -> bool { true }
}
