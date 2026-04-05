use crate::db::{
    self, DbWriteTx, OutputLine, Project, Session, Task,
};
use crate::task::{self, SessionMap};
use crate::worktree;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri::{AppHandle, State};
use tokio::task::JoinError;
use uuid::Uuid;

/// Unwrap a spawn_blocking result, converting JoinError to String.
fn flatten_join<T>(result: Result<Result<T, String>, JoinError>) -> Result<T, String> {
    result.map_err(|e| format!("Task join error: {e}"))?
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
    // Validate it's a real git repo
    let resolved = flatten_join(
        tokio::task::spawn_blocking({
            let rp = repo_path.clone();
            move || worktree::get_repo_root(&rp)
        })
        .await,
    )?;

    // Derive name from the repo directory
    let name = std::path::Path::new(&resolved)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| resolved.clone());

    // Check if already added
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
    sessions: State<'_, SessionMap>,
    id: String,
) -> Result<(), String> {
    // Kill sessions and clean up worktrees for all tasks in this project
    let project = db::get_project(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Project {id} not found"))?;

    let tasks = db::list_tasks_for_project(pool.inner(), &id).await?;
    for t in &tasks {
        task::delete_task(db_tx.inner(), sessions.inner(), &project.repo_path, t).await?;
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
) -> Result<Task, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    task::create_task(db_tx.inner(), project_id, project.repo_path).await
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
    sessions: State<'_, SessionMap>,
    id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::delete_task(db_tx.inner(), sessions.inner(), &project.repo_path, &t).await
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    sessions: State<'_, SessionMap>,
    task_id: String,
) -> Result<Session, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    task::start_session(
        app,
        db_tx.inner(),
        sessions.inner().clone(),
        task_id,
        t.worktree_path,
    )
    .await
}

#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    sessions: State<'_, SessionMap>,
    session_id: String,
) -> Result<Session, String> {
    let s = db::get_session(pool.inner(), &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    let claude_sid = s
        .claude_session_id
        .ok_or_else(|| "Session has no Claude session ID to resume".to_string())?;

    let t = db::get_task(pool.inner(), &s.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", s.task_id))?;

    task::resume_session(
        app,
        db_tx.inner(),
        sessions.inner().clone(),
        s.task_id,
        t.worktree_path,
        claude_sid,
    )
    .await
}

#[tauri::command]
pub async fn stop_session(
    db_tx: State<'_, DbWriteTx>,
    sessions: State<'_, SessionMap>,
    session_id: String,
) -> Result<(), String> {
    task::stop_session(db_tx.inner(), sessions.inner(), &session_id).await
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
// Worktree / Git
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
