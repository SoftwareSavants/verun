//! # Agents
//!
//! Verun runs several coding CLIs (Claude, Codex, Cursor, Gemini, OpenCode)
//! with a single orchestration pipeline. This module is the seam: every
//! agent-specific detail lives behind the [`Agent`] trait so that
//! `task.rs`, `stream.rs`, and `ipc.rs` stay agent-agnostic.
//!
//! ## Rule of thumb
//!
//! If you find yourself writing `if agent_kind == Claude` anywhere outside
//! `agent/`, stop — add a capability method to [`Agent`] instead and override
//! it on the relevant impls.
//!
//! ## Anatomy of an agent
//!
//! Each agent is a zero-sized struct (see [`Claude`], [`Codex`], [`Cursor`],
//! [`Gemini`], [`OpenCode`]) implementing [`Agent`]. [`AgentKind`] is the
//! serializable tag stored on `sessions.agent_type` in the DB; it maps 1:1
//! to a concrete impl via [`AgentKind::implementation`].
//!
//! The trait groups methods into four concerns:
//!
//! 1. **Identity** — `kind`, `display_name`, `cli_binary`, `install_hint`,
//!    `docs_url`. Purely descriptive.
//! 2. **Command shape** — `input_mode`, `build_session_args`, `version_args`,
//!    `available_models`, `model_list_args`, `parse_model_list`. Everything
//!    needed to build the subprocess invocation.
//! 3. **Capability flags** — `supports_plan_mode`, `supports_effort`,
//!    `supports_skills`, `supports_attachments`, `supports_fork`,
//!    `uses_claude_jsonl`, `supports_streaming`, `supports_resume`,
//!    `supports_model_selection`. Drive UI affordances and orchestrator
//!    branching. **Default to conservative (usually `false`)** and opt in
//!    per-agent.
//! 4. **Lifecycle + streaming protocol** — `extract_resume_id`,
//!    `defers_resume_id_until_turn_end`, `persists_across_turns`,
//!    `abort_strategy`, `encode_stream_user_message`, `encode_stream_interrupt`.
//!    Govern how the process is spawned, reused, and cancelled.
//!
//! ## Turn model
//!
//! An agent's process is either:
//!
//! - **One-shot per turn** (`persists_across_turns = false`, the default):
//!   `send_message` spawns a fresh CLI, writes the user message, reads
//!   stdout until `turn_end`, closes stdin, and lets the process exit.
//!   Follow-up messages respawn with `--resume`. This matches Codex, Cursor,
//!   Gemini, OpenCode.
//!
//! - **Persistent across turns** (`persists_across_turns = true`): the CLI
//!   is spawned once and kept alive. `send_message` on turn 2+ writes a new
//!   user message to the existing process's stdin via
//!   [`Agent::encode_stream_user_message`]. `abort_message` writes an
//!   interrupt control message via [`Agent::encode_stream_interrupt`]
//!   (if `abort_strategy = Interrupt`). `close_session`, `clear_session`,
//!   and app-exit must explicitly kill the process. This matches Claude.
//!
//! To opt a new agent into the persistent model:
//!
//! ```ignore
//! impl Agent for MyAgent {
//!     fn persists_across_turns(&self) -> bool { true }
//!     fn abort_strategy(&self) -> AbortStrategy { AbortStrategy::Interrupt }
//!     fn encode_stream_user_message(&self, msg: &str, atts: &[Attachment])
//!         -> Result<Vec<u8>, String> { /* newline-delimited stdin frame */ }
//!     fn encode_stream_interrupt(&self, request_id: &str)
//!         -> Result<Vec<u8>, String> { /* control frame */ }
//!     // ...
//! }
//! ```
//!
//! The orchestrator handles fast-path vs. spawn, abort dispatch, pre-warming,
//! and shutdown automatically. You only supply the wire format.
//!
//! ## Adding a brand-new agent
//!
//! 1. Create `agent/<name>.rs` with a unit struct and `impl Agent`.
//! 2. Add a variant to [`AgentKind`] and wire it into `parse`, `as_str`,
//!    `all`, and `implementation`.
//! 3. Add a `pub use <name>::MyAgent;` re-export at the top of this file.
//! 4. Add tests in the `tests` module at the bottom — the existing tests
//!    are a good template: args for each mode, resume-id extraction,
//!    capability flags.
//!
//! ## What NOT to do
//!
//! - Don't put orchestration logic (spawn, stream, abort, pre-warm) in
//!   agent impls — those belong in `task.rs` / `stream.rs`.
//! - Don't let agent-specific JSON shapes leak into the stream loop. Use
//!   `extract_resume_id` and the encoders.
//! - Don't add state to the agent struct. Impls are instantiated on demand
//!   via [`AgentKind::implementation`] and are expected to be zero-sized.

mod claude;
mod codex;
mod cursor;
mod gemini;
mod opencode;

use serde::{Deserialize, Serialize};
use std::path::Path;

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
// Agent skill / slash-command definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
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
// How an in-flight turn is cancelled
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbortStrategy {
    /// EOF → SIGTERM → SIGKILL. Process dies; next send respawns.
    Kill,
    /// Write an interrupt control message on stdin. Process stays alive and
    /// is ready for the next user message.
    Interrupt,
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

    /// If true, the captured resume id is only safe to persist after at least
    /// one turn completes. Codex emits `thread.started` with a thread_id at
    /// startup, but the rollout file is only written to disk once a turn
    /// completes — resuming before that fails with "no rollout found".
    fn defers_resume_id_until_turn_end(&self) -> bool {
        false
    }

    /// Whether the CLI's process is reused across multiple turns in a
    /// single session. When true:
    ///   - stdin stays open after `turn_end`
    ///   - `send_message` writes to the existing process instead of spawning
    ///   - the process can be pre-warmed before the first user message
    ///   - `close_session` / `clear_session` / app-exit must kill it explicitly
    fn persists_across_turns(&self) -> bool {
        false
    }

    /// How to cancel an in-flight turn. Meaningful only when
    /// `persists_across_turns()` is true — otherwise we always kill.
    fn abort_strategy(&self) -> AbortStrategy {
        AbortStrategy::Kill
    }

    /// Serialize a user message (with attachments) to bytes for writing to
    /// the CLI's stdin while it's already running. Called on every turn after
    /// the first for persistent agents.
    fn encode_stream_user_message(
        &self,
        _message: &str,
        _attachments: &[crate::task::Attachment],
    ) -> Result<Vec<u8>, String> {
        Err("agent does not support streaming user input".into())
    }

    /// Serialize an interrupt control message to stdin bytes. The caller
    /// supplies the request id so the same id can be correlated elsewhere.
    fn encode_stream_interrupt(&self, _request_id: &str) -> Result<Vec<u8>, String> {
        Err("agent does not support stream interrupt".into())
    }

    /// Serialize a `set_permission_mode` control request for persistent
    /// sessions. `mode` is the target mode ("default", "plan",
    /// "acceptEdits", "bypassPermissions"). Only needed when
    /// `persists_across_turns()` is true, since respawning naturally picks
    /// up the new mode from CLI args.
    fn encode_stream_set_permission_mode(
        &self,
        _request_id: &str,
        _mode: &str,
    ) -> Result<Vec<u8>, String> {
        Err("agent does not support set_permission_mode".into())
    }

    /// Serialize a `set_model` control request. `model = None` resets to
    /// the CLI's default. Only needed when `persists_across_turns()` is
    /// true.
    fn encode_stream_set_model(
        &self,
        _request_id: &str,
        _model: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        Err("agent does not support set_model".into())
    }

    /// Discover agent-specific skills/commands available in the given scan
    /// root (typically a repo root or worktree path) and the user's home
    /// directory. Returns empty by default; each agent that supports skills
    /// overrides this.
    fn discover_skills(
        &self,
        _scan_root: Option<&Path>,
        _user_home: &Path,
    ) -> Vec<AgentSkill> {
        Vec::new()
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
        // `-p` (print-and-exit mode) must NOT be present — we want the CLI to
        // stay alive reading stdin across turns, matching claude-agent-sdk-python.
        assert!(!args.contains(&"-p".to_string()));
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

    // ── Persistence + abort strategy + stream encoders ──────────────────

    #[test]
    fn claude_persists_across_turns() {
        assert!(Claude.persists_across_turns());
    }

    #[test]
    fn other_agents_do_not_persist() {
        assert!(!Codex.persists_across_turns());
        assert!(!Cursor.persists_across_turns());
        assert!(!Gemini.persists_across_turns());
        assert!(!OpenCode.persists_across_turns());
    }

    #[test]
    fn claude_abort_strategy_is_interrupt() {
        assert_eq!(Claude.abort_strategy(), AbortStrategy::Interrupt);
    }

    #[test]
    fn other_agents_abort_strategy_is_kill() {
        assert_eq!(Codex.abort_strategy(), AbortStrategy::Kill);
        assert_eq!(Cursor.abort_strategy(), AbortStrategy::Kill);
        assert_eq!(Gemini.abort_strategy(), AbortStrategy::Kill);
        assert_eq!(OpenCode.abort_strategy(), AbortStrategy::Kill);
    }

    #[test]
    fn claude_encodes_stream_user_message_as_newline_delimited_json() {
        let agent = Claude;
        let bytes = agent
            .encode_stream_user_message("hi there", &[])
            .expect("claude should encode");
        assert!(bytes.ends_with(b"\n"), "stream lines must be newline-delimited");
        let text = std::str::from_utf8(&bytes).expect("utf8");
        let v: serde_json::Value = serde_json::from_str(text.trim_end()).expect("valid json");
        assert_eq!(v["type"], "user");
        assert_eq!(v["session_id"], "");
        assert!(v["parent_tool_use_id"].is_null());
        assert_eq!(v["message"]["role"], "user");
        let content = v["message"]["content"].as_array().expect("content array");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "hi there");
    }

    #[test]
    fn claude_encodes_stream_user_message_with_attachments_before_text() {
        let agent = Claude;
        let att = crate::task::Attachment {
            name: "logo.png".into(),
            mime_type: "image/png".into(),
            data_base64: "abc123".into(),
        };
        let bytes = agent
            .encode_stream_user_message("look at this", std::slice::from_ref(&att))
            .expect("encode");
        let v: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["type"], "base64");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "abc123");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "look at this");
    }

    #[test]
    fn claude_encodes_stream_interrupt_as_control_request() {
        let agent = Claude;
        let bytes = agent.encode_stream_interrupt("req_abc").expect("encode");
        assert!(bytes.ends_with(b"\n"));
        let v: serde_json::Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_abc");
        assert_eq!(v["request"]["subtype"], "interrupt");
    }

    #[test]
    fn claude_encodes_set_permission_mode_plan() {
        let agent = Claude;
        let bytes = agent
            .encode_stream_set_permission_mode("req_1", "plan")
            .expect("encode");
        assert!(bytes.ends_with(b"\n"));
        let v: serde_json::Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_1");
        assert_eq!(v["request"]["subtype"], "set_permission_mode");
        assert_eq!(v["request"]["mode"], "plan");
    }

    #[test]
    fn claude_encodes_set_permission_mode_default() {
        let agent = Claude;
        let bytes = agent
            .encode_stream_set_permission_mode("req_2", "default")
            .expect("encode");
        let v: serde_json::Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json");
        assert_eq!(v["request"]["mode"], "default");
    }

    #[test]
    fn claude_encodes_set_model() {
        let agent = Claude;
        let bytes = agent
            .encode_stream_set_model("req_3", Some("claude-sonnet-4-6"))
            .expect("encode");
        assert!(bytes.ends_with(b"\n"));
        let v: serde_json::Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json");
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req_3");
        assert_eq!(v["request"]["subtype"], "set_model");
        assert_eq!(v["request"]["model"], "claude-sonnet-4-6");
    }

    #[test]
    fn claude_encodes_set_model_null_resets_to_default() {
        let agent = Claude;
        let bytes = agent
            .encode_stream_set_model("req_4", None)
            .expect("encode");
        let v: serde_json::Value =
            serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("json");
        assert!(v["request"]["model"].is_null());
    }

    #[test]
    fn other_agents_reject_stream_encoders_by_default() {
        for agent in [
            Box::new(Codex) as Box<dyn Agent>,
            Box::new(Cursor),
            Box::new(Gemini),
            Box::new(OpenCode),
        ] {
            assert!(agent.encode_stream_user_message("x", &[]).is_err());
            assert!(agent.encode_stream_interrupt("req_x").is_err());
            assert!(agent
                .encode_stream_set_permission_mode("req_x", "plan")
                .is_err());
            assert!(agent
                .encode_stream_set_model("req_x", Some("m"))
                .is_err());
        }
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
        assert!(agent.defers_resume_id_until_turn_end());
    }

    #[test]
    fn other_agents_do_not_defer_resume_id() {
        assert!(!Claude.defers_resume_id_until_turn_end());
        assert!(!Cursor.defers_resume_id_until_turn_end());
        assert!(!Gemini.defers_resume_id_until_turn_end());
        assert!(!OpenCode.defers_resume_id_until_turn_end());
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

    // ── Skill discovery defaults ────────────────────────────────────────

    #[test]
    fn non_claude_agents_discover_empty_skills_by_default() {
        let tmp = tempfile::TempDir::new().unwrap();
        for &kind in AgentKind::all() {
            if kind == AgentKind::Claude {
                continue;
            }
            let agent = kind.implementation();
            assert!(
                agent.discover_skills(None, tmp.path()).is_empty(),
                "{kind:?} should default to empty skills"
            );
        }
    }

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
