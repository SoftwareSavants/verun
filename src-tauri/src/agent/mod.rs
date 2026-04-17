mod claude;
mod codex;
mod cursor;
mod gemini;
mod opencode;

use serde::{Deserialize, Serialize};

// Re-export the concrete types so callers can reference them if needed.
pub use claude::Claude;
pub use codex::Codex;
pub use cursor::Cursor;
pub use gemini::Gemini;
pub use opencode::OpenCode;

// ---------------------------------------------------------------------------
// AgentKind - serializable identifier stored in the DB
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Cursor,
    Gemini,
    OpenCode,
}

impl AgentKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "codex" => Self::Codex,
            "cursor" => Self::Cursor,
            "gemini" => Self::Gemini,
            "opencode" => Self::OpenCode,
            _ => Self::Claude,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Gemini => "gemini",
            Self::OpenCode => "opencode",
        }
    }

    pub fn all() -> &'static [AgentKind] {
        &[
            Self::Claude,
            Self::Codex,
            Self::Gemini,
            Self::OpenCode,
            Self::Cursor,
        ]
    }

    /// Return a boxed trait object for this agent kind.
    pub fn implementation(self) -> Box<dyn Agent> {
        match self {
            Self::Claude => Box::new(Claude),
            Self::Codex => Box::new(Codex),
            Self::Cursor => Box::new(Cursor),
            Self::Gemini => Box::new(Gemini),
            Self::OpenCode => Box::new(OpenCode),
        }
    }
}

impl std::fmt::Display for AgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Per-agent model definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

impl ModelOption {
    pub fn new(id: &str, label: &str, description: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: description.into(),
            min_version: None,
        }
    }

    pub fn with_min_version(mut self, version: &str) -> Self {
        self.min_version = Some(version.into());
        self
    }
}

// ---------------------------------------------------------------------------
// How the agent accepts user messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    /// Pipe JSON objects to stdin (Claude's `--input-format stream-json`).
    StreamJsonStdin,
    /// Pass the prompt as a positional arg or via stdin plaintext.
    PositionalOrStdin,
}

// ---------------------------------------------------------------------------
// Parameters for building a session command
// ---------------------------------------------------------------------------

pub struct SessionArgs<'a> {
    pub resume_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub plan_mode: bool,
    pub thinking_mode: bool,
    pub fast_mode: bool,
    pub trust_level: crate::policy::TrustLevel,
    pub worktree_path: &'a str,
    pub repo_path: &'a str,
    /// For `PositionalOrStdin` agents: the user message appended as the final positional arg.
    pub message: &'a str,
}

// ---------------------------------------------------------------------------
// The trait
// ---------------------------------------------------------------------------

pub trait Agent: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;

    /// The executable name on $PATH.
    fn cli_binary(&self) -> &'static str;

    /// How the agent receives user messages.
    fn input_mode(&self) -> InputMode;

    /// Build the full argument list for spawning a session.
    /// This is the single place that knows each agent's CLI contract.
    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String>;

    /// Arguments to check the CLI version (e.g. `["--version"]`).
    fn version_args(&self) -> &[&str] {
        &["--version"]
    }

    /// Human-readable install instructions.
    fn install_hint(&self) -> &'static str;

    /// Command to update the CLI to the latest version.
    /// Defaults to `install_hint` if not overridden.
    fn update_hint(&self) -> &'static str {
        self.install_hint()
    }

    /// Static fallback model list (first = default). Used when dynamic listing
    /// is unavailable or fails.
    fn available_models(&self) -> Vec<ModelOption>;

    /// CLI args to dynamically list models (e.g. `["--list-models"]`).
    /// Returns `None` if the agent has no such command.
    fn model_list_args(&self) -> Option<Vec<String>> {
        None
    }

    /// Parse the stdout of the model-listing command into `ModelOption`s.
    fn parse_model_list(&self, _output: &str) -> Vec<ModelOption> {
        vec![]
    }

    /// URL to the agent's official documentation / install page.
    fn docs_url(&self) -> &'static str {
        ""
    }

    // ── Capability flags ─────────────────────────────────────────────────
    // Override only the ones that differ from the defaults.

    fn supports_streaming(&self) -> bool {
        true
    }
    fn supports_resume(&self) -> bool {
        true
    }
    fn supports_plan_mode(&self) -> bool {
        false
    }
    fn supports_model_selection(&self) -> bool {
        true
    }
    fn supports_effort(&self) -> bool {
        false
    }
    fn supports_skills(&self) -> bool {
        false
    }
    fn supports_attachments(&self) -> bool {
        false
    }
    fn supports_fork(&self) -> bool {
        false
    }

    /// Whether this agent uses Claude Code's on-disk JSONL transcript
    /// format at ~/.claude/projects/. Gates transcript manipulation
    /// in fork operations.
    fn uses_claude_jsonl(&self) -> bool {
        false
    }

    /// Extract the agent's native resume/session ID from a parsed NDJSON event.
    /// Called on each line during streaming; returns `Some(id)` on the first
    /// event that carries one (e.g. Claude's `system.init`, Codex's
    /// `thread.started`, OpenCode's `step_start`).
    fn extract_resume_id(&self, _v: &serde_json::Value) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_args() -> SessionArgs<'static> {
        SessionArgs {
            resume_session_id: None,
            model: None,
            plan_mode: false,
            thinking_mode: false,
            fast_mode: false,
            trust_level: crate::policy::TrustLevel::Normal,
            worktree_path: "",
            repo_path: "",
            message: "",
        }
    }

    // ── AgentKind round-trip ────────────────────────────────────────────

    #[test]
    fn kind_parse_roundtrip() {
        for &kind in AgentKind::all() {
            assert_eq!(AgentKind::parse(kind.as_str()), kind);
        }
    }

    #[test]
    fn kind_parse_unknown_defaults_to_claude() {
        assert_eq!(AgentKind::parse("unknown"), AgentKind::Claude);
    }

    // ── Claude ──────────────────────────────────────────────────────────

    #[test]
    fn claude_build_args_basic() {
        let agent = Claude;
        let args = agent.build_session_args(&default_args());
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn claude_build_args_plan_mode() {
        let agent = Claude;
        let args = agent.build_session_args(&SessionArgs {
            plan_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"plan".to_string()));
    }

    #[test]
    fn claude_build_args_resume() {
        let agent = Claude;
        let args = agent.build_session_args(&SessionArgs {
            resume_session_id: Some("sess-1"),
            ..default_args()
        });
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"sess-1".to_string()));
    }

    #[test]
    fn claude_build_args_model() {
        let agent = Claude;
        let args = agent.build_session_args(&SessionArgs {
            model: Some("opus"),
            ..default_args()
        });
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"opus".to_string()));
    }

    #[test]
    fn claude_build_args_thinking() {
        let agent = Claude;
        let args = agent.build_session_args(&SessionArgs {
            thinking_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"max".to_string()));
    }

    #[test]
    fn claude_build_args_fast() {
        let agent = Claude;
        let args = agent.build_session_args(&SessionArgs {
            fast_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"low".to_string()));
    }

    #[test]
    fn claude_extract_resume_from_init() {
        let agent = Claude;
        let v = json!({"type":"system","subtype":"init","session_id":"s-1"});
        assert_eq!(agent.extract_resume_id(&v), Some("s-1".into()));
    }

    #[test]
    fn claude_extract_resume_from_result() {
        let agent = Claude;
        let v = json!({"type":"result","session_id":"s-2","cost":0.01});
        assert_eq!(agent.extract_resume_id(&v), Some("s-2".into()));
    }

    #[test]
    fn claude_extract_resume_ignores_other() {
        let agent = Claude;
        let v = json!({"type":"assistant","content":"hello"});
        assert_eq!(agent.extract_resume_id(&v), None);
    }

    #[test]
    fn claude_capabilities() {
        let agent = Claude;
        assert!(agent.supports_plan_mode());
        assert!(agent.supports_effort());
        assert!(agent.supports_skills());
        assert!(agent.supports_attachments());
        assert!(agent.supports_fork());
        assert!(agent.uses_claude_jsonl());
    }

    // ── Codex ───────────────────────────────────────────────────────────

    #[test]
    fn codex_build_args_basic() {
        let agent = Codex;
        let args = agent.build_session_args(&SessionArgs {
            message: "fix the bug",
            ..default_args()
        });
        assert!(args.contains(&"exec".to_string()));
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"-a".to_string()));
        assert!(args.contains(&"on-request".to_string()));
        assert!(args.contains(&"-s".to_string()));
        assert!(args.contains(&"workspace-write".to_string()));
        assert!(args.contains(&"fix the bug".to_string()));
    }

    #[test]
    fn codex_build_args_full_auto_uses_danger_mode() {
        let agent = Codex;
        let args = agent.build_session_args(&SessionArgs {
            trust_level: crate::policy::TrustLevel::FullAuto,
            ..default_args()
        });
        assert!(args.contains(&"-a".to_string()));
        assert!(args.contains(&"never".to_string()));
        assert!(args.contains(&"-s".to_string()));
        assert!(args.contains(&"danger-full-access".to_string()));
    }

    #[test]
    fn codex_build_args_resume() {
        let agent = Codex;
        let args = agent.build_session_args(&SessionArgs {
            resume_session_id: Some("t-1"),
            ..default_args()
        });
        assert!(args.contains(&"resume".to_string()));
        assert!(args.contains(&"t-1".to_string()));
    }

    #[test]
    fn codex_extract_resume_from_thread_started() {
        let agent = Codex;
        let v = json!({"type":"thread.started","thread_id":"t-99"});
        assert_eq!(agent.extract_resume_id(&v), Some("t-99".into()));
    }

    #[test]
    fn codex_extract_resume_ignores_other() {
        let agent = Codex;
        let v = json!({"type":"message","content":"hi"});
        assert_eq!(agent.extract_resume_id(&v), None);
    }

    #[test]
    fn codex_capabilities() {
        let agent = Codex;
        assert!(!agent.supports_plan_mode());
        assert!(!agent.supports_effort());
        assert!(!agent.supports_skills());
        assert!(agent.supports_attachments());
        assert!(!agent.supports_fork());
        assert!(!agent.uses_claude_jsonl());
    }

    // ── Cursor ──────────────────────────────────────────────────────────

    #[test]
    fn cursor_build_args_basic() {
        let agent = Cursor;
        let args = agent.build_session_args(&SessionArgs {
            message: "hello",
            ..default_args()
        });
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--force".to_string()));
        assert!(args.contains(&"hello".to_string()));
    }

    #[test]
    fn cursor_build_args_plan_mode() {
        let agent = Cursor;
        let args = agent.build_session_args(&SessionArgs {
            plan_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"--mode".to_string()));
        assert!(args.contains(&"plan".to_string()));
    }

    #[test]
    fn cursor_extract_resume_from_init() {
        let agent = Cursor;
        let v = json!({"type":"system","subtype":"init","session_id":"c-1"});
        assert_eq!(agent.extract_resume_id(&v), Some("c-1".into()));
    }

    #[test]
    fn cursor_extract_resume_from_result() {
        let agent = Cursor;
        let v = json!({"type":"result","session_id":"c-2"});
        assert_eq!(agent.extract_resume_id(&v), Some("c-2".into()));
    }

    #[test]
    fn cursor_capabilities() {
        let agent = Cursor;
        assert!(agent.supports_plan_mode());
        assert!(!agent.supports_effort());
        assert!(!agent.supports_skills());
        assert!(!agent.supports_attachments());
        assert!(!agent.supports_fork());
        assert!(!agent.uses_claude_jsonl());
    }

    #[test]
    fn cursor_parse_model_list() {
        let agent = Cursor;
        let output = "Available models:\n  composer-2-fast - Composer 2 Fast  (default)\n  gpt-5.4-medium - GPT-5.4\n\nTip: use --model <id>\n";
        let models = agent.parse_model_list(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "composer-2-fast");
        assert_eq!(models[0].label, "Composer 2 Fast");
        assert_eq!(models[1].id, "gpt-5.4-medium");
    }

    // ── OpenCode ────────────────────────────────────────────────────────

    #[test]
    fn opencode_build_args_basic() {
        let agent = OpenCode;
        let args = agent.build_session_args(&SessionArgs {
            message: "do it",
            ..default_args()
        });
        assert!(args.contains(&"run".to_string()));
        assert!(args.contains(&"--format".to_string()));
        assert!(args.contains(&"json".to_string()));
        assert!(args.contains(&"do it".to_string()));
    }

    #[test]
    fn opencode_build_args_plan_mode() {
        let agent = OpenCode;
        let args = agent.build_session_args(&SessionArgs {
            plan_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"--agent".to_string()));
        assert!(args.contains(&"plan".to_string()));
    }

    #[test]
    fn opencode_build_args_resume() {
        let agent = OpenCode;
        let args = agent.build_session_args(&SessionArgs {
            resume_session_id: Some("oc-1"),
            ..default_args()
        });
        assert!(args.contains(&"--session".to_string()));
        assert!(args.contains(&"oc-1".to_string()));
    }

    #[test]
    fn opencode_extract_resume_id() {
        let agent = OpenCode;
        let v = json!({"sessionID":"oc-42","type":"step_start"});
        assert_eq!(agent.extract_resume_id(&v), Some("oc-42".into()));
    }

    #[test]
    fn opencode_extract_resume_id_missing() {
        let agent = OpenCode;
        let v = json!({"type":"step_start"});
        assert_eq!(agent.extract_resume_id(&v), None);
    }

    #[test]
    fn opencode_capabilities() {
        let agent = OpenCode;
        assert!(agent.supports_plan_mode());
        assert!(!agent.supports_effort());
        assert!(!agent.supports_skills());
        assert!(agent.supports_attachments());
        assert!(!agent.supports_fork());
        assert!(!agent.uses_claude_jsonl());
    }

    #[test]
    fn opencode_parse_model_list() {
        let agent = OpenCode;
        let output =
            "anthropic/claude-sonnet-4-5\nopenai/gpt-5.3\nsome migration message with spaces\n";
        let models = agent.parse_model_list(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-5");
        assert_eq!(models[0].label, "claude-sonnet-4-5");
        assert_eq!(models[1].id, "openai/gpt-5.3");
    }

    // ── Gemini ──────────────────────────────────────────────────────────

    #[test]
    fn gemini_build_args_basic() {
        let agent = Gemini;
        let args = agent.build_session_args(&SessionArgs {
            message: "hello",
            ..default_args()
        });
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--yolo".to_string()));
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"hello".to_string()));
    }

    #[test]
    fn gemini_build_args_plan_mode() {
        let agent = Gemini;
        let args = agent.build_session_args(&SessionArgs {
            plan_mode: true,
            ..default_args()
        });
        assert!(args.contains(&"--approval-mode".to_string()));
        assert!(args.contains(&"plan".to_string()));
    }

    #[test]
    fn gemini_build_args_resume() {
        let agent = Gemini;
        let args = agent.build_session_args(&SessionArgs {
            resume_session_id: Some("g-1"),
            ..default_args()
        });
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"g-1".to_string()));
    }

    #[test]
    fn gemini_build_args_model() {
        let agent = Gemini;
        let args = agent.build_session_args(&SessionArgs {
            model: Some("pro"),
            ..default_args()
        });
        assert!(args.contains(&"-m".to_string()));
        assert!(args.contains(&"pro".to_string()));
    }

    #[test]
    fn gemini_extract_resume_id() {
        let agent = Gemini;
        let v = json!({"sessionId":"g-42","type":"init"});
        assert_eq!(agent.extract_resume_id(&v), Some("g-42".into()));
    }

    #[test]
    fn gemini_extract_resume_id_snake_case() {
        let agent = Gemini;
        let v = json!({"session_id":"g-43"});
        assert_eq!(agent.extract_resume_id(&v), Some("g-43".into()));
    }

    #[test]
    fn gemini_extract_resume_id_missing() {
        let agent = Gemini;
        let v = json!({"type":"message","content":"hi"});
        assert_eq!(agent.extract_resume_id(&v), None);
    }

    #[test]
    fn gemini_capabilities() {
        let agent = Gemini;
        assert!(agent.supports_plan_mode());
        assert!(!agent.supports_effort());
        assert!(!agent.supports_skills());
        assert!(agent.supports_attachments());
        assert!(!agent.supports_fork());
        assert!(!agent.uses_claude_jsonl());
    }

    // ── All agents have non-empty basics ────────────────────────────────

    #[test]
    fn all_agents_have_display_name_and_binary() {
        for &kind in AgentKind::all() {
            let agent = kind.implementation();
            assert!(
                !agent.display_name().is_empty(),
                "{kind:?} has empty display_name"
            );
            assert!(
                !agent.cli_binary().is_empty(),
                "{kind:?} has empty cli_binary"
            );
            assert!(
                !agent.install_hint().is_empty(),
                "{kind:?} has empty install_hint"
            );
        }
    }
}
