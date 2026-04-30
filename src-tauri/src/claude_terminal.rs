//! Run Claude Code inside a PTY and mirror its JSONL transcript into the
//! session output stream.
//!
//! When the user flips a Claude session into "terminal" view mode we spawn
//! `claude --resume <id>` in a real PTY so they interact with the unmodified
//! TUI. To keep our UI-backed views (history, fork, branch, search) intact we
//! tail the on-disk JSONL that Claude writes at
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and re-emit each
//! parsed message as an `OutputItem` through the existing `session-output`
//! event + `output_lines` DB table.
//!
//! Shape of a terminal session lifetime:
//!   open_claude_terminal -> spawn PTY + tail JSONL from current EOF
//!                          └─ tail forwards OutputItems -> emit + persist
//!   close_claude_terminal -> close PTY + drop tail (stops the poll loop)
//!
//! The PTY is managed by `crate::pty` (shared with shell/dev-server PTYs);
//! this module only owns the tail + mapping from session_id -> terminal_id.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use crate::claude_jsonl;
use crate::claude_transcript_tail::{spawn_transcript_tail, TranscriptTail};
use crate::db::{self, DbWrite, DbWriteTx};
use crate::pty::{self, ActivePtyMap};
use crate::stream::{self, OutputItem, SessionOutputEvent};
use uuid::Uuid;

/// Display name for the Claude PTY tab/tooltip.
const TERMINAL_DISPLAY_NAME: &str = "Claude Code";

pub struct ClaudeTerminalHandle {
    pub task_id: String,
    pub session_id: String,
    pub terminal_id: String,
    /// Drops to stop the transcript poll loop.
    _tail: Option<TranscriptTail>,
    /// Driver task that forwards OutputItems to the app event stream + DB.
    /// Owned here so we can abort it if needed.
    driver: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ClaudeTerminalHandle {
    fn drop(&mut self) {
        // Dropping `_tail` stops the file poll loop, which closes the mpsc
        // sender, which makes the driver task exit on its next recv. The
        // abort is a belt-and-braces safeguard in case the driver stalls.
        if let Some(d) = self.driver.take() {
            d.abort();
        }
    }
}

pub type ClaudeTerminalMap = Arc<DashMap<String, ClaudeTerminalHandle>>;

pub fn new_claude_terminal_map() -> ClaudeTerminalMap {
    Arc::new(DashMap::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClaudeTerminalResult {
    pub terminal_id: String,
    pub session_id: String,
}

/// Open a Claude Code PTY for the given session.
///
/// Fails if the session is not a Claude session or has never produced a
/// resumable id (i.e. the first turn never reached `system:init`). If a
/// terminal is already open for this session, returns the existing one.
#[allow(clippy::too_many_arguments)]
pub async fn open_claude_terminal(
    app: AppHandle,
    pool: &SqlitePool,
    app_data_dir: std::path::PathBuf,
    db_tx: DbWriteTx,
    pty_map: ActivePtyMap,
    ct_map: ClaudeTerminalMap,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<OpenClaudeTerminalResult, String> {
    // Drop a previously-open handle whose PTY has died (Ctrl+D, /exit, crash)
    // so we spawn a fresh one instead of returning an id that no longer works.
    drop_if_stale(&pty_map, &ct_map, &session_id);

    // If a terminal is already open for this session, return it as-is.
    if let Some(existing) = ct_map.get(&session_id) {
        return Ok(OpenClaudeTerminalResult {
            terminal_id: existing.terminal_id.clone(),
            session_id: existing.session_id.clone(),
        });
    }

    let validated = validate_session_for_terminal(pool, &session_id).await?;
    let task = validated.task;

    // Fresh session (no resume id yet): pre-generate a UUID, persist it as
    // the session's resume_session_id, and spawn `claude --session-id <uuid>`
    // so Claude creates the conversation with that id. Subsequent reopens
    // for the same session use the existing `--resume <uuid>` path.
    let (id, mode, is_fresh) = match validated.resume_id {
        Some(rid) => (rid, ClaudeSpawnMode::Resume, false),
        None => (Uuid::new_v4().to_string(), ClaudeSpawnMode::NewWithId, true),
    };

    let repo_path = db::get_repo_path_for_task(pool, &task.id).await?;
    let env_vars = crate::worktree::verun_env_vars(task.port_offset, &repo_path);

    let cwd_path = std::path::PathBuf::from(&task.worktree_path);
    let jsonl_path = claude_jsonl::session_path(&cwd_path, &id)
        .ok_or_else(|| "$HOME not set; cannot locate Claude transcript".to_string())?;

    // For resumes: skip whatever's already on disk (already in output_lines).
    // For fresh sessions: file doesn't exist yet; metadata fails and we get 0,
    // which is what we want - tail from byte 0 once Claude creates it.
    let start_offset = std::fs::metadata(&jsonl_path).map(|m| m.len()).unwrap_or(0);

    let command = build_claude_shell_command(mode, &id);
    let worktree_path = task.worktree_path.clone();
    let pty_map_clone = pty_map.clone();
    let app_for_pty = app.clone();
    let task_id_for_pty = task.id.clone();

    // Pre-trust this worktree in ~/.claude.json so the TUI doesn't prompt on
    // first spawn. Errors are non-fatal: at worst the user answers the
    // trust prompt once for this folder.
    if let Err(e) = pre_trust_worktree(&worktree_path).await {
        eprintln!("[verun][claude-terminal] pre_trust_worktree failed: {e}");
    }

    let spawn = tokio::task::spawn_blocking(move || {
        pty::spawn_pty(
            app_for_pty,
            pty_map_clone,
            task_id_for_pty,
            worktree_path,
            rows,
            cols,
            Some(command),
            env_vars,
            /* direct_command = */ true,
            Some(TERMINAL_DISPLAY_NAME.to_string()),
            /* is_start_command = */ false,
            None,
        )
    })
    .await
    .map_err(|e| format!("spawn_pty join: {e}"))??;

    // Persist the pre-generated id for fresh spawns so subsequent reopens
    // use the `--resume` path and the rest of the app (chat view, fork,
    // session-tab toggle) sees the session as having a resumable id.
    if is_fresh {
        let _ = db_tx
            .send(db::DbWrite::SetResumeSessionId {
                id: session_id.clone(),
                resume_session_id: id.clone(),
            })
            .await;
        let _ = app.emit(
            "session-resume-id",
            stream::SessionResumeIdEvent {
                session_id: session_id.clone(),
                resume_session_id: id.clone(),
            },
        );
    }

    let (item_tx, item_rx) = mpsc::unbounded_channel::<OutputItem>();
    let tail = spawn_transcript_tail(&jsonl_path, start_offset, item_tx);

    let driver_session_id = session_id.clone();
    let driver_app = app.clone();
    let driver_db_tx = db_tx.clone();
    let driver_pool = pool.clone();
    let driver_data_dir = app_data_dir.clone();
    let driver = tokio::spawn(async move {
        run_tail_driver(
            driver_app,
            driver_pool,
            driver_data_dir,
            driver_db_tx,
            driver_session_id,
            item_rx,
        )
        .await;
    });

    let handle = ClaudeTerminalHandle {
        task_id: task.id.clone(),
        session_id: session_id.clone(),
        terminal_id: spawn.terminal_id.clone(),
        _tail: Some(tail),
        driver: Some(driver),
    };
    ct_map.insert(session_id.clone(), handle);

    Ok(OpenClaudeTerminalResult {
        terminal_id: spawn.terminal_id,
        session_id,
    })
}

/// Close the Claude terminal for a session: kill the PTY child and stop the
/// transcript tailer. Idempotent.
pub async fn close_claude_terminal(
    pty_map: ActivePtyMap,
    ct_map: ClaudeTerminalMap,
    session_id: String,
) -> Result<(), String> {
    let terminal_id = ct_map.remove(&session_id).map(|(_, h)| h.terminal_id.clone());
    if let Some(tid) = terminal_id {
        tokio::task::spawn_blocking(move || pty::close_pty(&pty_map, &tid))
            .await
            .map_err(|e| format!("close_pty join: {e}"))??;
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct ValidatedTerminalSession {
    pub task: crate::db::Task,
    /// `Some(id)` if the session has been used before (use `--resume <id>`).
    /// `None` for a fresh session: the caller must generate a UUID and pass it
    /// via `--session-id <uuid>` so Claude creates the conversation with that
    /// id (which we then persist as the session's resume_session_id).
    pub resume_id: Option<String>,
}

/// Look up the session, ensure it's a Claude session, and return the task
/// it belongs to plus its existing resume id (if any). Pure DB validation
/// extracted from `open_claude_terminal` so the error paths can be unit-
/// tested without an `AppHandle`.
pub(crate) async fn validate_session_for_terminal(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<ValidatedTerminalSession, String> {
    let session = db::get_session(pool, session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    if session.agent_type != "claude" {
        return Err(format!(
            "Terminal mode is only available for Claude sessions (got {})",
            session.agent_type
        ));
    }

    let task = db::get_task(pool, &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;

    Ok(ValidatedTerminalSession {
        task,
        resume_id: session.resume_session_id.clone(),
    })
}

/// Build the JSON line we persist into `output_lines` for a batch of items
/// emitted by the transcript tailer. The shape matches `verun_items` synthetic
/// lines produced by the streaming agent path so the chat UI replays them
/// without changes.
pub(crate) fn verun_items_line(items: &[OutputItem]) -> String {
    serde_json::json!({ "type": "verun_items", "items": items }).to_string()
}

/// One persistable chunk of a tail batch. User-content items (UserMessage +
/// UserAttachment) are bundled into a `UserTurn` segment so they can persist
/// as a single `verun_user_message` line — matching the composer flow shape.
/// Everything else flows through `Other` and persists as `verun_items`.
#[derive(Debug)]
pub(crate) enum TailSegment {
    UserTurn {
        text: String,
        /// (mime, base64-encoded data) pairs, straight from the JSONL.
        attachments: Vec<(String, String)>,
    },
    Other(Vec<OutputItem>),
}

/// Walk a tail batch and group contiguous user-content items into
/// `TailSegment::UserTurn`, with everything else flowing into `Other`.
/// Multiple `UserMessage` blocks in the same content array are joined with
/// newlines so they remain a single user turn in persistence.
pub(crate) fn partition_tail_batch(items: &[OutputItem]) -> Vec<TailSegment> {
    let mut segments: Vec<TailSegment> = Vec::new();
    let mut user_text_parts: Vec<String> = Vec::new();
    let mut user_attachments: Vec<(String, String)> = Vec::new();
    let mut other: Vec<OutputItem> = Vec::new();
    let mut in_user_segment = false;

    let flush_user = |segments: &mut Vec<TailSegment>,
                      texts: &mut Vec<String>,
                      atts: &mut Vec<(String, String)>| {
        if texts.is_empty() && atts.is_empty() {
            return;
        }
        segments.push(TailSegment::UserTurn {
            text: std::mem::take(texts).join("\n"),
            attachments: std::mem::take(atts),
        });
    };

    let flush_other = |segments: &mut Vec<TailSegment>, other: &mut Vec<OutputItem>| {
        if other.is_empty() {
            return;
        }
        segments.push(TailSegment::Other(std::mem::take(other)));
    };

    for item in items {
        match item {
            OutputItem::UserMessage { text } => {
                if !in_user_segment {
                    flush_other(&mut segments, &mut other);
                    in_user_segment = true;
                }
                user_text_parts.push(text.clone());
            }
            OutputItem::UserAttachment { mime, data_b64 } => {
                if !in_user_segment {
                    flush_other(&mut segments, &mut other);
                    in_user_segment = true;
                }
                user_attachments.push((mime.clone(), data_b64.clone()));
            }
            other_item => {
                if in_user_segment {
                    flush_user(&mut segments, &mut user_text_parts, &mut user_attachments);
                    in_user_segment = false;
                }
                other.push(other_item.clone());
            }
        }
    }
    if in_user_segment {
        flush_user(&mut segments, &mut user_text_parts, &mut user_attachments);
    }
    flush_other(&mut segments, &mut other);
    segments
}

/// Strip `UserAttachment` items so the raw base64 payload never crosses the
/// IPC boundary. The frontend wouldn't render it anyway — it lazy-loads
/// resolved blob bytes via `get_blob(hash)` from the persisted `verun_user_message`.
pub(crate) fn live_items_for_emit(items: &[OutputItem]) -> Vec<OutputItem> {
    items
        .iter()
        .filter(|i| !matches!(i, OutputItem::UserAttachment { .. }))
        .cloned()
        .collect()
}

/// Convert a partitioned batch into JSON lines ready for `output_lines`.
/// User-turn segments write each attachment to the blob store and produce a
/// `verun_user_message` line carrying the resulting refs (matches the
/// composer flow exactly, so the chat UI's existing replay path works).
/// Attachments whose base64 fails to decode or whose blob write fails are
/// silently dropped — text persistence must not regress because of one bad
/// attachment.
pub(crate) async fn build_persist_lines(
    pool: &SqlitePool,
    app_data_dir: &std::path::Path,
    segments: Vec<TailSegment>,
) -> Vec<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut lines = Vec::with_capacity(segments.len());
    for seg in segments {
        match seg {
            TailSegment::UserTurn { text, attachments } => {
                let mut refs: Vec<serde_json::Value> = Vec::with_capacity(attachments.len());
                for (mime, data_b64) in attachments {
                    let bytes = match STANDARD.decode(data_b64.as_bytes()) {
                        Ok(b) => b,
                        Err(e) => {
                            eprintln!("[verun][claude-terminal] dropping attachment with bad base64: {e}");
                            continue;
                        }
                    };
                    match crate::blob::write_blob(pool, app_data_dir, &mime, &bytes).await {
                        Ok(blob_ref) => {
                            refs.push(serde_json::json!({
                                "hash": blob_ref.hash,
                                "mimeType": blob_ref.mime,
                                "name": "",
                                "size": blob_ref.size,
                            }));
                        }
                        Err(e) => {
                            eprintln!("[verun][claude-terminal] blob write failed: {e}");
                        }
                    }
                }
                lines.push(
                    serde_json::json!({
                        "type": "verun_user_message",
                        "text": text,
                        "attachments": refs,
                        "plan_mode": false,
                        "thinking_mode": false,
                        "fast_mode": false,
                    })
                    .to_string(),
                );
            }
            TailSegment::Other(items) => {
                lines.push(verun_items_line(&items));
            }
        }
    }
    lines
}

/// True when the handle's PTY is still live (present in the pty map). A `false`
/// means the Claude process has exited (or been killed) but our ct_map entry
/// wasn't cleaned up yet — the handle should be discarded and a fresh one
/// spawned before reuse.
fn is_handle_live(handle: &ClaudeTerminalHandle, pty_map: &ActivePtyMap) -> bool {
    pty_map.contains_key(&handle.terminal_id)
}

/// Remove a ct_map entry if its backing PTY is no longer live. Returns true
/// when an entry was dropped.
fn drop_if_stale(pty_map: &ActivePtyMap, ct_map: &ClaudeTerminalMap, session_id: &str) -> bool {
    let stale = ct_map
        .get(session_id)
        .map(|h| !is_handle_live(&h, pty_map))
        .unwrap_or(false);
    if stale {
        ct_map.remove(session_id);
    }
    stale
}

/// Called by task deletion: tear down any Claude terminals tied to the task
/// in one sweep. Drops the ct_map entries (which stops each tail + driver via
/// `ClaudeTerminalHandle::drop`) and then closes the task's PTYs.
pub fn close_all_for_task(pty_map: &ActivePtyMap, ct_map: &ClaudeTerminalMap, task_id: &str) {
    let to_drop: Vec<String> = ct_map
        .iter()
        .filter(|e| e.value().task_id == task_id)
        .map(|e| e.key().clone())
        .collect();
    for sid in to_drop {
        ct_map.remove(&sid);
    }
    pty::close_all_for_task(pty_map, task_id);
}

/// Pre-mark a worktree as trusted in `~/.claude.json` so the Claude TUI
/// doesn't prompt with the "Do you trust this folder?" dialog on first
/// spawn. Verun owns the worktree (we created it, we picked the branch,
/// we're the one running `claude` in it) so the dialog is pure friction.
///
/// Reads the existing config (or starts from `{}` if missing), merges in
/// `projects[<abs_path>].hasTrustDialogAccepted = true` plus
/// `hasCompletedProjectOnboarding = true` to skip the onboarding splash,
/// and writes atomically via temp + rename to avoid corrupting the file
/// if Claude crashes mid-write or another spawn races us. A module-level
/// mutex serializes our own concurrent merges.
///
/// Errors are non-fatal at the call site - if we can't pre-trust, the
/// user just sees the trust prompt once. Worth the extra robustness.
pub(crate) async fn pre_trust_worktree(worktree_path: &str) -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME env var not set".to_string())?;
    let config_path = home.join(".claude.json");
    pre_trust_worktree_at(&config_path, worktree_path).await
}

/// Test-friendly variant that accepts an explicit config path.
async fn pre_trust_worktree_at(config_path: &Path, worktree_path: &str) -> Result<(), String> {
    static MUTEX: Mutex<()> = Mutex::const_new(());
    let _guard = MUTEX.lock().await;

    let mut config: Value = match tokio::fs::read(config_path).await {
        Ok(bytes) if bytes.is_empty() => json!({}),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse {}: {e}", config_path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", config_path.display())),
    };

    let projects = config
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", config_path.display()))?
        .entry("projects")
        .or_insert_with(|| json!({}));
    let projects_obj = projects
        .as_object_mut()
        .ok_or_else(|| "`projects` is not a JSON object".to_string())?;

    let entry = projects_obj
        .entry(worktree_path.to_string())
        .or_insert_with(|| json!({}));
    let entry_obj = entry
        .as_object_mut()
        .ok_or_else(|| format!("`projects[{worktree_path}]` is not a JSON object"))?;

    // Idempotent: skip the disk write if both flags already match.
    if entry_obj.get("hasTrustDialogAccepted") == Some(&Value::Bool(true))
        && entry_obj.get("hasCompletedProjectOnboarding") == Some(&Value::Bool(true))
    {
        return Ok(());
    }

    entry_obj.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));
    entry_obj.insert("hasCompletedProjectOnboarding".to_string(), Value::Bool(true));

    let serialized = serde_json::to_vec_pretty(&config)
        .map_err(|e| format!("serialize claude config: {e}"))?;

    // Atomic write: temp file in the same directory, then rename. If something
    // crashes between write and rename, the user's existing config is intact.
    let dir = config_path
        .parent()
        .ok_or_else(|| format!("{} has no parent dir", config_path.display()))?;
    let tmp_path = dir.join(format!(".claude.json.verun-tmp.{}", std::process::id()));
    tokio::fs::write(&tmp_path, &serialized)
        .await
        .map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
    tokio::fs::rename(&tmp_path, config_path)
        .await
        .map_err(|e| format!("rename {} -> {}: {e}", tmp_path.display(), config_path.display()))?;

    Ok(())
}

/// Spawn-mode for the Claude PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaudeSpawnMode {
    /// Existing session - pass `--resume <id>`.
    Resume,
    /// Fresh session - pass `--session-id <uuid>` so Claude creates the
    /// conversation with the id we pre-generated (which we've already
    /// persisted as the session's resume_session_id).
    NewWithId,
}

/// Build the shell command passed to `sh -lic "<cmd>"` that spawns Claude.
/// `exec` ensures the PTY dies with Claude instead of dropping to a login
/// shell prompt when the user exits with Ctrl+D.
pub(crate) fn build_claude_shell_command(mode: ClaudeSpawnMode, id: &str) -> String {
    let flag = match mode {
        ClaudeSpawnMode::Resume => "--resume",
        ClaudeSpawnMode::NewWithId => "--session-id",
    };
    format!("exec claude {flag} {}", shell_quote(id))
}


/// Minimal POSIX single-quote wrapping. Single-quotes inside the input are
/// replaced with `'\''` (close quote, escaped quote, open quote).
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

async fn run_tail_driver(
    app: AppHandle,
    pool: SqlitePool,
    app_data_dir: std::path::PathBuf,
    db_tx: DbWriteTx,
    session_id: String,
    mut rx: mpsc::UnboundedReceiver<OutputItem>,
) {
    // Batch items that arrive in the same poll tick into a single emit+write
    // to cut down on event overhead and DB round-trips.
    loop {
        let first = match rx.recv().await {
            Some(item) => item,
            None => return,
        };
        let mut items = vec![first];
        while let Ok(next) = rx.try_recv() {
            items.push(next);
        }

        // The live event drops `UserAttachment` items so the raw base64
        // payload doesn't traverse IPC. The chat UI lazy-loads bytes through
        // the blob store off the persisted `verun_user_message` line.
        let live = live_items_for_emit(&items);
        if !live.is_empty() {
            let _ = app.emit(
                "session-output",
                SessionOutputEvent {
                    session_id: session_id.clone(),
                    items: live,
                },
            );
        }

        let segments = partition_tail_batch(&items);
        let lines = build_persist_lines(&pool, &app_data_dir, segments).await;
        if lines.is_empty() {
            continue;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let timestamped: Vec<(String, i64)> = lines.into_iter().map(|l| (l, now)).collect();
        let _ = db_tx.try_send(DbWrite::InsertOutputLines {
            session_id: session_id.clone(),
            lines: timestamped,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_plain_value_in_single_quotes() {
        assert_eq!(shell_quote("abc"), "'abc'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quote() {
        // POSIX has no way to escape a single quote inside single quotes, so
        // we close-escape-open: 'it'\''s'
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_quote_passes_through_uuid_like_ids() {
        let id = "43454de0-e7f0-46bf-a971-4c234fc102fc";
        assert_eq!(shell_quote(id), format!("'{id}'"));
    }

    #[test]
    fn build_claude_shell_command_quotes_weird_ids_for_resume() {
        // A future CLI might accept ids with shell metachars; the quoting
        // must neutralise them even though today's UUIDs don't need it.
        let cmd = build_claude_shell_command(ClaudeSpawnMode::Resume, "$(rm -rf /)");
        assert_eq!(cmd, "exec claude --resume '$(rm -rf /)'");
    }

    #[tokio::test]
    async fn pre_trust_creates_config_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        assert!(!config.exists());

        pre_trust_worktree_at(&config, "/repo/wt").await.unwrap();

        let v: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(v["projects"]["/repo/wt"]["hasTrustDialogAccepted"], true);
        assert_eq!(v["projects"]["/repo/wt"]["hasCompletedProjectOnboarding"], true);
    }

    #[tokio::test]
    async fn pre_trust_preserves_existing_top_level_fields() {
        // Claude stores user prefs, MCP servers, history pointers etc. at the
        // top level alongside `projects`. Clobbering the file would nuke all
        // of that. Lock in that we only touch the entry we care about.
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        let starting = json!({
            "userId": "u-1",
            "mcpServers": { "github": { "command": "gh" } },
            "projects": {
                "/repo/wt": { "allowedTools": ["bash"], "projectOnboardingSeenCount": 1 }
            }
        });
        std::fs::write(&config, serde_json::to_vec_pretty(&starting).unwrap()).unwrap();

        pre_trust_worktree_at(&config, "/repo/wt").await.unwrap();

        let v: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(v["userId"], "u-1");
        assert_eq!(v["mcpServers"]["github"]["command"], "gh");
        assert_eq!(v["projects"]["/repo/wt"]["allowedTools"], json!(["bash"]));
        assert_eq!(v["projects"]["/repo/wt"]["projectOnboardingSeenCount"], 1);
        assert_eq!(v["projects"]["/repo/wt"]["hasTrustDialogAccepted"], true);
        assert_eq!(v["projects"]["/repo/wt"]["hasCompletedProjectOnboarding"], true);
    }

    #[tokio::test]
    async fn pre_trust_adds_new_project_without_touching_others() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        let starting = json!({
            "projects": {
                "/repo/other": { "hasTrustDialogAccepted": true, "allowedTools": ["bash"] }
            }
        });
        std::fs::write(&config, serde_json::to_vec_pretty(&starting).unwrap()).unwrap();

        pre_trust_worktree_at(&config, "/repo/wt").await.unwrap();

        let v: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        assert_eq!(v["projects"]["/repo/other"]["allowedTools"], json!(["bash"]));
        assert_eq!(v["projects"]["/repo/wt"]["hasTrustDialogAccepted"], true);
    }

    #[tokio::test]
    async fn pre_trust_is_idempotent_when_flags_already_set() {
        // Skipping the disk write when there's nothing to change avoids
        // racing with a live Claude process for the same project.
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        let starting = json!({
            "projects": {
                "/repo/wt": {
                    "hasTrustDialogAccepted": true,
                    "hasCompletedProjectOnboarding": true,
                }
            }
        });
        std::fs::write(&config, serde_json::to_vec_pretty(&starting).unwrap()).unwrap();
        let mtime_before = std::fs::metadata(&config).unwrap().modified().unwrap();

        // Tiny sleep so a write would produce a different mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        pre_trust_worktree_at(&config, "/repo/wt").await.unwrap();

        let mtime_after = std::fs::metadata(&config).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "should be a no-op when already trusted");
    }

    #[tokio::test]
    async fn pre_trust_handles_corrupt_existing_file() {
        // We refuse to clobber a file we can't parse - safer to surface the
        // error and let the user keep their settings than to wipe them.
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(".claude.json");
        std::fs::write(&config, b"not json").unwrap();

        let err = pre_trust_worktree_at(&config, "/repo/wt").await.unwrap_err();
        assert!(err.contains("parse"));
    }

    fn test_handle(task_id: &str, session_id: &str, terminal_id: &str) -> ClaudeTerminalHandle {
        ClaudeTerminalHandle {
            task_id: task_id.to_string(),
            session_id: session_id.to_string(),
            terminal_id: terminal_id.to_string(),
            _tail: None,
            driver: None,
        }
    }

    #[test]
    fn close_all_for_task_drops_only_matching_task_entries() {
        let pty_map = pty::new_active_pty_map();
        let ct_map = new_claude_terminal_map();
        ct_map.insert("s-a".to_string(), test_handle("t-1", "s-a", "term-a"));
        ct_map.insert("s-b".to_string(), test_handle("t-1", "s-b", "term-b"));
        ct_map.insert("s-c".to_string(), test_handle("t-2", "s-c", "term-c"));

        close_all_for_task(&pty_map, &ct_map, "t-1");

        assert!(ct_map.get("s-a").is_none(), "handle for t-1/s-a should be dropped");
        assert!(ct_map.get("s-b").is_none(), "handle for t-1/s-b should be dropped");
        assert!(ct_map.get("s-c").is_some(), "handle for t-2/s-c must survive");
    }

    #[test]
    fn close_all_for_task_noop_when_no_matching_entries() {
        let pty_map = pty::new_active_pty_map();
        let ct_map = new_claude_terminal_map();
        ct_map.insert("s-x".to_string(), test_handle("t-other", "s-x", "term-x"));

        close_all_for_task(&pty_map, &ct_map, "t-missing");

        assert!(ct_map.get("s-x").is_some());
    }

    #[test]
    fn is_handle_live_false_when_pty_gone() {
        let pty_map = pty::new_active_pty_map();
        let handle = test_handle("t-1", "s-1", "term-dead");
        // pty_map is empty, so the handle's PTY is not live
        assert!(!is_handle_live(&handle, &pty_map));
    }

    #[test]
    fn drop_if_stale_removes_entry_when_pty_missing() {
        let pty_map = pty::new_active_pty_map();
        let ct_map = new_claude_terminal_map();
        ct_map.insert("s-1".to_string(), test_handle("t-1", "s-1", "term-dead"));

        let dropped = drop_if_stale(&pty_map, &ct_map, "s-1");

        assert!(dropped, "stale entry should be reported as dropped");
        assert!(ct_map.get("s-1").is_none());
    }

    #[test]
    fn drop_if_stale_is_noop_for_missing_session() {
        let pty_map = pty::new_active_pty_map();
        let ct_map = new_claude_terminal_map();
        assert!(!drop_if_stale(&pty_map, &ct_map, "s-none"));
    }

    // ---------------------- verun_items_line ---------------------------

    #[test]
    fn verun_items_line_wraps_in_synthetic_envelope() {
        let items = vec![OutputItem::Text { text: "hi".into() }];
        let line = verun_items_line(&items);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "verun_items");
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["kind"], "text");
        assert_eq!(v["items"][0]["text"], "hi");
    }

    #[test]
    fn verun_items_line_handles_empty_batch() {
        let line = verun_items_line(&[]);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "verun_items");
        assert!(v["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn verun_items_line_serializes_multiple_kinds_in_order() {
        let items = vec![
            OutputItem::Text { text: "first".into() },
            OutputItem::Thinking { text: "thought".into() },
            OutputItem::ToolStart { tool: "Read".into(), input: "{}".into() },
        ];
        let line = verun_items_line(&items);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let arr = v["items"].as_array().unwrap();
        assert_eq!(arr[0]["kind"], "text");
        assert_eq!(arr[1]["kind"], "thinking");
        assert_eq!(arr[2]["kind"], "toolStart");
        assert_eq!(arr[2]["tool"], "Read");
    }

    // ---------------------- validate_session_for_terminal -------------------
    //
    // Exercises every error path that does not require a live AppHandle. The
    // happy path is also covered so we know the validator doesn't reject a
    // perfectly good session.

    use crate::db::tests::{make_project, make_session, make_task, process_write_for_tests, test_pool};
    use crate::db::DbWrite;

    #[tokio::test]
    async fn validate_session_for_terminal_errors_when_session_missing() {
        let pool = test_pool().await;
        let err = validate_session_for_terminal(&pool, "s-none").await.unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn validate_session_for_terminal_rejects_non_claude_agent() {
        let pool = test_pool().await;
        process_write_for_tests(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write_for_tests(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        let mut s = make_session("t-001");
        s.agent_type = "codex".into();
        s.resume_session_id = Some("r-1".into());
        process_write_for_tests(&pool, DbWrite::CreateSession(s)).await.unwrap();

        let err = validate_session_for_terminal(&pool, "s-001").await.unwrap_err();
        assert!(err.contains("Claude sessions"), "got: {err}");
        assert!(err.contains("codex"), "should name the actual agent: {err}");
    }

    #[tokio::test]
    async fn validate_session_for_terminal_returns_none_resume_id_for_fresh_session() {
        // Fresh sessions (resume_session_id = None) are valid - the caller
        // generates a UUID and spawns `claude --session-id <uuid>`. The
        // validator just shouldn't reject them.
        let pool = test_pool().await;
        process_write_for_tests(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write_for_tests(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        // make_session leaves resume_session_id = None
        process_write_for_tests(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let validated = validate_session_for_terminal(&pool, "s-001").await.unwrap();
        assert_eq!(validated.task.id, "t-001");
        assert_eq!(validated.resume_id, None);
    }

    #[tokio::test]
    async fn validate_session_for_terminal_returns_task_and_resume_id_for_valid_session() {
        let pool = test_pool().await;
        process_write_for_tests(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write_for_tests(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        let mut s = make_session("t-001");
        s.resume_session_id = Some("resume-uuid-abc".into());
        process_write_for_tests(&pool, DbWrite::CreateSession(s)).await.unwrap();

        let validated = validate_session_for_terminal(&pool, "s-001").await.unwrap();
        assert_eq!(validated.task.id, "t-001");
        assert_eq!(validated.resume_id, Some("resume-uuid-abc".into()));
    }

    #[test]
    fn build_claude_shell_command_uses_session_id_flag_for_fresh_spawns() {
        // Fresh sessions: pass the pre-generated UUID via `--session-id` so
        // Claude creates the conversation with our id (no `--resume`, which
        // would error on a non-existent session).
        let cmd = build_claude_shell_command(ClaudeSpawnMode::NewWithId, "abc-123");
        assert_eq!(cmd, "exec claude --session-id 'abc-123'");
    }

    #[test]
    fn build_claude_shell_command_uses_resume_flag_for_existing_sessions() {
        let cmd = build_claude_shell_command(ClaudeSpawnMode::Resume, "abc-123");
        assert_eq!(cmd, "exec claude --resume 'abc-123'");
    }

    // ---------------------- attachment plumbing ---------------------------
    //
    // The transcript tailer surfaces pasted images as `OutputItem::UserAttachment`
    // items adjacent to the `UserMessage`. The driver's job is to:
    //   1. Split a batch into "user-turn" segments (text + attachments) vs
    //      "other" segments (text/thinking/tool_*) preserving order.
    //   2. Write each attachment to the blob store, producing an `AttachmentRef`.
    //   3. Persist user-turn segments as `verun_user_message` lines (matches
    //      composer flow), and other segments as `verun_items` lines.
    //   4. Filter `UserAttachment` items out of the live event payload so the
    //      raw base64 doesn't traverse IPC.

    #[test]
    fn partition_tail_batch_groups_user_content_into_a_single_segment() {
        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: "AAAA".into() },
            OutputItem::UserMessage { text: "look".into() },
            OutputItem::Text { text: "ok".into() },
            OutputItem::ToolStart { tool: "Read".into(), input: "{}".into() },
        ];
        let segs = partition_tail_batch(&items);
        assert_eq!(segs.len(), 2, "segments: {segs:?}");
        match &segs[0] {
            TailSegment::UserTurn { text, attachments } => {
                assert_eq!(text, "look");
                assert_eq!(attachments.len(), 1);
                assert_eq!(attachments[0].0, "image/png");
                assert_eq!(attachments[0].1, "AAAA");
            }
            other => panic!("expected UserTurn, got {other:?}"),
        }
        match &segs[1] {
            TailSegment::Other(its) => {
                assert_eq!(its.len(), 2);
                assert!(matches!(its[0], OutputItem::Text { .. }));
                assert!(matches!(its[1], OutputItem::ToolStart { .. }));
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[test]
    fn partition_tail_batch_text_only_user_segment_yields_no_attachments() {
        // A batch with just a UserMessage (no UserAttachment) is still a
        // user-turn segment so persistence routes through verun_user_message.
        // Doing this consistently avoids two parallel persistence shapes.
        let items = vec![OutputItem::UserMessage { text: "hi".into() }];
        let segs = partition_tail_batch(&items);
        assert_eq!(segs.len(), 1);
        match &segs[0] {
            TailSegment::UserTurn { text, attachments } => {
                assert_eq!(text, "hi");
                assert!(attachments.is_empty());
            }
            other => panic!("expected UserTurn, got {other:?}"),
        }
    }

    #[test]
    fn partition_tail_batch_attachment_only_yields_user_segment_with_empty_text() {
        // Image-only paste — text is empty, attachments populated.
        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: "AAAA".into() },
        ];
        let segs = partition_tail_batch(&items);
        assert_eq!(segs.len(), 1);
        match &segs[0] {
            TailSegment::UserTurn { text, attachments } => {
                assert_eq!(text, "");
                assert_eq!(attachments.len(), 1);
            }
            other => panic!("expected UserTurn, got {other:?}"),
        }
    }

    #[test]
    fn partition_tail_batch_two_user_turns_become_two_segments() {
        // If a tick captures two distinct user turns separated by an
        // assistant chunk, each should be its own segment.
        let items = vec![
            OutputItem::UserMessage { text: "first".into() },
            OutputItem::Text { text: "reply".into() },
            OutputItem::UserMessage { text: "second".into() },
        ];
        let segs = partition_tail_batch(&items);
        assert_eq!(segs.len(), 3);
        assert!(matches!(&segs[0], TailSegment::UserTurn { text, .. } if text == "first"));
        assert!(matches!(&segs[1], TailSegment::Other(_)));
        assert!(matches!(&segs[2], TailSegment::UserTurn { text, .. } if text == "second"));
    }

    #[test]
    fn partition_tail_batch_concatenates_multiple_user_text_blocks_with_newlines() {
        // Claude can emit multiple text blocks in a single user content array;
        // keep them in one verun_user_message line by joining with newlines.
        let items = vec![
            OutputItem::UserMessage { text: "one".into() },
            OutputItem::UserMessage { text: "two".into() },
        ];
        let segs = partition_tail_batch(&items);
        assert_eq!(segs.len(), 1);
        match &segs[0] {
            TailSegment::UserTurn { text, .. } => assert_eq!(text, "one\ntwo"),
            other => panic!("expected UserTurn, got {other:?}"),
        }
    }

    #[test]
    fn live_items_for_emit_filters_user_attachments() {
        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: "AAAA".into() },
            OutputItem::UserMessage { text: "hi".into() },
            OutputItem::Text { text: "ok".into() },
        ];
        let live = live_items_for_emit(&items);
        assert_eq!(live.len(), 2);
        assert!(matches!(live[0], OutputItem::UserMessage { .. }));
        assert!(matches!(live[1], OutputItem::Text { .. }));
    }

    #[tokio::test]
    async fn process_tail_batch_writes_blob_and_emits_verun_user_message_with_attachment_ref() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"PNGFAKE-bytes-for-test";
        let data_b64 = STANDARD.encode(bytes);

        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: data_b64.clone() },
            OutputItem::UserMessage { text: "look at this".into() },
        ];

        let lines = build_persist_lines(&pool, dir.path(), partition_tail_batch(&items)).await;
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["type"], "verun_user_message");
        assert_eq!(v["text"], "look at this");
        let atts = v["attachments"].as_array().unwrap();
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["mimeType"], "image/png");
        assert_eq!(atts[0]["size"].as_i64().unwrap(), bytes.len() as i64);
        assert_eq!(atts[0]["name"], "");
        let hash = atts[0]["hash"].as_str().unwrap();
        assert_eq!(hash.len(), 64, "sha256 hex");

        // Bytes are now in the blob store under the expected hash.
        let stored = crate::blob::read_blob_bytes(dir.path(), hash).await.unwrap();
        assert_eq!(stored, bytes);
    }

    #[tokio::test]
    async fn process_tail_batch_skips_attachments_with_invalid_base64() {
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: "not!!base64".into() },
            OutputItem::UserMessage { text: "still text".into() },
        ];
        let lines = build_persist_lines(&pool, dir.path(), partition_tail_batch(&items)).await;
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["type"], "verun_user_message");
        assert_eq!(v["text"], "still text");
        // Bad base64 is dropped; text still persists.
        assert!(v["attachments"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn process_tail_batch_emits_verun_items_for_other_segments() {
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let items = vec![
            OutputItem::Text { text: "hello".into() },
            OutputItem::ToolStart { tool: "Read".into(), input: "{}".into() },
        ];
        let lines = build_persist_lines(&pool, dir.path(), partition_tail_batch(&items)).await;
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["type"], "verun_items");
        let arr = v["items"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["kind"], "text");
        assert_eq!(arr[1]["kind"], "toolStart");
    }

    #[tokio::test]
    async fn process_tail_batch_mixed_batch_yields_two_lines_in_order() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let pool = test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let png_b64 = STANDARD.encode(b"img");
        let items = vec![
            OutputItem::UserAttachment { mime: "image/png".into(), data_b64: png_b64 },
            OutputItem::UserMessage { text: "what's this".into() },
            OutputItem::Text { text: "an image".into() },
        ];
        let lines = build_persist_lines(&pool, dir.path(), partition_tail_batch(&items)).await;
        assert_eq!(lines.len(), 2);
        let user: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        let other: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(user["type"], "verun_user_message");
        assert_eq!(user["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(other["type"], "verun_items");
        assert_eq!(other["items"][0]["kind"], "text");
    }

    #[tokio::test]
    async fn validate_session_for_terminal_errors_when_task_missing() {
        // Force a session whose task_id does not exist. The DB schema would
        // normally prevent this via FK; we disable FKs on the same connection
        // and insert a session pointing at a non-existent task to exercise the
        // validator's own task-lookup error path.
        let pool = test_pool().await;
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions(id, task_id, name, resume_session_id, status, started_at, ended_at, total_cost, parent_session_id, forked_at_message_uuid, agent_type, model, closed_at) \
             VALUES('s-orphan', 't-missing', NULL, 'r-1', 'idle', 0, NULL, 0.0, NULL, NULL, 'claude', NULL, NULL)",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        drop(conn);

        let err = validate_session_for_terminal(&pool, "s-orphan").await.unwrap_err();
        assert!(err.contains("Task t-missing not found"), "got: {err}");
    }
}
