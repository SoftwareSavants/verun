use super::{Agent, AgentKind, InputMode, SessionArgs};

/// OpenCode - open-source AI coding agent by SST.
///
/// Binary: `opencode`
/// Non-interactive: `opencode run <prompt> --format json`
/// Resume: `--session <session_id>` or `--continue` (most recent)
/// Model: `--model <provider/model>` (e.g. `anthropic/claude-sonnet-4-5`)
/// Plan mode: `--agent plan` (read-only, all tools set to ask)
/// Install: `curl -fsSL https://opencode.ai/install | bash`
///          or `npm i -g opencode-ai`
/// Docs: https://opencode.ai/docs/cli/
pub struct OpenCode;

impl Agent for OpenCode {
    fn kind(&self) -> AgentKind { AgentKind::OpenCode }
    fn display_name(&self) -> &'static str { "OpenCode" }
    fn cli_binary(&self) -> &'static str { "opencode" }
    fn input_mode(&self) -> InputMode { InputMode::PositionalOrStdin }

    fn install_hint(&self) -> &'static str {
        "curl -fsSL https://opencode.ai/install | bash"
    }

    fn docs_url(&self) -> &'static str {
        "https://opencode.ai/docs"
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let mut v: Vec<String> = vec!["run".into(), "--format".into(), "json".into()];

        if args.plan_mode {
            v.extend(["--agent".into(), "plan".into()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--session".into(), rid.to_string()]);
        }

        v
    }

    fn supports_plan_mode(&self) -> bool { true }
    fn supports_attachments(&self) -> bool { true }
}
