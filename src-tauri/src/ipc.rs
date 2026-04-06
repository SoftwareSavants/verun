use crate::db::{
    self, DbWriteTx, OutputLine, Project, Session, Task,
};
use crate::task::{self, ActiveMap};
use crate::worktree;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri::{AppHandle, State};
use tokio::task::JoinError;
use uuid::Uuid;

fn flatten_join<T>(result: Result<Result<T, String>, JoinError>) -> Result<T, String> {
    result.map_err(|e| format!("Task join error: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWithSession {
    pub task: Task,
    pub session: Session,
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn add_project(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    repo_path: String,
) -> Result<Project, String> {
    let resolved = flatten_join(
        tokio::task::spawn_blocking({
            let rp = repo_path.clone();
            move || worktree::get_repo_root(&rp)
        })
        .await,
    )?;

    let name = std::path::Path::new(&resolved)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| resolved.clone());

    let existing = db::list_projects(pool.inner()).await?;
    if existing.iter().any(|p| p.repo_path == resolved) {
        return Err("Project already added".to_string());
    }

    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        repo_path: resolved,
        created_at: epoch_ms(),
    };

    db_tx
        .send(db::DbWrite::InsertProject(project.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(project)
}

#[tauri::command]
pub async fn list_projects(pool: State<'_, SqlitePool>) -> Result<Vec<Project>, String> {
    db::list_projects(pool.inner()).await
}

#[tauri::command]
pub async fn delete_project(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    id: String,
) -> Result<(), String> {
    let project = db::get_project(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Project {id} not found"))?;

    let tasks = db::list_tasks_for_project(pool.inner(), &id).await?;
    for t in &tasks {
        task::delete_task(db_tx.inner(), active.inner(), &project.repo_path, t).await?;
    }

    db_tx
        .send(db::DbWrite::DeleteProject { id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_task(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    project_id: String,
) -> Result<TaskWithSession, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let (task, session) = task::create_task(db_tx.inner(), project_id, project.repo_path).await?;
    Ok(TaskWithSession { task, session })
}

#[tauri::command]
pub async fn list_tasks(
    pool: State<'_, SqlitePool>,
    project_id: String,
) -> Result<Vec<Task>, String> {
    db::list_tasks_for_project(pool.inner(), &project_id).await
}

#[tauri::command]
pub async fn get_task(pool: State<'_, SqlitePool>, id: String) -> Result<Option<Task>, String> {
    db::get_task(pool.inner(), &id).await
}

#[tauri::command]
pub async fn delete_task(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::delete_task(db_tx.inner(), active.inner(), &project.repo_path, &t).await
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Create a new session (no process spawned — call send_message to talk to Claude)
#[tauri::command]
pub async fn create_session(
    db_tx: State<'_, DbWriteTx>,
    task_id: String,
) -> Result<Session, String> {
    task::create_session(db_tx.inner(), task_id).await
}

/// Send a message to Claude in this session.
/// Spawns claude -p with --resume if we have a prior session_id.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    session_id: String,
    message: String,
    attachments: Option<Vec<task::Attachment>>,
    model: Option<String>,
) -> Result<(), String> {
    let session = db::get_session(pool.inner(), &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    let t = db::get_task(pool.inner(), &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;

    task::send_message(
        app,
        db_tx.inner(),
        active.inner().clone(),
        task::SendMessageParams {
            session_id,
            task_id: session.task_id,
            worktree_path: t.worktree_path,
            message,
            claude_session_id: session.claude_session_id,
            attachments: attachments.unwrap_or_default(),
            model,
        },
    )
    .await
}

/// Close a session (hides from UI, persists in DB as 'closed')
#[tauri::command]
pub async fn close_session(
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::CloseSession { id: session_id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

/// Clear a session's Claude context (reset session_id + delete output lines)
#[tauri::command]
pub async fn clear_session(
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<(), String> {
    // Clear the claude_session_id so next message starts fresh
    db_tx
        .send(db::DbWrite::SetClaudeSessionId {
            id: session_id.clone(),
            claude_session_id: String::new(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Clear persisted output lines
    db_tx
        .send(db::DbWrite::DeleteOutputLines {
            session_id,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

/// Abort a currently running message
#[tauri::command]
pub async fn abort_message(
    active: State<'_, ActiveMap>,
    session_id: String,
) -> Result<(), String> {
    task::abort_message(active.inner(), &session_id).await
}

#[tauri::command]
pub async fn list_sessions(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<Session>, String> {
    db::list_sessions_for_task(pool.inner(), &task_id).await
}

#[tauri::command]
pub async fn get_session(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Session>, String> {
    db::get_session(pool.inner(), &id).await
}

#[tauri::command]
pub async fn get_output_lines(
    pool: State<'_, SqlitePool>,
    session_id: String,
) -> Result<Vec<OutputLine>, String> {
    db::get_output_lines(pool.inner(), &session_id).await
}

// ---------------------------------------------------------------------------
// Git / Worktree
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_diff(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || worktree::get_diff(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn merge_branch(
    pool: State<'_, SqlitePool>,
    task_id: String,
    target_branch: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    let branch = t.branch.clone();
    flatten_join(
        tokio::task::spawn_blocking(move || {
            worktree::merge_branch(&project.repo_path, &branch, &target_branch)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_branch_status(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(u32, u32), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || worktree::get_branch_status(&t.worktree_path)).await,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub current_branch: String,
    pub branches: Vec<String>,
}

#[tauri::command]
pub async fn get_repo_info(path: String) -> Result<RepoInfo, String> {
    flatten_join(
        tokio::task::spawn_blocking(move || {
            let root = worktree::get_repo_root(&path)?;

            let output = std::process::Command::new("git")
                .current_dir(&root)
                .args(["branch", "--format=%(refname:short)"])
                .output()
                .map_err(|e| format!("Failed to list branches: {e}"))?;

            let branches: Vec<String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|l| l.to_string())
                .collect();

            let output = std::process::Command::new("git")
                .current_dir(&root)
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .output()
                .map_err(|e| format!("Failed to get current branch: {e}"))?;

            let current_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

            Ok(RepoInfo {
                root,
                current_branch,
                branches,
            })
        })
        .await,
    )
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSkill {
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub async fn list_claude_skills() -> Result<Vec<ClaudeSkill>, String> {
    let output = std::process::Command::new("claude")
        .args(["skills", "list"])
        .output()
        .map_err(|e| format!("Failed to run claude skills list: {e}"))?;

    if !output.status.success() {
        return Err("claude skills list failed".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut skills = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        // Parse lines like: - `/name` — description
        // or:                - `/name` — description
        if let Some(rest) = trimmed.strip_prefix("- `/").or_else(|| trimmed.strip_prefix("- `/")) {
            if let Some(idx) = rest.find('`') {
                let name = rest[..idx].to_string();
                let desc = rest[idx + 1..]
                    .trim_start_matches(" — ")
                    .trim_start_matches(" — ")
                    .trim()
                    .to_string();
                if !name.is_empty() {
                    skills.push(ClaudeSkill { name, description: desc });
                }
            }
        }
    }

    Ok(skills)
}

#[tauri::command]
pub async fn check_claude() -> Result<String, String> {
    let output = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map_err(|_| "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code".to_string())?;
    if !output.status.success() {
        return Err("Claude CLI returned an error".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_info_serializes_as_camel_case() {
        let info = RepoInfo {
            root: "/tmp/repo".into(),
            current_branch: "main".into(),
            branches: vec!["main".into(), "dev".into()],
        };
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("currentBranch").is_some());
    }
}
