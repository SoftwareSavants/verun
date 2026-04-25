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

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::claude_jsonl;
use crate::claude_transcript_tail::{spawn_transcript_tail, TranscriptTail};
use crate::db::{self, DbWrite, DbWriteTx};
use crate::pty::{self, ActivePtyMap};
use crate::stream::{OutputItem, SessionOutputEvent};

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
    let resume_id = validated.resume_id;

    let repo_path = db::get_repo_path_for_task(pool, &task.id).await?;
    let env_vars = crate::worktree::verun_env_vars(task.port_offset, &repo_path);

    let cwd_path = std::path::PathBuf::from(&task.worktree_path);
    let jsonl_path = claude_jsonl::session_path(&cwd_path, &resume_id)
        .ok_or_else(|| "$HOME not set; cannot locate Claude transcript".to_string())?;

    // We only want NEW JSONL lines added while this PTY is alive. Everything
    // already in the file is already in our output_lines from the previous
    // streamed run.
    let start_offset = std::fs::metadata(&jsonl_path).map(|m| m.len()).unwrap_or(0);

    let command = build_claude_resume_shell_command(&resume_id);
    let worktree_path = task.worktree_path.clone();
    let pty_map_clone = pty_map.clone();
    let app_for_pty = app.clone();
    let task_id_for_pty = task.id.clone();

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

    let (item_tx, item_rx) = mpsc::unbounded_channel::<OutputItem>();
    let tail = spawn_transcript_tail(&jsonl_path, start_offset, item_tx);

    let driver_session_id = session_id.clone();
    let driver_app = app.clone();
    let driver_db_tx = db_tx.clone();
    let driver = tokio::spawn(async move {
        run_tail_driver(driver_app, driver_db_tx, driver_session_id, item_rx).await;
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
    pub resume_id: String,
}

/// Look up the session, ensure it's a Claude session that has reached
/// `system:init` (so `claude --resume <id>` will work), and return the task
/// it belongs to. Pure DB validation extracted from `open_claude_terminal`
/// so the error paths can be unit-tested without an `AppHandle`.
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

    let resume_id = session
        .resume_session_id
        .clone()
        .ok_or_else(|| "Session has no resumable id yet - send a message first".to_string())?;

    let task = db::get_task(pool, &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;

    Ok(ValidatedTerminalSession { task, resume_id })
}

/// Build the JSON line we persist into `output_lines` for a batch of items
/// emitted by the transcript tailer. The shape matches `verun_items` synthetic
/// lines produced by the streaming agent path so the chat UI replays them
/// without changes.
pub(crate) fn verun_items_line(items: &[OutputItem]) -> String {
    serde_json::json!({ "type": "verun_items", "items": items }).to_string()
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

/// Build the shell command passed to `sh -lic "<cmd>"` that spawns Claude.
/// `exec` ensures the PTY dies with Claude instead of dropping to a login
/// shell prompt when the user exits with Ctrl+D.
pub(crate) fn build_claude_resume_shell_command(resume_session_id: &str) -> String {
    // resume_session_id is always a UUID we generated or received from the
    // Claude CLI; hex+dashes only. Still, defensively quote in case a future
    // CLI version widens the id shape.
    format!("exec claude --resume {}", shell_quote(resume_session_id))
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
        let _ = app.emit(
            "session-output",
            SessionOutputEvent {
                session_id: session_id.clone(),
                items: items.clone(),
            },
        );
        let line = verun_items_line(&items);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let _ = db_tx.try_send(DbWrite::InsertOutputLines {
            session_id: session_id.clone(),
            lines: vec![(line, now)],
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
    fn build_claude_resume_shell_command_execs_claude_resume() {
        let cmd = build_claude_resume_shell_command("abc-123");
        assert_eq!(cmd, "exec claude --resume 'abc-123'");
    }

    #[test]
    fn build_claude_resume_shell_command_quotes_weird_ids() {
        // A future CLI might accept ids with shell metachars; the quoting
        // must neutralise them even though today's UUIDs don't need it.
        let cmd = build_claude_resume_shell_command("$(rm -rf /)");
        assert_eq!(cmd, "exec claude --resume '$(rm -rf /)'");
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
    async fn validate_session_for_terminal_rejects_session_without_resume_id() {
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

        let err = validate_session_for_terminal(&pool, "s-001").await.unwrap_err();
        assert!(err.contains("resumable id"), "got: {err}");
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
        assert_eq!(validated.resume_id, "resume-uuid-abc");
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
