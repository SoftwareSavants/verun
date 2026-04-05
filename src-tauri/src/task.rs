use crate::db::{self, DbWriteTx, Session, Task};
use crate::stream;
use crate::worktree;
use dashmap::DashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
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
// Session handle — tracks a running Claude CLI process
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub struct SessionHandle {
    pub child: Child,
    pub session_id: String,
    pub task_id: String,
}

/// Map of session_id → running SessionHandle
pub type SessionMap = Arc<DashMap<String, SessionHandle>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

/// Create a new task: generate a funny branch, create worktree, persist to DB
pub async fn create_task(
    db_tx: &DbWriteTx,
    project_id: String,
    repo_path: String,
) -> Result<Task, String> {
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

    Ok(task)
}

/// Delete a task: kill any running sessions, remove worktree, delete from DB
pub async fn delete_task(
    db_tx: &DbWriteTx,
    sessions: &SessionMap,
    repo_path: &str,
    task: &Task,
) -> Result<(), String> {
    // Kill all running sessions for this task
    let session_ids: Vec<String> = sessions
        .iter()
        .filter(|entry| entry.value().task_id == task.id)
        .map(|entry| entry.key().clone())
        .collect();

    for sid in session_ids {
        stop_session(db_tx, sessions, &sid).await?;
    }

    // Remove worktree
    let rp = repo_path.to_string();
    let wtp = task.worktree_path.clone();
    let _ = tokio::task::spawn_blocking(move || worktree::delete_worktree(&rp, &wtp)).await;

    // Delete from DB (cascades sessions + output)
    db_tx
        .send(db::DbWrite::DeleteTask { id: task.id.clone() })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/// Start a new Claude Code session in the task's worktree
pub async fn start_session(
    app: AppHandle,
    db_tx: &DbWriteTx,
    sessions: SessionMap,
    task_id: String,
    worktree_path: String,
) -> Result<Session, String> {
    spawn_claude_session(app, db_tx, sessions, task_id, worktree_path, None).await
}

/// Resume a previous Claude Code session via --resume
pub async fn resume_session(
    app: AppHandle,
    db_tx: &DbWriteTx,
    sessions: SessionMap,
    task_id: String,
    worktree_path: String,
    claude_session_id: String,
) -> Result<Session, String> {
    spawn_claude_session(
        app,
        db_tx,
        sessions,
        task_id,
        worktree_path,
        Some(claude_session_id),
    )
    .await
}

/// Stop a running session: SIGTERM → 5s grace → SIGKILL
pub async fn stop_session(
    db_tx: &DbWriteTx,
    sessions: &SessionMap,
    session_id: &str,
) -> Result<(), String> {
    if let Some((_, mut handle)) = sessions.remove(session_id) {
        // Try graceful kill first
        let pid = handle.child.id();
        if let Some(pid) = pid {
            // Send SIGTERM
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Wait up to 5 seconds for graceful exit
            let graceful = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                handle.child.wait(),
            )
            .await;

            if graceful.is_err() {
                // Force kill after timeout
                let _ = handle.child.kill().await;
            }
        } else {
            let _ = handle.child.kill().await;
        }

        let now = epoch_ms();
        let _ = db_tx
            .send(db::DbWrite::EndSession {
                id: session_id.to_string(),
                ended_at: now,
            })
            .await;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async fn spawn_claude_session(
    app: AppHandle,
    db_tx: &DbWriteTx,
    sessions: SessionMap,
    task_id: String,
    worktree_path: String,
    resume_id: Option<String>,
) -> Result<Session, String> {
    let session_id = Uuid::new_v4().to_string();
    let now = epoch_ms();

    // Build claude command
    let mut cmd = tokio::process::Command::new("claude");
    if let Some(ref rid) = resume_id {
        cmd.args(["--resume", rid]);
    }
    cmd.current_dir(&worktree_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let pid = child.id();

    // Take stdout + stderr for streaming
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Persist session before spawning monitor
    let session = Session {
        id: session_id.clone(),
        task_id: task_id.clone(),
        name: None,
        claude_session_id: resume_id,
        status: "running".to_string(),
        started_at: now,
        ended_at: None,
    };

    db_tx
        .send(db::DbWrite::CreateSession(session.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Store handle (child stays here for stop_session to kill)
    sessions.insert(
        session_id.clone(),
        SessionHandle {
            child,
            session_id: session_id.clone(),
            task_id: task_id.clone(),
        },
    );

    // Spawn monitor: streams output, then waits for exit code, updates DB
    let monitor_app = app.clone();
    let monitor_db_tx = db_tx.clone();
    let monitor_session_id = session_id.clone();
    let monitor_sessions = sessions.clone();
    tokio::spawn(async move {
        // Stream stdout + stderr until both close
        stream::stream_output(
            monitor_app.clone(),
            monitor_session_id.clone(),
            stdout,
            stderr,
            monitor_db_tx.clone(),
        )
        .await;

        // Process exited — get exit code from the handle
        let status = if let Some((_, mut handle)) = monitor_sessions.remove(&monitor_session_id) {
            let exit = handle.child.wait().await.ok().and_then(|s| s.code());
            stream::map_exit_status(exit)
        } else {
            // Already removed by stop_session — it handles status itself
            return;
        };

        // Update DB and emit status
        let now = epoch_ms();
        let _ = monitor_db_tx
            .send(db::DbWrite::UpdateSessionStatus {
                id: monitor_session_id.clone(),
                status: status.to_string(),
            })
            .await;
        let _ = monitor_db_tx
            .send(db::DbWrite::EndSession {
                id: monitor_session_id.clone(),
                ended_at: now,
            })
            .await;
        let _ = monitor_app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id: monitor_session_id,
                status: status.to_string(),
            },
        );
    });

    if let Some(p) = pid {
        eprintln!("[verun] started session {} (pid {p})", session.id);
    }

    Ok(session)
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    fn session_map_starts_empty() {
        let map = new_session_map();
        assert!(map.is_empty());
    }

    #[test]
    fn epoch_ms_returns_reasonable_timestamp() {
        let ts = epoch_ms();
        assert!(ts > 1_704_067_200_000); // after 2024-01-01
        assert!(ts < 4_102_444_800_000); // before 2100-01-01
    }

    #[test]
    fn adjectives_and_animals_have_enough_variety() {
        assert!(ADJECTIVES.len() >= 20);
        assert!(ANIMALS.len() >= 20);
    }
}
