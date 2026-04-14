mod claude;
mod codex;
mod cursor;
mod opencode;

use serde::{Deserialize, Serialize};

// Re-export the concrete types so callers can reference them if needed.
pub use claude::Claude;
pub use codex::Codex;
pub use cursor::Cursor;
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
    OpenCode,
}

impl AgentKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "codex" => Self::Codex,
            "cursor" => Self::Cursor,
            "opencode" => Self::OpenCode,
            _ => Self::Claude,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::OpenCode => "opencode",
        }
    }

    pub fn all() -> &'static [AgentKind] {
        &[Self::Claude, Self::Codex, Self::Cursor, Self::OpenCode]
    }

    /// Return a boxed trait object for this agent kind.
    pub fn implementation(self) -> Box<dyn Agent> {
        match self {
            Self::Claude => Box::new(Claude),
            Self::Codex => Box::new(Codex),
            Self::Cursor => Box::new(Cursor),
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
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

impl ModelOption {
    pub fn new(id: &str, label: &str, description: &str) -> Self {
        Self { id: id.into(), label: label.into(), description: description.into() }
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
    fn version_args(&self) -> &[&str] { &["--version"] }

    /// Human-readable install instructions.
    fn install_hint(&self) -> &'static str;

    /// Static fallback model list (first = default). Used when dynamic listing
    /// is unavailable or fails.
    fn available_models(&self) -> Vec<ModelOption>;

    /// CLI args to dynamically list models (e.g. `["--list-models"]`).
    /// Returns `None` if the agent has no such command.
    fn model_list_args(&self) -> Option<Vec<String>> { None }

    /// Parse the stdout of the model-listing command into `ModelOption`s.
    fn parse_model_list(&self, _output: &str) -> Vec<ModelOption> { vec![] }

    /// URL to the agent's official documentation / install page.
    fn docs_url(&self) -> &'static str { "" }

    // ── Capability flags ─────────────────────────────────────────────────
    // Override only the ones that differ from the defaults.

    fn supports_streaming(&self) -> bool { true }
    fn supports_resume(&self) -> bool { true }
    fn supports_plan_mode(&self) -> bool { false }
    fn supports_model_selection(&self) -> bool { true }
    fn supports_effort(&self) -> bool { false }
    fn supports_skills(&self) -> bool { false }
    fn supports_attachments(&self) -> bool { false }
    fn supports_fork(&self) -> bool { false }

    /// Whether this agent uses Claude Code's on-disk JSONL transcript
    /// format at ~/.claude/projects/. Gates transcript manipulation
    /// in fork operations.
    fn uses_claude_jsonl(&self) -> bool { false }
}
