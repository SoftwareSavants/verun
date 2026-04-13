use crate::db::{
    self, DbWriteTx, OutputLine, Project, Session, Step, Task,
};
use crate::git_ops;
use crate::github;
use crate::pty::{self, ActivePtyMap};
use crate::task::{self, ActiveMap, ApprovalResponse, HookPtyMap, PendingApprovalEntry, PendingApprovalMeta, PendingApprovals, SetupInProgress};
use crate::lsp::LspMap;
use crate::watcher::FileWatcherMap;
use crate::worktree;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};
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
    let (resolved, base_branch) = flatten_join(
        tokio::task::spawn_blocking({
            let rp = repo_path.clone();
            move || {
                let root = worktree::get_repo_root(&rp)?;
                let branch = worktree::detect_base_branch(&root);
                Ok((root, branch))
            }
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

    // Load config from .verun.json if it exists in the repo
    let config_path = format!("{resolved}/.verun.json");
    let (setup_hook, destroy_hook, start_command) =
        task::parse_verun_config_file(&config_path).unwrap_or_default();

    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        repo_path: resolved,
        base_branch,
        setup_hook,
        destroy_hook,
        start_command,
        auto_start: false,
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
    app: AppHandle,
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
        task::delete_task(&app, db_tx.inner(), active.inner(), &project.repo_path, t, &project.destroy_hook, true, false).await?;
    }

    db_tx
        .send(db::DbWrite::DeleteProject { id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn update_project_base_branch(
    db_tx: State<'_, DbWriteTx>,
    id: String,
    base_branch: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateProjectBaseBranch { id, base_branch })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn update_project_hooks(
    db_tx: State<'_, DbWriteTx>,
    id: String,
    setup_hook: String,
    destroy_hook: String,
    start_command: String,
    auto_start: bool,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateProjectHooks { id, setup_hook, destroy_hook, start_command, auto_start })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

/// Export current DB hooks to .verun.json in a task's worktree
#[tauri::command]
pub async fn export_project_config(
    pool: State<'_, SqlitePool>,
    project_id: String,
    task_id: String,
) -> Result<(), String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let config = serde_json::json!({
        "hooks": {
            "setup": &project.setup_hook,
            "destroy": &project.destroy_hook,
        },
        "startCommand": &project.start_command,
    });
    let pretty = serde_json::to_string_pretty(&config).unwrap_or_default();
    let config_path = format!("{}/.verun.json", t.worktree_path);
    std::fs::write(&config_path, format!("{pretty}\n"))
        .map_err(|e| format!("Failed to write .verun.json: {e}"))
}

/// Import .verun.json from the repo root into DB. Returns the imported hooks.
#[tauri::command]
pub async fn import_project_config(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    project_id: String,
) -> Result<ImportedHooks, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let config_path = format!("{}/.verun.json", project.repo_path);
    let (setup, destroy, start) = task::parse_verun_config_file(&config_path)
        .ok_or_else(|| "No .verun.json found or file is empty".to_string())?;

    db_tx
        .send(db::DbWrite::UpdateProjectHooks {
            id: project_id,
            setup_hook: setup.clone(),
            destroy_hook: destroy.clone(),
            start_command: start.clone(),
            auto_start: project.auto_start,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(ImportedHooks { setup_hook: setup, destroy_hook: destroy, start_command: start })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHooks {
    pub setup_hook: String,
    pub destroy_hook: String,
    pub start_command: String,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_task(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    pty_map: State<'_, ActivePtyMap>,
    hook_pty_map: State<'_, HookPtyMap>,
    setup_in_progress: State<'_, SetupInProgress>,
    project_id: String,
    base_branch: Option<String>,
) -> Result<TaskWithSession, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let from_task_window = window.label().starts_with("task-");

    let branch = base_branch.unwrap_or(project.base_branch);
    let port_offset = db::next_port_offset(pool.inner(), &project_id).await?;
    let (task, session) = task::create_task(
        &app,
        db_tx.inner(),
        pty_map.inner(),
        hook_pty_map.inner(),
        setup_in_progress.inner(),
        task::CreateTaskParams {
            project_id,
            repo_path: project.repo_path,
            base_branch: branch,
            setup_hook: project.setup_hook,
            port_offset,
            from_task_window,
        },
    ).await?;

    // For task windows: store label → taskId so the close handler works
    if from_task_window {
        if let Some(map) = app.try_state::<crate::WindowTaskMap>() {
            map.insert(window.label().to_string(), task.id.clone());
        }
    }

    Ok(TaskWithSession { task, session })
}

#[tauri::command]
pub async fn get_setup_in_progress(
    setup_in_progress: State<'_, SetupInProgress>,
) -> Result<Vec<String>, String> {
    Ok(setup_in_progress.iter().map(|e| e.key().clone()).collect())
}

/// Manually run a hook (setup or destroy) for a task via PTY
#[tauri::command]
pub async fn run_hook(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    pty_map: State<'_, ActivePtyMap>,
    hook_pty_map: State<'_, HookPtyMap>,
    setup_in_progress: State<'_, SetupInProgress>,
    task_id: String,
    hook_type: String,
) -> Result<pty::SpawnResult, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    let (hook_command, ht) = match hook_type.as_str() {
        "setup" => (project.setup_hook.as_str(), task::HookType::Setup),
        "destroy" => (project.destroy_hook.as_str(), task::HookType::Destroy),
        _ => return Err(format!("Invalid hook type: {hook_type}")),
    };

    task::spawn_hook_pty(
        &app,
        pty_map.inner(),
        hook_pty_map.inner(),
        setup_in_progress.inner(),
        &task_id,
        &t.worktree_path,
        hook_command,
        ht,
        t.port_offset,
        &project.repo_path,
    )
}

/// Stop a running hook for a task
#[tauri::command]
pub async fn stop_hook(
    pty_map: State<'_, ActivePtyMap>,
    hook_pty_map: State<'_, HookPtyMap>,
    task_id: String,
) -> Result<(), String> {
    let entry = hook_pty_map
        .remove(&task_id)
        .ok_or_else(|| "No hook running for this task".to_string())?;

    let terminal_id = entry.1.terminal_id;
    tokio::task::spawn_blocking({
        let map = pty_map.inner().clone();
        move || pty::close_pty(&map, &terminal_id)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
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
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    id: String,
    delete_branch: bool,
    skip_destroy_hook: Option<bool>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::delete_task(&app, db_tx.inner(), active.inner(), &project.repo_path, &t, &project.destroy_hook, delete_branch, skip_destroy_hook.unwrap_or(false)).await
}

#[tauri::command]
pub async fn archive_task(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    id: String,
    skip_destroy_hook: Option<bool>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::archive_task(&app, db_tx.inner(), active.inner(), &t, &project.destroy_hook, &project.repo_path, skip_destroy_hook.unwrap_or(false)).await
}

#[tauri::command]
pub async fn check_task_worktree(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(bool, bool), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    let wtp = t.worktree_path.clone();
    let rp = project.repo_path.clone();
    let branch = t.branch.clone();
    tokio::task::spawn_blocking(move || {
        worktree::check_worktree_exists(&rp, &wtp, &branch)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))
}

#[tauri::command]
pub async fn restore_task(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    pty_map: State<'_, ActivePtyMap>,
    hook_pty_map: State<'_, HookPtyMap>,
    setup_in_progress: State<'_, task::SetupInProgress>,
    id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("Task {id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    db_tx
        .send(db::DbWrite::RestoreTask { id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Re-run setup hook
    task::spawn_setup_hook(
        &app,
        pty_map.inner(),
        hook_pty_map.inner(),
        setup_in_progress.inner(),
        &t.id,
        &t.worktree_path,
        &project.setup_hook,
        t.port_offset,
        &project.repo_path,
    );

    Ok(())
}

/// Rename a task (persists to DB and emits event to frontend)
#[tauri::command]
pub async fn rename_task(
    app: AppHandle,
    db_tx: State<'_, DbWriteTx>,
    task_id: String,
    name: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateTaskName {
            id: task_id.clone(),
            name: name.clone(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let _ = app.emit(
        "task-name",
        crate::stream::TaskNameEvent {
            task_id,
            name,
        },
    );
    Ok(())
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
    pending: State<'_, PendingApprovals>,
    pending_meta: State<'_, PendingApprovalMeta>,
    session_id: String,
    message: String,
    attachments: Option<Vec<task::Attachment>>,
    model: Option<String>,
    plan_mode: Option<bool>,
    thinking_mode: Option<bool>,
    fast_mode: Option<bool>,
) -> Result<(), String> {
    let session = db::get_session(pool.inner(), &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    let t = db::get_task(pool.inner(), &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;

    let trust_str = db::get_trust_level(pool.inner(), &session.task_id).await?;
    let trust_level = crate::policy::TrustLevel::from_str(&trust_str);
    let repo_path = db::get_repo_path_for_task(pool.inner(), &session.task_id).await?;

    task::send_message(
        app,
        db_tx.inner(),
        active.inner().clone(),
        pending.inner().clone(),
        pending_meta.inner().clone(),
        task::SendMessageParams {
            session_id,
            task_id: session.task_id.clone(),
            project_id: t.project_id,
            worktree_path: t.worktree_path,
            repo_path,
            port_offset: t.port_offset,
            trust_level,
            message,
            claude_session_id: session.claude_session_id,
            attachments: attachments.unwrap_or_default(),
            model,
            plan_mode: plan_mode.unwrap_or(false),
            thinking_mode: thinking_mode.unwrap_or(false),
            fast_mode: fast_mode.unwrap_or(false),
            task_name: t.name,
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
    app: AppHandle,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    session_id: String,
) -> Result<(), String> {
    task::abort_message(&app, db_tx.inner(), active.inner(), &session_id).await
}

/// Return session IDs that currently have an active process
#[tauri::command]
pub async fn get_active_sessions(
    active: State<'_, ActiveMap>,
) -> Result<Vec<String>, String> {
    Ok(task::get_active_session_ids(active.inner()))
}

/// Respond to a pending tool approval request.
/// For AskUserQuestion, pass `updated_input` with the original questions + answers map.
#[tauri::command]
pub async fn respond_to_approval(
    pending: State<'_, PendingApprovals>,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    if let Some((_, tx)) = pending.remove(&request_id) {
        let _ = tx.send(ApprovalResponse { behavior, updated_input });
        Ok(())
    } else {
        Err(format!("No pending approval with id {request_id}"))
    }
}

/// Get all currently pending approval requests (for re-emitting on frontend reload)
#[tauri::command]
pub async fn get_pending_approvals(
    pending_meta: State<'_, PendingApprovalMeta>,
) -> Result<Vec<PendingApprovalEntry>, String> {
    Ok(pending_meta.iter().map(|entry| entry.value().clone()).collect())
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
// Policy / Trust levels
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn set_trust_level(
    db_tx: State<'_, DbWriteTx>,
    task_id: String,
    trust_level: String,
) -> Result<(), String> {
    // Validate
    match trust_level.as_str() {
        "normal" | "full_auto" | "supervised" => {}
        _ => return Err(format!("Invalid trust level: {trust_level}. Must be normal, full_auto, or supervised")),
    }

    db_tx
        .send(db::DbWrite::SetTrustLevel {
            task_id,
            trust_level,
            updated_at: crate::task::epoch_ms(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn get_trust_level(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<String, String> {
    db::get_trust_level(pool.inner(), &task_id).await
}

#[tauri::command]
pub async fn get_audit_log(
    pool: State<'_, SqlitePool>,
    task_id: String,
    limit: Option<i64>,
) -> Result<Vec<db::AuditEntry>, String> {
    db::get_audit_log(pool.inner(), &task_id, limit.unwrap_or(100)).await
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
) -> Result<(u32, u32, u32), String> {
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

            // Remote branches first (stripped of origin/ prefix), then local-only branches
            let remote_output = std::process::Command::new("git")
                .current_dir(&root)
                .args(["branch", "-r", "--format=%(refname:short)"])
                .output()
                .map_err(|e| format!("Failed to list remote branches: {e}"))?;

            let mut branches: Vec<String> = Vec::new();
            let mut seen = std::collections::HashSet::new();

            // Add remote branches first (strip origin/ prefix, skip HEAD pointer and arrows)
            for line in String::from_utf8_lossy(&remote_output.stdout).lines() {
                if line.contains("->") || line == "origin" { continue; }
                let name = line.strip_prefix("origin/").unwrap_or(line);
                if name == "HEAD" || name.is_empty() { continue; }
                if seen.insert(name.to_string()) {
                    branches.push(name.to_string());
                }
            }

            // Then add local-only branches that don't have a remote
            let local_output = std::process::Command::new("git")
                .current_dir(&root)
                .args(["branch", "--format=%(refname:short)"])
                .output()
                .map_err(|e| format!("Failed to list local branches: {e}"))?;

            for line in String::from_utf8_lossy(&local_output.stdout).lines() {
                if seen.insert(line.to_string()) {
                    branches.push(line.to_string());
                }
            }

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
// Git operations (structured status, diffs, stage, commit, push, pull)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_git_status(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<git_ops::GitStatus, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::get_git_status(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn get_file_diff(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<git_ops::FileDiff, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::get_file_diff(&t.worktree_path, &file_path, context_lines, ignore_whitespace))
            .await,
    )
}

#[tauri::command]
pub async fn get_file_context(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
    start_line: u32,
    end_line: u32,
    version: String,
) -> Result<Vec<String>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_file_context(&t.worktree_path, &file_path, start_line, end_line, &version)
        })
        .await,
    )
}

#[tauri::command]
pub async fn git_stage(
    pool: State<'_, SqlitePool>,
    task_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            if paths.is_empty() {
                git_ops::stage_all(&t.worktree_path)
            } else {
                git_ops::stage_files(&t.worktree_path, &paths)
            }
        })
        .await,
    )
}

#[tauri::command]
pub async fn git_unstage(
    pool: State<'_, SqlitePool>,
    task_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::unstage_files(&t.worktree_path, &paths))
            .await,
    )
}

#[tauri::command]
pub async fn git_commit(
    pool: State<'_, SqlitePool>,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::commit(&t.worktree_path, &message)).await,
    )
}

#[tauri::command]
pub async fn git_push(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::push_branch(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn git_pull(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::pull_branch(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn git_commit_and_push(
    pool: State<'_, SqlitePool>,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            // Stage all first
            git_ops::stage_all(&t.worktree_path)?;
            // Commit
            let hash = git_ops::commit(&t.worktree_path, &message)?;
            // Push
            git_ops::push_branch(&t.worktree_path)?;
            Ok(hash)
        })
        .await,
    )
}

// ---------------------------------------------------------------------------
// Branch commits
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_branch_commits(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, db::DbWriteTx>,
    task_id: String,
) -> Result<Vec<git_ops::BranchCommit>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    let base = project.base_branch.clone();
    let cached = t.merge_base_sha.clone();
    let wt = t.worktree_path.clone();
    let tid = t.id.clone();
    let tx = db_tx.inner().clone();

    flatten_join(
        tokio::task::spawn_blocking(move || {
            // Compute + cache merge base on first call so it survives PR merges
            let merge_base = match cached {
                Some(ref sha) => sha.clone(),
                None => {
                    let sha = git_ops::find_merge_base(&wt, &base)
                        .unwrap_or_default();
                    if !sha.is_empty() {
                        let _ = tx.try_send(db::DbWrite::SetMergeBaseSha {
                            id: tid,
                            sha: sha.clone(),
                        });
                    }
                    sha
                }
            };

            let cached_ref = if merge_base.is_empty() { None } else { Some(merge_base.as_str()) };
            git_ops::get_branch_commits(&wt, &base, cached_ref)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_commit_files(
    pool: State<'_, SqlitePool>,
    task_id: String,
    commit_hash: String,
) -> Result<git_ops::GitStatus, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::get_commit_files(&t.worktree_path, &commit_hash))
            .await,
    )
}

#[tauri::command]
pub async fn get_commit_file_diff(
    pool: State<'_, SqlitePool>,
    task_id: String,
    commit_hash: String,
    file_path: String,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<git_ops::FileDiff, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_commit_file_diff(&t.worktree_path, &commit_hash, &file_path, context_lines, ignore_whitespace)
        })
            .await,
    )
}

#[tauri::command]
pub async fn get_file_diff_contents(
    pool: State<'_, SqlitePool>,
    task_id: String,
    file_path: String,
) -> Result<git_ops::DiffContents, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_file_diff_contents(&t.worktree_path, &file_path)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_commit_file_contents(
    pool: State<'_, SqlitePool>,
    task_id: String,
    commit_hash: String,
    file_path: String,
) -> Result<git_ops::DiffContents, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::get_commit_file_contents(&t.worktree_path, &commit_hash, &file_path)
        })
        .await,
    )
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_github(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Option<github::GitHubRepo>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::detect_github_repo(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn create_pull_request(
    pool: State<'_, SqlitePool>,
    task_id: String,
    title: String,
    body: String,
    base: String,
) -> Result<github::PrInfo, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            github::create_pr(&t.worktree_path, &title, &body, &base)
        })
        .await,
    )
}

#[tauri::command]
pub async fn mark_pr_ready(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::mark_pr_ready(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn merge_pull_request(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::merge_pr(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn get_pull_request(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Option<github::PrInfo>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::get_pr_for_branch(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn git_ship(
    pool: State<'_, SqlitePool>,
    task_id: String,
    commit_message: String,
    pr_title: String,
    pr_body: String,
    base: String,
) -> Result<github::PrInfo, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            // Stage all
            git_ops::stage_all(&t.worktree_path)?;
            // Commit (may fail if nothing to commit, that's ok for ship)
            let _ = git_ops::commit(&t.worktree_path, &commit_message);
            // Push
            git_ops::push_branch(&t.worktree_path)?;
            // Create PR
            github::create_pr(&t.worktree_path, &pr_title, &pr_body, &base)
        })
        .await,
    )
}

#[tauri::command]
pub async fn get_ci_checks(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<github::CiCheck>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::get_ci_checks(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn get_branch_url(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Option<String>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::get_branch_url(&t.worktree_path)).await,
    )
}

#[tauri::command]
pub async fn has_conflicts(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<bool, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::has_conflicts(&t.worktree_path)).await,
    )
}

// ---------------------------------------------------------------------------
// PTY / Terminal
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    pty_map: State<'_, ActivePtyMap>,
    task_id: String,
    rows: u16,
    cols: u16,
    initial_command: Option<String>,
    direct_command: Option<bool>,
) -> Result<pty::SpawnResult, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let repo_path = db::get_repo_path_for_task(pool.inner(), &task_id).await?;
    let env_vars = worktree::verun_env_vars(t.port_offset, &repo_path);
    let map = pty_map.inner().clone();
    let direct = direct_command.unwrap_or(false);
    flatten_join(
        tokio::task::spawn_blocking(move || {
            pty::spawn_pty(app, map, task_id, t.worktree_path, rows, cols, initial_command, env_vars, direct)
        })
        .await,
    )
}

#[tauri::command]
pub async fn pty_write(
    pty_map: State<'_, ActivePtyMap>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let map = pty_map.inner().clone();
    flatten_join(
        tokio::task::spawn_blocking(move || pty::write_pty(&map, &terminal_id, data.as_bytes()))
            .await,
    )
}

#[tauri::command]
pub async fn pty_resize(
    pty_map: State<'_, ActivePtyMap>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = pty_map.inner().clone();
    flatten_join(
        tokio::task::spawn_blocking(move || pty::resize_pty(&map, &terminal_id, rows, cols))
            .await,
    )
}

#[tauri::command]
pub async fn pty_close(
    pty_map: State<'_, ActivePtyMap>,
    terminal_id: String,
) -> Result<(), String> {
    let map = pty_map.inner().clone();
    flatten_join(
        tokio::task::spawn_blocking(move || pty::close_pty(&map, &terminal_id)).await,
    )
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn read_clipboard() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("pbpaste").output();
    #[cfg(target_os = "linux")]
    let output = std::process::Command::new("xclip").args(["-selection", "clipboard", "-o"]).output();
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("powershell").args(["-command", "Get-Clipboard"]).output();

    let output = output.map_err(|e| format!("Failed to read clipboard: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn ext_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn request_bytes<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        _ => Err("Expected raw binary body".to_string()),
    }
}

fn header_str(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn copy_image_to_clipboard(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let mime_type = header_str(&request, "mime-type").ok_or("Missing mime-type header")?;
    let bytes = request_bytes(&request)?;

    #[cfg(target_os = "macos")]
    {
        let ext = ext_for_mime(&mime_type);
        let tmp = std::env::temp_dir().join(format!("verun-clip-{}.{}", Uuid::new_v4(), ext));
        std::fs::write(&tmp, bytes).map_err(|e| format!("Failed to write temp file: {e}"))?;
        let posix = tmp.to_string_lossy().replace('"', "\\\"");
        // PNGf is the universal pasteboard image flavor on macOS; AppKit will
        // accept jpeg/gif/webp bytes flagged this way for the standard image pasteboards
        // we whitelist on the frontend.
        let script = format!(
            "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
            posix
        );
        let result = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
        let _ = std::fs::remove_file(&tmp);
        let output = result.map_err(|e| format!("Failed to run osascript: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "osascript failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes, mime_type);
        Err("Image clipboard copy is only supported on macOS".to_string())
    }
}

#[tauri::command]
pub async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = header_str(&request, "path").ok_or("Missing path header")?;
    let bytes = request_bytes(&request)?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
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
pub async fn reload_env_path() -> Result<(), String> {
    // Run on a blocking thread so we don't stall the tokio runtime — the
    // shell capture is ~50ms but a hostile .zshrc could take longer.
    tokio::task::spawn_blocking(crate::env_path::reload_now)
        .await
        .map_err(|e| format!("reload task failed: {e}"))
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
pub async fn list_worktree_files(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<String>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            let output = std::process::Command::new("git")
                .current_dir(&t.worktree_path)
                .env_remove("GIT_DIR")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_WORK_TREE")
                .args(["ls-files", "--cached", "--others", "--exclude-standard"])
                .output()
                .map_err(|e| format!("Failed to list files: {e}"))?;

            if !output.status.success() {
                return Err(format!(
                    "git ls-files failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }

            Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|l| l.to_string())
                .collect())
        })
        .await,
    )
}

#[tauri::command]
pub async fn check_gitignored(
    pool: State<'_, SqlitePool>,
    task_id: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new("git");
            cmd.current_dir(&t.worktree_path)
                .env_remove("GIT_DIR")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_WORK_TREE")
                .args(["check-ignore", "--stdin"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());

            let mut child =
                cmd.spawn().map_err(|e| format!("Failed to run git check-ignore: {e}"))?;
            {
                use std::io::Write;
                let stdin = child.stdin.as_mut().unwrap();
                for p in &paths {
                    writeln!(stdin, "{p}").ok();
                }
            }

            let output = child
                .wait_with_output()
                .map_err(|e| format!("git check-ignore failed: {e}"))?;

            // git check-ignore exits 1 if no paths are ignored — not an error
            Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|l| l.to_string())
                .collect())
        })
        .await,
    )
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&path).spawn();

    result.map_err(|e| format!("Failed to open file manager: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_in_app(path: String, app: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-a").arg(&app).arg(&path).spawn();
    #[cfg(not(target_os = "macos"))]
    let result = std::process::Command::new(&app).arg(&path).spawn();

    result.map_err(|e| format!("Failed to open {app}: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
}

#[tauri::command]
pub async fn list_directory(
    pool: State<'_, SqlitePool>,
    task_id: String,
    relative_path: String,
) -> Result<Vec<FileEntry>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            use ignore::WalkBuilder;

            let base = std::path::Path::new(&t.worktree_path).join(&relative_path);
            if !base.exists() {
                return Err(format!("Directory not found: {relative_path}"));
            }

            let mut entries = Vec::new();
            for result in WalkBuilder::new(&base).max_depth(Some(1)).hidden(false).build() {
                let entry = result.map_err(|e| format!("Walk error: {e}"))?;
                // Skip the root directory itself
                if entry.path() == base {
                    continue;
                }
                let meta = entry.metadata().map_err(|e| format!("Metadata error: {e}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = entry
                    .path()
                    .strip_prefix(&t.worktree_path)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .to_string();

                entries.push(FileEntry {
                    name,
                    relative_path: rel,
                    is_dir: meta.is_dir(),
                    is_symlink: meta.is_symlink(),
                    size: if meta.is_file() { Some(meta.len()) } else { None },
                });
            }

            // Sort: directories first, then alphabetical (case-insensitive)
            entries.sort_by(|a, b| {
                b.is_dir.cmp(&a.is_dir).then_with(|| {
                    a.name.to_lowercase().cmp(&b.name.to_lowercase())
                })
            });

            Ok(entries)
        })
        .await,
    )
}

#[tauri::command]
pub async fn read_worktree_file(
    pool: State<'_, SqlitePool>,
    task_id: String,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let full_path = std::path::Path::new(&t.worktree_path).join(&relative_path);

    // Safety: ensure the resolved path is within the worktree
    let canonical_base = std::fs::canonicalize(&t.worktree_path)
        .map_err(|e| format!("Cannot resolve worktree: {e}"))?;
    if let Ok(canonical_file) = std::fs::canonicalize(&full_path) {
        if !canonical_file.starts_with(&canonical_base) {
            return Err("Path escapes worktree boundary".into());
        }
    }

    let limit = max_bytes.unwrap_or(50_000) as usize;
    let bytes = tokio::fs::read(&full_path)
        .await
        .map_err(|e| format!("Failed to read {relative_path}: {e}"))?;

    let truncated = bytes.len() > limit;
    let slice = if truncated { &bytes[..limit] } else { &bytes[..] };

    let text = String::from_utf8(slice.to_vec())
        .map_err(|_| "Binary file — preview not available".to_string())?;

    if truncated {
        Ok(format!("{text}\n… (truncated)"))
    } else {
        Ok(text)
    }
}

#[tauri::command]
pub async fn resolve_worktree_file_path(
    pool: State<'_, SqlitePool>,
    task_id: String,
    relative_path: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let full_path = std::path::Path::new(&t.worktree_path).join(&relative_path);

    let canonical_base = std::fs::canonicalize(&t.worktree_path)
        .map_err(|e| format!("Cannot resolve worktree: {e}"))?;
    let canonical_file = std::fs::canonicalize(&full_path)
        .map_err(|e| format!("Cannot resolve file: {e}"))?;

    if !canonical_file.starts_with(&canonical_base) {
        return Err("Path escapes worktree boundary".into());
    }

    Ok(canonical_file.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn write_text_file(
    pool: State<'_, SqlitePool>,
    task_id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let full_path = std::path::Path::new(&t.worktree_path).join(&relative_path);

    // Safety: ensure the resolved path is within the worktree
    let canonical_base = std::fs::canonicalize(&t.worktree_path)
        .map_err(|e| format!("Cannot resolve worktree: {e}"))?;
    if let Ok(canonical_file) = std::fs::canonicalize(full_path.parent().unwrap_or(&full_path)) {
        if !canonical_file.starts_with(&canonical_base) {
            return Err("Path escapes worktree boundary".into());
        }
    }

    tokio::fs::write(&full_path, &content)
        .await
        .map_err(|e| format!("Failed to write {relative_path}: {e}"))
}

#[tauri::command]
pub async fn watch_worktree(
    pool: State<'_, SqlitePool>,
    watchers: State<'_, FileWatcherMap>,
    app: AppHandle,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    crate::watcher::start_watching(&watchers, app, task_id, t.worktree_path)
}

#[tauri::command]
pub async fn unwatch_worktree(
    watchers: State<'_, FileWatcherMap>,
    task_id: String,
) -> Result<(), String> {
    watchers.remove(&task_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn lsp_start(
    lsp_map: State<'_, LspMap>,
    app: AppHandle,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    crate::lsp::start_server(&lsp_map, app, task_id, worktree_path).await
}

#[tauri::command]
pub async fn lsp_send(
    lsp_map: State<'_, LspMap>,
    task_id: String,
    message: String,
) -> Result<(), String> {
    crate::lsp::send_message(&lsp_map, &task_id, &message).await
}

#[tauri::command]
pub async fn lsp_stop(
    lsp_map: State<'_, LspMap>,
    task_id: String,
) -> Result<(), String> {
    crate::lsp::stop_server(&lsp_map, &task_id).await;
    Ok(())
}

#[tauri::command]
pub fn quit_app() {
    std::process::exit(0);
}

// ── Notifications ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("notification failed: {e}"))
}

// ── Steps ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_steps(
    pool: State<'_, SqlitePool>,
    session_id: String,
) -> Result<Vec<Step>, String> {
    db::list_steps(pool.inner(), &session_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_step(
    db_tx: State<'_, DbWriteTx>,
    id: String,
    session_id: String,
    message: String,
    attachments_json: Option<String>,
    armed: bool,
    model: Option<String>,
    plan_mode: Option<bool>,
    thinking_mode: Option<bool>,
    fast_mode: Option<bool>,
    sort_order: i64,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::InsertStep(Step {
            id,
            session_id,
            message,
            attachments_json,
            armed,
            model,
            plan_mode,
            thinking_mode,
            fast_mode,
            sort_order,
            created_at: epoch_ms(),
        }))
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_step(
    db_tx: State<'_, DbWriteTx>,
    id: String,
    message: String,
    armed: bool,
    model: Option<String>,
    plan_mode: Option<bool>,
    thinking_mode: Option<bool>,
    fast_mode: Option<bool>,
    attachments_json: Option<String>,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateStep { id, message, armed, model, plan_mode, thinking_mode, fast_mode, attachments_json })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn delete_step(
    db_tx: State<'_, DbWriteTx>,
    id: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::DeleteStep { id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn reorder_steps(
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::ReorderSteps { session_id, ids })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn disarm_all_steps(
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::DisarmAllSteps { session_id })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_task_window(
    app: AppHandle,
    task_id: String,
    task_name: Option<String>,
) -> Result<(), String> {
    let label = format!("task-{task_id}");

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().map_err(|e| format!("Failed to focus window: {e}"))?;
        return Ok(());
    }

    let title = task_name.unwrap_or_else(|| "Task".into());
    let url = format!("index.html?windowType=task&taskId={task_id}&windowLabel={label}");

    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay);
    builder
        .build()
        .map_err(|e| format!("Failed to create task window: {e}"))?;

    // Track label → taskId so the close handler can emit the right event
    if let Some(map) = app.try_state::<crate::WindowTaskMap>() {
        map.insert(label, task_id.clone());
    }

    let _ = app.emit(
        "task-window-changed",
        serde_json::json!({ "taskId": task_id, "open": true }),
    );

    Ok(())
}

#[tauri::command]
pub async fn open_new_task_window(
    app: AppHandle,
    project_id: String,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let label = format!("task-new-{id}");
    let url = format!(
        "index.html?windowType=task&projectId={project_id}&windowLabel={label}"
    );

    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("New Task")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay);
    builder
        .build()
        .map_err(|e| format!("Failed to create new task window: {e}"))?;

    Ok(())
}

/// Force-close a task window, cleaning up the window-task map and notifying the main window.
/// Used when the user confirms closing while a setup hook is running.
#[tauri::command]
pub async fn force_close_task_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if let Some(map) = app.try_state::<crate::WindowTaskMap>() {
        if let Some((_, task_id)) = map.remove(window.label()) {
            let _ = app.emit(
                "task-window-changed",
                serde_json::json!({ "taskId": task_id, "open": false }),
            );
        }
    }
    window.destroy().map_err(|e| format!("Failed to destroy window: {e}"))
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
