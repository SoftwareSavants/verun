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
        // Fallback used when `agent --list-models` is unavailable or fails.
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("composer-2-fast", "Composer 2 Fast", "Default"),
            ModelOption::new("composer-2", "Composer 2", "Balanced"),
            ModelOption::new("gpt-5.3-codex", "Codex 5.3", "Coding"),
            ModelOption::new("claude-4.6-sonnet-medium", "Sonnet 4.6", "Anthropic"),
            ModelOption::new("gpt-5.4-medium", "GPT-5.4", "OpenAI"),
        ]
    }

    fn model_list_args(&self) -> Option<Vec<String>> {
        Some(vec!["--list-models".into()])
    }

    fn parse_model_list(&self, output: &str) -> Vec<crate::agent::ModelOption> {
        // Output format (one per line):
        //   <id> - <Name>  (default)
        // Skip "Available models" header and "Tip:" footer.
        output.lines()
            .filter_map(|line| {
                let line = line.trim();
                let sep = line.find(" - ")?;
                let id = line[..sep].trim();
                if id.is_empty() { return None; }
                // Strip trailing "(default)" from the display name
                let name = line[sep + 3..]
                    .trim()
                    .trim_end_matches("(default)")
                    .trim()
                    .to_string();
                if name.is_empty() { return None; }
                Some(crate::agent::ModelOption::new(id, &name, ""))
            })
            .collect()
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
