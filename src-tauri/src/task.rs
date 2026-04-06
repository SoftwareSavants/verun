use crate::db::{self, DbWriteTx, Session, Task};
use crate::stream;
use crate::worktree;
use dashmap::DashMap;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
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
}

/// session_id → currently running claude process (only while processing a message)
pub type ActiveMap = Arc<DashMap<String, ActiveProcess>>;

pub fn new_active_map() -> ActiveMap {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

pub async fn create_task(
    db_tx: &DbWriteTx,
    project_id: String,
    repo_path: String,
) -> Result<(Task, Session), String> {
    let id = Uuid::new_v4().to_string();
    let branch = funny_branch_name();
    let now = epoch_ms();

    let worktree_path = {
        let rp = repo_path.clone();
        let br = branch.clone();
        tokio::task::spawn_blocking(move || worktree::create_worktree(&rp, &br))
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
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    repo_path: &str,
    task: &Task,
) -> Result<(), String> {
    // Kill any active processes for this task's sessions
    let keys: Vec<String> = active.iter().map(|e| e.key().clone()).collect();
    for sid in keys {
        abort_message(active, &sid).await?;
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
    pub worktree_path: String,
    pub message: String,
    pub claude_session_id: Option<String>,
    pub attachments: Vec<Attachment>,
    pub model: Option<String>,
}

/// Send a message to Claude in this session's worktree.
/// Without attachments: spawns `claude -p "msg" --output-format stream-json`.
/// With attachments: spawns `claude -p --input-format stream-json` and pipes structured content to stdin.
pub async fn send_message(
    app: AppHandle,
    db_tx: &DbWriteTx,
    active: ActiveMap,
    params: SendMessageParams,
) -> Result<(), String> {
    let SendMessageParams { session_id, worktree_path, message, claude_session_id, attachments, model } = params;
    // Don't allow concurrent messages on the same session
    if active.contains_key(&session_id) {
        return Err("Session is already processing a message".to_string());
    }

    let has_attachments = !attachments.is_empty();

    // Persist user message so it shows up on reload
    let attachment_names: Vec<&str> = attachments.iter().map(|a| a.name.as_str()).collect();
    let user_line = serde_json::json!({
        "type": "verun_user_message",
        "text": message,
        "attachments": attachment_names,
    }).to_string();
    let _ = db_tx
        .send(db::DbWrite::InsertOutputLines {
            session_id: session_id.clone(),
            lines: vec![(user_line, epoch_ms())],
        })
        .await;

    let mut cmd = tokio::process::Command::new("claude");

    if has_attachments {
        // With attachments: pipe structured content via stdin
        cmd.args([
            "-p",
            "--output-format", "stream-json",
            "--input-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]);
        cmd.stdin(std::process::Stdio::piped());
    } else {
        // Text only: pass message as argument
        cmd.args([
            "-p", &message,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]);
    }

    if let Some(ref rid) = claude_session_id {
        if !rid.is_empty() {
            cmd.args(["--resume", rid]);
        }
    }
    if let Some(ref m) = model {
        cmd.args(["--model", m]);
    }
    cmd.current_dir(&worktree_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    // Write structured content to stdin when we have attachments
    if has_attachments {
        let mut stdin = child.stdin.take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;

        // Build content blocks: images first, then text
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

        stdin.write_all(payload.as_bytes()).await
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        stdin.flush().await
            .map_err(|e| format!("Failed to flush stdin: {e}"))?;
        // Drop stdin to signal EOF — Claude will process the message
        drop(stdin);
    }

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
    active.insert(session_id.clone(), ActiveProcess { child });

    // Spawn monitor: stream output, detect exit, update DB
    let monitor_app = app.clone();
    let monitor_db_tx = db_tx.clone();
    let monitor_sid = session_id.clone();
    let monitor_active = active.clone();
    tokio::spawn(async move {
        // Stream stdout lines to frontend + DB
        let captured = stream::stream_and_capture(
            monitor_app.clone(),
            monitor_sid.clone(),
            stdout,
            monitor_db_tx.clone(),
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
    });

    if let Some(p) = pid {
        eprintln!("[verun] message sent in session {session_id} (pid {p})");
    }

    Ok(())
}

/// Abort a currently running message
pub async fn abort_message(active: &ActiveMap, session_id: &str) -> Result<(), String> {
    if let Some((_, mut proc)) = active.remove(session_id) {
        let _ = proc.child.kill().await;
    }
    Ok(())
}

/// Extract the claude session_id from stream-json output.
/// Looks for `{"type":"system","subtype":"init",...,"session_id":"..."}` or
/// `{"type":"result",...,"session_id":"..."}` in the captured lines.
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

fn epoch_ms() -> i64 {
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
