use super::{Agent, AgentKind, InputMode, SessionArgs};

/// OpenAI Codex CLI - open-source coding agent.
///
/// Binary: `codex`
/// Non-interactive: `codex exec --json` (JSONL streaming on stdout)
/// Resume: `codex exec resume <session_id>`
/// Model: `-m <model>`
/// Images: `--image <file>` (repeatable, comma-delimited)
/// Approval: `--full-auto` (sandboxed), `--yolo` (no sandbox)
/// Docs: https://github.com/openai/codex
pub struct Codex;

impl Agent for Codex {
    fn kind(&self) -> AgentKind { AgentKind::Codex }
    fn display_name(&self) -> &'static str { "Codex" }
    fn cli_binary(&self) -> &'static str { "codex" }
    fn input_mode(&self) -> InputMode { InputMode::PositionalOrStdin }

    fn install_hint(&self) -> &'static str {
        "npm i -g @openai/codex"
    }

    fn docs_url(&self) -> &'static str {
        "https://github.com/openai/codex#installation"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new("codex-mini-latest", "Codex Mini", "Lightweight"),
            ModelOption::new("o4-mini", "o4-mini", "Balanced"),
            ModelOption::new("o3", "o3", "Most capable"),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v: Vec<String> = vec!["exec".into(), "--json".into()];

        if let Some(m) = args.model {
            v.extend(["-m".into(), m.to_string()]);
        }

        // Default to full-auto so Verun can drive it non-interactively.
        v.push("--full-auto".into());

        // Resume is a subcommand: `codex exec resume <session_id>`
        if let Some(rid) = args.resume_session_id {
            v.extend(["resume".into(), rid.to_string()]);
        }

        v
    }

    fn supports_attachments(&self) -> bool { true }
}
