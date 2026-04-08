use crate::db::{self, DbWriteTx, Session, Task};
use crate::policy::TrustLevel;
use crate::stream;
use crate::worktree;
use dashmap::DashMap;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Funny branch name generator
// ---------------------------------------------------------------------------

const ADJECTIVES: &[&str] = &[
    "sleepy", "bouncy", "fuzzy", "sneaky", "grumpy", "silly", "wobbly", "zappy",
    "cranky", "spooky", "fluffy", "dizzy", "rusty", "jazzy", "lucky", "witty",
    "peppy", "quirky", "zippy", "snappy", "wacky", "goofy", "funky", "jumpy",
];

const ANIMALS: &[&str] = &[
    "penguin", "capybara", "otter", "raccoon", "platypus", "axolotl", "quokka",
    "narwhal", "armadillo", "chinchilla", "flamingo", "lemur", "pangolin", "wombat",
    "gecko", "puffin", "sloth", "toucan", "hedgehog", "chameleon", "koala", "walrus",
    "dingo", "ferret",
];

pub fn funny_branch_name() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;

    let mut hasher = DefaultHasher::new();
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .hash(&mut hasher);
    let h = hasher.finish();

    let adj = ADJECTIVES[(h as usize) % ADJECTIVES.len()];
    let animal = ANIMALS[((h >> 16) as usize) % ANIMALS.len()];
    let num = (h >> 32) % 1000;

    format!("{adj}-{animal}-{num}")
}

// ---------------------------------------------------------------------------
// Active process tracking — only sessions currently processing a message
// ---------------------------------------------------------------------------

pub struct ActiveProcess {
    pub child: Child,
    /// Kept alive so `stream_and_capture` can write control_response messages via the Arc clone.
    /// Inner Option is `take()`n on turn end to close the fd and let the process exit.
    #[allow(dead_code)]
    pub stdin: Arc<TokioMutex<Option<ChildStdin>>>,
}

/// session_id → currently running claude process (only while processing a message)
pub type ActiveMap = Arc<DashMap<String, ActiveProcess>>;

pub fn new_active_map() -> ActiveMap {
    Arc::new(DashMap::new())
}

pub fn get_active_session_ids(active: &ActiveMap) -> Vec<String> {
    active.iter().map(|e| e.key().clone()).collect()
}

// ---------------------------------------------------------------------------
// Pending tool approval requests
// ---------------------------------------------------------------------------

/// Response from the frontend for a tool approval request.
/// For normal tools: behavior is "allow" or "deny".
/// For AskUserQuestion: behavior is "allow" and updated_input contains the answers.
pub struct ApprovalResponse {
    pub behavior: String,
    pub updated_input: Option<serde_json::Value>,
}

/// Stored metadata for a pending approval so it can be re-emitted on frontend reload
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalEntry {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
}

/// request_id → oneshot sender waiting for user's approval decision
pub type PendingApprovals = Arc<DashMap<String, oneshot::Sender<ApprovalResponse>>>;
/// request_id → metadata for re-emitting on frontend reload
pub type PendingApprovalMeta = Arc<DashMap<String, PendingApprovalEntry>>;

pub fn new_pending_approvals() -> PendingApprovals {
    Arc::new(DashMap::new())
}

pub fn new_pending_approval_meta() -> PendingApprovalMeta {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

pub async fn create_task(
    db_tx: &DbWriteTx,
    project_id: String,
    repo_path: String,
    base_branch: String,
) -> Result<(Task, Session), String> {
    let id = Uuid::new_v4().to_string();
    let branch = funny_branch_name();
    let now = epoch_ms();

    let worktree_path = {
        let rp = repo_path.clone();
        let br = branch.clone();
        let bb = base_branch;
        tokio::task::spawn_blocking(move || worktree::create_worktree(&rp, &br, &bb))
            .await
            .map_err(|e| format!("Join error: {e}"))?
    }?;

    let task = Task {
        id,
        project_id,
        name: None,
        worktree_path,
        branch,
        created_at: now,
    };

    db_tx
        .send(db::DbWrite::InsertTask(task.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Auto-create the first session
    let session = create_session(db_tx, task.id.clone()).await?;

    Ok((task, session))
}

pub async fn delete_task(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    repo_path: &str,
    task: &Task,
) -> Result<(), String> {
    // Kill any active processes for this task's sessions
    let keys: Vec<String> = active.iter().map(|e| e.key().clone()).collect();
    for sid in keys {
        abort_message(app, db_tx, active, &sid).await?;
    }

    // Close any PTY terminals for this task
    if let Some(pty_map) = app.try_state::<crate::pty::ActivePtyMap>() {
        let task_id = task.id.clone();
        let map = pty_map.inner().clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::pty::close_all_for_task(&map, &task_id);
        })
        .await;
    }

    let rp = repo_path.to_string();
    let wtp = task.worktree_path.clone();
    let _ = tokio::task::spawn_blocking(move || worktree::delete_worktree(&rp, &wtp)).await;

    db_tx
        .send(db::DbWrite::DeleteTask { id: task.id.clone() })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/// Create a new session record (no process spawned yet — that happens on send_message)
pub async fn create_session(db_tx: &DbWriteTx, task_id: String) -> Result<Session, String> {
    let session = Session {
        id: Uuid::new_v4().to_string(),
        task_id,
        name: None,
        claude_session_id: None,
        status: "idle".to_string(),
        started_at: epoch_ms(),
        ended_at: None,
    };

    db_tx
        .send(db::DbWrite::CreateSession(session.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(session)
}

/// A file attachment (base64-encoded data from the frontend)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

/// Parameters for sending a message to Claude
pub struct SendMessageParams {
    pub session_id: String,
    pub task_id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub trust_level: TrustLevel,
    pub message: String,
    pub claude_session_id: Option<String>,
    pub attachments: Vec<Attachment>,
    pub model: Option<String>,
    pub plan_mode: bool,
    pub thinking_mode: bool,
    pub fast_mode: bool,
}

/// Send a message to Claude in this session's worktree.
/// Always uses `--input-format stream-json` and pipes content via stdin, keeping stdin
/// open so we can write `control_response` messages for tool approval.
pub async fn send_message(
    app: AppHandle,
    db_tx: &DbWriteTx,
    active: ActiveMap,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    params: SendMessageParams,
) -> Result<(), String> {
    let SendMessageParams { session_id, task_id, worktree_path, repo_path, trust_level, message, claude_session_id, attachments, model, plan_mode, thinking_mode, fast_mode } = params;
    // Don't allow concurrent messages on the same session
    if active.contains_key(&session_id) {
        return Err("Session is already processing a message".to_string());
    }

    let is_first_turn = claude_session_id.as_ref().is_none_or(|s| s.is_empty());

    // Generate AI title in background (non-blocking, tab shows "New session" until it arrives)
    if is_first_turn && !message.is_empty() {
        let title_app = app.clone();
        let title_db = db_tx.clone();
        let title_sid = session_id.clone();
        let title_tid = task_id.clone();
        let title_msg = message.clone();
        let title_wt = worktree_path.clone();
        tokio::spawn(async move {
            if let Some(title) = generate_session_title(&title_msg, &title_wt).await {
                let _ = title_db
                    .send(db::DbWrite::UpdateSessionName {
                        id: title_sid.clone(),
                        name: title.clone(),
                    })
                    .await;
                let _ = title_app.emit(
                    "session-name",
                    stream::SessionNameEvent {
                        session_id: title_sid,
                        name: title.clone(),
                    },
                );
                let _ = title_db
                    .send(db::DbWrite::UpdateTaskName {
                        id: title_tid.clone(),
                        name: title.clone(),
                    })
                    .await;
                let _ = title_app.emit(
                    "task-name",
                    stream::TaskNameEvent {
                        task_id: title_tid,
                        name: title,
                    },
                );
            }
        });
    }

    // Persist user message so it shows up on reload
    let attachment_names: Vec<&str> = attachments.iter().map(|a| a.name.as_str()).collect();
    let user_line = serde_json::json!({
        "type": "verun_user_message",
        "text": message,
        "attachments": attachment_names,
        "plan_mode": plan_mode,
        "thinking_mode": thinking_mode,
        "fast_mode": fast_mode,
    }).to_string();
    let _ = db_tx
        .send(db::DbWrite::InsertOutputLines {
            session_id: session_id.clone(),
            lines: vec![(user_line, epoch_ms())],
        })
        .await;

    let mut cmd = tokio::process::Command::new("claude");
    cmd.args([
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]);
    cmd.args(["--permission-prompt-tool", "stdio"]);
    if plan_mode {
        cmd.args(["--permission-mode", "plan"]);
    }
    cmd.stdin(std::process::Stdio::piped());

    if let Some(ref rid) = claude_session_id {
        if !rid.is_empty() {
            cmd.args(["--resume", rid]);
        }
    }
    if let Some(ref m) = model {
        cmd.args(["--model", m]);
    }
    if thinking_mode {
        cmd.args(["--effort", "max"]);
    }
    if fast_mode {
        cmd.args(["--effort", "low"]);
    }
    cmd.current_dir(&worktree_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    // Write user message to stdin (always via stream-json input)
    let mut stdin_handle = child.stdin.take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;

    // Build content blocks
    let mut content_blocks = Vec::new();
    for attachment in &attachments {
        content_blocks.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": attachment.mime_type,
                "data": attachment.data_base64,
            }
        }));
    }
    if !message.is_empty() {
        content_blocks.push(serde_json::json!({
            "type": "text",
            "text": message,
        }));
    }

    let user_msg = serde_json::json!({
        "type": "user",
        "session_id": "",
        "parent_tool_use_id": null,
        "message": {
            "role": "user",
            "content": content_blocks,
        }
    });

    let mut payload = serde_json::to_string(&user_msg)
        .map_err(|e| format!("Failed to serialize message: {e}"))?;
    payload.push('\n');

    stdin_handle.write_all(payload.as_bytes()).await
        .map_err(|e| format!("Failed to write to stdin: {e}"))?;
    stdin_handle.flush().await
        .map_err(|e| format!("Failed to flush stdin: {e}"))?;

    // Keep stdin open — we need it for control_response messages
    let stdin = Arc::new(TokioMutex::new(Some(stdin_handle)));

    let pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    // Mark session as running
    let _ = db_tx
        .send(db::DbWrite::UpdateSessionStatus {
            id: session_id.clone(),
            status: "running".to_string(),
        })
        .await;

    let _ = app.emit(
        "session-status",
        stream::SessionStatusEvent {
            session_id: session_id.clone(),
            status: "running".to_string(),
        },
    );

    // Track the active process
    active.insert(session_id.clone(), ActiveProcess { child, stdin: stdin.clone() });

    // Spawn monitor: stream output, detect exit, update DB
    let monitor_app = app.clone();
    let monitor_db_tx = db_tx.clone();
    let monitor_sid = session_id.clone();
    let monitor_tid = task_id.clone();
    let monitor_active = active.clone();
    let monitor_pending = pending_approvals.clone();
    let monitor_pending_meta = pending_approval_meta.clone();
    let monitor_wt = worktree_path.clone();
    let monitor_repo = repo_path;
    let monitor_trust = trust_level;
    tokio::spawn(async move {
        // Stream stdout lines to frontend + DB
        let captured = stream::stream_and_capture(
            monitor_app.clone(),
            monitor_sid.clone(),
            monitor_tid.clone(),
            stdout,
            stdin,
            monitor_pending,
            monitor_pending_meta,
            monitor_db_tx.clone(),
            monitor_wt,
            monitor_repo,
            monitor_trust,
        )
        .await;

        // Process exited — get exit code
        let status = if let Some((_, mut proc)) = monitor_active.remove(&monitor_sid) {
            let exit = proc.child.wait().await.ok().and_then(|s| s.code());
            stream::map_exit_status(exit)
        } else {
            // Aborted by abort_message
            return;
        };

        // Try to extract claude session_id from captured output
        if let Some(csid) = extract_claude_session_id(&captured) {
            let _ = monitor_db_tx
                .send(db::DbWrite::SetClaudeSessionId {
                    id: monitor_sid.clone(),
                    claude_session_id: csid,
                })
                .await;
        }

        // Update session status
        let final_status = if status == "error" { "error" } else { "idle" };
        let _ = monitor_db_tx
            .send(db::DbWrite::UpdateSessionStatus {
                id: monitor_sid.clone(),
                status: final_status.to_string(),
            })
            .await;
        if status == "error" {
            let _ = monitor_db_tx
                .send(db::DbWrite::EndSession {
                    id: monitor_sid.clone(),
                    ended_at: epoch_ms(),
                })
                .await;
        }

        let _ = monitor_app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id: monitor_sid,
                status: final_status.to_string(),
            },
        );

        // Notify frontend that git status may have changed
        let _ = monitor_app.emit(
            "git-status-changed",
            stream::GitStatusChangedEvent {
                task_id: monitor_tid,
            },
        );
    });

    if let Some(p) = pid {
        eprintln!("[verun] message sent in session {session_id} (pid {p})");
    }

    Ok(())
}

/// Abort a currently running message
pub async fn abort_message(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    session_id: &str,
) -> Result<(), String> {
    if let Some((_, mut proc)) = active.remove(session_id) {
        let _ = proc.child.kill().await;

        // Update session status so the UI reflects the abort
        let _ = db_tx
            .send(db::DbWrite::UpdateSessionStatus {
                id: session_id.to_string(),
                status: "idle".to_string(),
            })
            .await;

        let _ = app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id: session_id.to_string(),
                status: "idle".to_string(),
            },
        );
    }
    Ok(())
}

/// Extract the claude session_id from stream-json output.
/// Looks for `{"type":"system","subtype":"init",...,"session_id":"..."}` or
/// `{"type":"result",...,"session_id":"..."}` in the captured lines.
/// Generate a short title using a standalone Haiku call (fast, doesn't affect session).
async fn generate_session_title(first_message: &str, worktree_path: &str) -> Option<String> {
    let prompt = format!(
        "Generate a 3-5 word title for this coding task. Reply with ONLY the title, nothing else.\n\nUser message: {}",
        first_message.chars().take(300).collect::<String>()
    );
    let output = tokio::process::Command::new("claude")
        .args([
            "-p", &prompt,
            "--output-format", "text",
            "--no-session-persistence",
            "--model", "haiku",
        ])
        .current_dir(worktree_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let title = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if title.is_empty() || title.len() > 60 {
        None
    } else {
        Some(title)
    }
}

fn extract_claude_session_id(lines: &[String]) -> Option<String> {
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    return Some(sid.to_string());
                }
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("system")
                && v.get("subtype").and_then(|t| t.as_str()) == Some("init")
            {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    return Some(sid.to_string());
                }
            }
        }
    }
    None
}

pub fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn funny_branch_name_format() {
        let name = funny_branch_name();
        let parts: Vec<&str> = name.split('-').collect();
        assert_eq!(parts.len(), 3, "Expected adjective-animal-number, got: {name}");
        assert!(parts[2].parse::<u64>().is_ok(), "Third part should be a number");
    }

    #[test]
    fn funny_branch_names_vary() {
        let a = funny_branch_name();
        std::thread::sleep(std::time::Duration::from_millis(1));
        let b = funny_branch_name();
        assert_ne!(a, b, "Branch names should differ");
    }

    #[test]
    fn active_map_starts_empty() {
        let map = new_active_map();
        assert!(map.is_empty());
    }

    #[test]
    fn epoch_ms_returns_reasonable_timestamp() {
        let ts = epoch_ms();
        assert!(ts > 1_704_067_200_000);
        assert!(ts < 4_102_444_800_000);
    }

    #[test]
    fn adjectives_and_animals_have_enough_variety() {
        assert!(ADJECTIVES.len() >= 20);
        assert!(ANIMALS.len() >= 20);
    }

    #[test]
    fn extract_session_id_from_result() {
        let lines = vec![
            r#"{"type":"assistant","content":"hello"}"#.into(),
            r#"{"type":"result","session_id":"abc-123","cost":0.01}"#.into(),
        ];
        assert_eq!(extract_claude_session_id(&lines), Some("abc-123".to_string()));
    }

    #[test]
    fn extract_session_id_from_init() {
        let lines = vec![
            r#"{"type":"system","subtype":"init","session_id":"init-456","tools":[]}"#.into(),
        ];
        assert_eq!(extract_claude_session_id(&lines), Some("init-456".to_string()));
    }

    #[test]
    fn extract_session_id_missing() {
        let lines = vec![
            r#"{"type":"assistant","content":"hello"}"#.into(),
        ];
        assert_eq!(extract_claude_session_id(&lines), None);
    }
}
