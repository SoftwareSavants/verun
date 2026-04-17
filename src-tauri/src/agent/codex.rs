use super::{Agent, AgentKind, InputMode, SessionArgs};
use crate::policy::TrustLevel;

fn resolve_codex_extra_writable_dirs(args: &SessionArgs<'_>) -> Vec<String> {
    let mut dirs = Vec::new();

    let repo_git_dir = std::path::Path::new(args.repo_path).join(".git");
    if repo_git_dir.exists() {
        dirs.push(repo_git_dir.to_string_lossy().to_string());
    }

    let git_pointer_path = std::path::Path::new(args.worktree_path).join(".git");
    if let Ok(contents) = std::fs::read_to_string(&git_pointer_path) {
        if let Some(raw) = contents.trim().strip_prefix("gitdir:") {
            let gitdir = raw.trim();
            if !gitdir.is_empty() {
                dirs.push(gitdir.to_string());
            }
        }
    }

    dirs.sort();
    dirs.dedup();
    dirs
}

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
        InputMode::PositionalOrStdin
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

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        let (approval_policy, sandbox) = match args.trust_level {
            TrustLevel::FullAuto => ("never", "danger-full-access"),
            TrustLevel::Normal | TrustLevel::Supervised => ("on-request", "workspace-write"),
        };

        let mut v: Vec<String> = vec![
            "-a".into(),
            approval_policy.into(),
            "exec".into(),
            "--json".into(),
            "-s".into(),
            sandbox.into(),
        ];

        if args.trust_level != TrustLevel::FullAuto {
            for dir in resolve_codex_extra_writable_dirs(args) {
                v.extend(["--add-dir".into(), dir]);
            }
        }

        if let Some(m) = args.model {
            v.extend(["-m".into(), m.to_string()]);
        }

        // Resume is a subcommand: `codex exec resume <session_id>`
        if let Some(rid) = args.resume_session_id {
            v.extend(["resume".into(), rid.to_string()]);
        }

        // Prompt as positional arg — codex exec [flags] <prompt>
        if !args.message.is_empty() {
            v.push(args.message.to_string());
        }

        v
    }

    fn supports_attachments(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        if v.get("type")?.as_str()? == "thread.started" {
            v.get("thread_id")?.as_str().map(str::to_string)
        } else {
            None
        }
    }

    fn defers_resume_id_until_turn_end(&self) -> bool {
        true
    }
}
