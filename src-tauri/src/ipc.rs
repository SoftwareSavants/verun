use crate::db::{self, DbWriteTx, OutputLine, Project, Session, Step, Task};
use crate::file_search::{SearchMap, SearchOpts};
use crate::git_ops;
use crate::github;
use crate::github_remote;
use crate::lsp::LspMap;
use crate::claude_terminal::{self, ClaudeTerminalMap, OpenClaudeTerminalResult};
use crate::pty::{self, ActivePtyMap};
use crate::task::{
    self, ActiveMap, ApprovalResponse, HookPtyMap, PendingApprovalEntry, PendingApprovalMeta,
    PendingApprovals, PendingControlResponses, SetupInProgress,
};
use crate::tsgo_check::TsgoCheckMap;
use crate::watcher::FileWatcherMap;
use crate::worktree;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task::JoinError;
use uuid::Uuid;

fn flatten_join<T>(result: Result<Result<T, String>, JoinError>) -> Result<T, String> {
    result.map_err(|e| format!("Task join error: {e}"))?
}

fn emit_git_local_changed(app: &AppHandle, task_id: &str) {
    let _ = app.emit(
        "git-local-changed",
        crate::stream::GitStatusChangedEvent {
            task_id: task_id.to_string(),
            remote_likely_changed: false,
        },
    );
}

fn emit_github_remote_invalidated(app: &AppHandle, task_id: &str, scopes: &[&str]) {
    let _ = app.emit(
        "github-remote-invalidated",
        crate::stream::GitHubRemoteInvalidatedEvent {
            task_id: task_id.to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
        },
    );
}

fn github_remote_invalidator(
    app: &AppHandle,
) -> github_remote::InvalidateFn {
    let app = app.clone();
    Arc::new(move |task_id, scopes| {
        let _ = app.emit(
            "github-remote-invalidated",
            crate::stream::GitHubRemoteInvalidatedEvent { task_id, scopes },
        );
    })
}

fn github_remote_debugger(app: &AppHandle) -> github_remote::DebugFn {
    let app = app.clone();
    Arc::new(move |event| {
        let _ = app.emit("github-remote-debug", event);
    })
}

/// Reject the operation if the task is a pinned workspace. Pinned workspaces
/// (main repo and long-lived branches) never go through archive/merge/PR flows.
fn reject_if_pinned(task: &Task, op: &str) -> Result<(), String> {
    if task.is_pinned {
        return Err(format!("pinned workspaces cannot be {op}"));
    }
    Ok(())
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
    app: AppHandle,
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
        default_agent_type: crate::agent::AgentKind::Claude.as_str().to_string(),
    };

    db_tx
        .send(db::DbWrite::InsertProject(project.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Seed the main pinned task (worktree == repo root). Mirrors the v20
    // migration backfill for pre-existing projects.
    let main_task = task::build_main_pinned_task(&project, 0);
    db_tx
        .send(db::DbWrite::InsertTask(main_task.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let _ = app.emit(
        "task-created",
        serde_json::json!({
            "taskId": main_task.id,
            "projectId": main_task.project_id,
            "sourceWindow": serde_json::Value::Null,
        }),
    );

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
        task::delete_task(
            &app,
            pool.inner(),
            db_tx.inner(),
            active.inner(),
            &project.repo_path,
            t,
            &project.destroy_hook,
            true,
            false,
        )
        .await?;
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
        .send(db::DbWrite::UpdateProjectHooks {
            id,
            setup_hook,
            destroy_hook,
            start_command,
            auto_start,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn update_project_default_agent(
    db_tx: State<'_, DbWriteTx>,
    id: String,
    default_agent_type: String,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateProjectDefaultAgent {
            id,
            default_agent_type,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

/// Export current DB hooks to .verun.json. Writes to `task_id`'s worktree when
/// provided, otherwise to the project repo root.
#[tauri::command]
pub async fn export_project_config(
    pool: State<'_, SqlitePool>,
    project_id: String,
    task_id: Option<String>,
) -> Result<(), String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let task = match task_id.as_deref() {
        Some(tid) => Some(
            db::get_task(pool.inner(), tid)
                .await?
                .ok_or_else(|| format!("Task {tid} not found"))?,
        ),
        None => None,
    };

    let config = serde_json::json!({
        "hooks": {
            "setup": &project.setup_hook,
            "destroy": &project.destroy_hook,
        },
        "startCommand": &project.start_command,
    });
    let pretty = serde_json::to_string_pretty(&config).unwrap_or_default();
    let config_path = resolve_config_path(
        &project.repo_path,
        task.as_ref().map(|t| t.worktree_path.as_str()),
    );
    std::fs::write(&config_path, format!("{pretty}\n"))
        .map_err(|e| format!("Failed to write .verun.json: {e}"))
}

/// Resolve which `.verun.json` to read/write: a task's worktree when
/// `task_worktree_path` is `Some`, otherwise the project's repo root.
fn resolve_config_path(repo_path: &str, task_worktree_path: Option<&str>) -> String {
    let base = task_worktree_path.unwrap_or(repo_path);
    format!("{base}/.verun.json")
}

/// Import .verun.json into DB. Reads from `task_id`'s worktree when provided,
/// otherwise from the project repo root. Returns the imported hooks.
#[tauri::command]
pub async fn import_project_config(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    project_id: String,
    task_id: Option<String>,
) -> Result<ImportedHooks, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let task = match task_id.as_deref() {
        Some(tid) => Some(
            db::get_task(pool.inner(), tid)
                .await?
                .ok_or_else(|| format!("Task {tid} not found"))?,
        ),
        None => None,
    };

    let config_path = resolve_config_path(
        &project.repo_path,
        task.as_ref().map(|t| t.worktree_path.as_str()),
    );
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

    Ok(ImportedHooks {
        setup_hook: setup,
        destroy_hook: destroy,
        start_command: start,
    })
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
    agent_type: Option<String>,
) -> Result<TaskWithSession, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let from_task_window = window.label().starts_with("task-");
    let source_window = window.label().to_string();

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
            agent_type: agent_type
                .unwrap_or_else(|| crate::agent::AgentKind::Claude.as_str().to_string()),
            source_window,
        },
    )
    .await?;

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

    reject_if_pinned(&t, "deleted")?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::delete_task(
        &app,
        pool.inner(),
        db_tx.inner(),
        active.inner(),
        &project.repo_path,
        &t,
        &project.destroy_hook,
        delete_branch,
        skip_destroy_hook.unwrap_or(false),
    )
    .await
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

    reject_if_pinned(&t, "archived")?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    task::archive_task(
        &app,
        pool.inner(),
        db_tx.inner(),
        active.inner(),
        &t,
        &project.destroy_hook,
        &project.repo_path,
        skip_destroy_hook.unwrap_or(false),
    )
    .await
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
    tokio::task::spawn_blocking(move || worktree::check_worktree_exists(&rp, &wtp, &branch))
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
    let _ = app.emit("task-name", crate::stream::TaskNameEvent { task_id, name });
    Ok(())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Create a new session (no process spawned — call send_message to talk to Claude)
#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    db_tx: State<'_, DbWriteTx>,
    task_id: String,
    agent_type: String,
    model: Option<String>,
) -> Result<Session, String> {
    task::create_session(&app, db_tx.inner(), task_id, agent_type, model).await
}

/// Fork an existing session at a specific assistant message uuid into a new
/// session inside the SAME task. The worktree is unchanged.
#[tauri::command]
pub async fn fork_session_in_task(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    session_id: String,
    fork_after_message_uuid: String,
) -> Result<Session, String> {
    task::fork_session_in_task(&app, pool.inner(), session_id, fork_after_message_uuid).await
}

/// Fork an existing session at a specific assistant message uuid into a new
/// task with its own worktree. `worktree_state` controls whether the new
/// worktree is restored to the per-turn snapshot ("snapshot") or seeded from
/// the parent's current code ("current"). After the fork completes, the
/// project's setup hook is spawned on the new worktree so dependencies,
/// `.env` files, etc. are installed — same treatment as a fresh task.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn fork_session_to_new_task(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    pty_map: State<'_, ActivePtyMap>,
    hook_pty_map: State<'_, HookPtyMap>,
    setup_in_progress: State<'_, SetupInProgress>,
    session_id: String,
    fork_after_message_uuid: String,
    worktree_state: task::WorktreeForkState,
) -> Result<TaskWithSession, String> {
    let (new_task, new_session) = task::fork_session_to_new_task(
        &app,
        pool.inner(),
        session_id,
        fork_after_message_uuid,
        worktree_state,
    )
    .await?;

    // Spawn the project's setup hook on the new worktree so gitignored
    // files (node_modules, .env, build artifacts) are materialized the same
    // way a fresh task's worktree gets them. Without this, forked tasks
    // look broken for any project with non-trivial setup.
    if let Some(project) = db::get_project(pool.inner(), &new_task.project_id).await? {
        task::spawn_setup_hook(
            &app,
            pty_map.inner(),
            hook_pty_map.inner(),
            setup_in_progress.inner(),
            &new_task.id,
            &new_task.worktree_path,
            &project.setup_hook,
            new_task.port_offset,
            &project.repo_path,
        );
    }

    Ok(TaskWithSession {
        task: new_task,
        session: new_session,
    })
}

/// Send a message to Claude in this session.
/// Spawns claude -p with --resume if we have a prior session_id.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    app_data: State<'_, crate::blob::AppDataDir>,
    active: State<'_, ActiveMap>,
    pending: State<'_, PendingApprovals>,
    pending_meta: State<'_, PendingApprovalMeta>,
    pending_ctrl: State<'_, PendingControlResponses>,
    session_id: String,
    message: String,
    attachments: Option<Vec<task::AttachmentRef>>,
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

    let (trust_result, repo_result) = tokio::join!(
        db::get_trust_level(pool.inner(), &session.task_id),
        db::get_repo_path_for_task(pool.inner(), &session.task_id),
    );
    let trust_str = trust_result?;
    let trust_level = crate::policy::TrustLevel::from_str(&trust_str);
    let repo_path = repo_result?;

    let refs = attachments.unwrap_or_default();
    let resolved = task::resolve_attachments(&refs, &app_data.0).await?;

    task::send_message(
        app,
        db_tx.inner(),
        active.inner().clone(),
        pending.inner().clone(),
        pending_meta.inner().clone(),
        pending_ctrl.inner().clone(),
        task::SendMessageParams {
            session_id,
            task_id: session.task_id.clone(),
            project_id: t.project_id,
            worktree_path: t.worktree_path,
            repo_path,
            port_offset: t.port_offset,
            trust_level,
            message,
            resume_session_id: session.resume_session_id,
            attachments: resolved,
            model,
            plan_mode: plan_mode.unwrap_or(false),
            thinking_mode: thinking_mode.unwrap_or(false),
            fast_mode: fast_mode.unwrap_or(false),
            task_name: t.name,
            agent_type: session.agent_type.clone(),
        },
    )
    .await
}

/// Pre-warm a persistent-agent session by spawning its CLI in the background
/// so the first `send_message` doesn't pay the boot cost. Best-effort: no-op
/// for non-persistent agents (Codex/Gemini/Cursor), already-warm sessions, or
/// any failure — the normal spawn path will take over on the next send.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn prewarm_session(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    pending: State<'_, PendingApprovals>,
    pending_meta: State<'_, PendingApprovalMeta>,
    pending_ctrl: State<'_, PendingControlResponses>,
    session_id: String,
) -> Result<(), String> {
    let session = match db::get_session(pool.inner(), &session_id).await? {
        Some(s) => s,
        None => return Ok(()), // session closed or gone
    };

    let agent = crate::agent::AgentKind::parse(&session.agent_type).implementation();
    if !agent.persists_across_turns() {
        return Ok(());
    }
    if active.contains_key(&session_id) {
        return Ok(()); // already warm
    }

    let t = match db::get_task(pool.inner(), &session.task_id).await? {
        Some(t) => t,
        None => return Ok(()),
    };
    let (trust_result, repo_result) = tokio::join!(
        db::get_trust_level(pool.inner(), &session.task_id),
        db::get_repo_path_for_task(pool.inner(), &session.task_id),
    );
    let trust_level = crate::policy::TrustLevel::from_str(&trust_result?);
    let repo_path = repo_result?;

    task::spawn_session_process(
        app,
        db_tx.inner().clone(),
        active.inner().clone(),
        pending.inner().clone(),
        pending_meta.inner().clone(),
        pending_ctrl.inner().clone(),
        task::SpawnSessionParams {
            session_id,
            task_id: session.task_id.clone(),
            project_id: t.project_id,
            worktree_path: t.worktree_path,
            repo_path,
            port_offset: t.port_offset,
            trust_level,
            resume_session_id: session.resume_session_id,
            model: session.model,
            plan_mode: false,
            thinking_mode: false,
            fast_mode: false,
            agent_type: session.agent_type.clone(),
            message: String::new(),
            attachments: Vec::new(),
            prewarm: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn update_session_model(
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
    model: Option<String>,
) -> Result<(), String> {
    db_tx
        .send(db::DbWrite::UpdateSessionModel {
            id: session_id,
            model,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

/// Close a session (hides from UI, persists in DB as 'closed')
#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    active: State<'_, ActiveMap>,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<(), String> {
    // Persistent agents keep a live CLI across turns — kill it before DB close
    // so we don't leak a pid after the tab disappears.
    if let Some((_, mut proc)) = active.remove(&session_id) {
        task::graceful_shutdown(&mut proc.child, &proc.stdin).await;
    }
    let task_id = db::get_session(pool.inner(), &session_id)
        .await?
        .map(|s| s.task_id);
    db_tx
        .send(db::DbWrite::CloseSession {
            id: session_id.clone(),
            closed_at: task::epoch_ms(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let _ = app.emit(
        "session-removed",
        serde_json::json!({ "sessionId": session_id, "taskId": task_id }),
    );
    Ok(())
}

/// Clear a session's Claude context (reset session_id + delete output lines)
#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    active: State<'_, ActiveMap>,
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<(), String> {
    // If a persistent CLI is running on the old session, shut it down so the
    // next message starts fresh instead of resuming the old context.
    if let Some((_, mut proc)) = active.remove(&session_id) {
        task::graceful_shutdown(&mut proc.child, &proc.stdin).await;
    }

    // Clear the resume_session_id so next message starts fresh
    db_tx
        .send(db::DbWrite::SetResumeSessionId {
            id: session_id.clone(),
            resume_session_id: String::new(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let _ = app.emit(
        "session-resume-id",
        crate::stream::SessionResumeIdEvent {
            session_id: session_id.clone(),
            resume_session_id: String::new(),
        },
    );

    // Clear persisted output lines
    db_tx
        .send(db::DbWrite::DeleteOutputLines { session_id })
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

/// Send a `control_request` `interrupt` to a running claude CLI. Cancels the
/// current turn without killing the process, so the session can keep going on
/// the next message.
#[tauri::command]
pub async fn interrupt_session(
    active: State<'_, ActiveMap>,
    session_id: String,
) -> Result<(), String> {
    task::interrupt_session(active.inner(), &session_id).await
}

/// Ask the running claude CLI for its current context-window usage and wait
/// for the matching `control_response`.
#[tauri::command]
pub async fn get_session_context_usage(
    active: State<'_, ActiveMap>,
    pending_ctrl: State<'_, PendingControlResponses>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    task::get_session_context_usage(active.inner(), pending_ctrl.inner(), &session_id).await
}

/// Return session IDs that currently have an active process
#[tauri::command]
pub async fn get_active_sessions(active: State<'_, ActiveMap>) -> Result<Vec<String>, String> {
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
    message: Option<String>,
) -> Result<(), String> {
    if let Some((_, tx)) = pending.remove(&request_id) {
        let _ = tx.send(ApprovalResponse {
            behavior,
            updated_input,
            message,
        });
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
    Ok(pending_meta
        .iter()
        .map(|entry| entry.value().clone())
        .collect())
}

#[tauri::command]
pub async fn list_sessions(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<Session>, String> {
    db::list_sessions_for_task(pool.inner(), &task_id).await
}

#[tauri::command]
pub async fn list_closed_sessions(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<Session>, String> {
    db::list_closed_sessions_for_task(pool.inner(), &task_id).await
}

/// Reopen a closed session - flip its status back to 'idle' and broadcast
/// `session-created` so every window restores the tab.
#[tauri::command]
pub async fn reopen_session(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    session_id: String,
) -> Result<Session, String> {
    db_tx
        .send(db::DbWrite::ReopenSession {
            id: session_id.clone(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let session = db::get_session(pool.inner(), &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    let _ = app.emit("session-created", &session);
    Ok(session)
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
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<OutputLine>, String> {
    db::get_output_lines(pool.inner(), &session_id, limit, before_id).await
}

// ---------------------------------------------------------------------------
// Policy / Trust levels
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn set_trust_level(
    db_tx: State<'_, DbWriteTx>,
    active: State<'_, ActiveMap>,
    task_id: String,
    trust_level: String,
) -> Result<(), String> {
    // Validate
    match trust_level.as_str() {
        "normal" | "full_auto" | "supervised" => {}
        _ => {
            return Err(format!(
                "Invalid trust level: {trust_level}. Must be normal, full_auto, or supervised"
            ))
        }
    }

    // Push into live sessions so in-flight turns see the new value on the
    // next tool-approval check — no need to wait for the next send_message.
    let parsed = crate::policy::TrustLevel::from_str(&trust_level);
    for entry in active.iter() {
        if entry.value().task_id == task_id {
            entry
                .value()
                .trust_level
                .store(parsed.to_u8(), std::sync::atomic::Ordering::Relaxed);
        }
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
pub async fn get_diff(pool: State<'_, SqlitePool>, task_id: String) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(tokio::task::spawn_blocking(move || worktree::get_diff(&t.worktree_path)).await)
}

#[tauri::command]
pub async fn merge_branch(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    target_branch: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    reject_if_pinned(&t, "merged")?;

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    let branch = t.branch.clone();
    flatten_join(
        tokio::task::spawn_blocking(move || {
            worktree::merge_branch(&project.repo_path, &branch, &target_branch)
        })
        .await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn get_branch_status(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, db::DbWriteTx>,
    task_id: String,
) -> Result<(u32, u32, u32), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let last_pushed = t.last_pushed_sha.clone();
    let status = flatten_join(
        tokio::task::spawn_blocking(move || {
            worktree::get_branch_status(&t.worktree_path, last_pushed.as_deref())
        })
        .await,
    )?;

    if let Some(sha) = status.tracking_sha {
        let _ = db_tx.try_send(db::DbWrite::SetLastPushedSha { id: task_id, sha });
    }

    Ok((status.ahead, status.behind, status.unpushed))
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
                if line.contains("->") || line == "origin" {
                    continue;
                }
                let name = line.strip_prefix("origin/").unwrap_or(line);
                if name == "HEAD" || name.is_empty() {
                    continue;
                }
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
        tokio::task::spawn_blocking(move || {
            git_ops::get_file_diff(
                &t.worktree_path,
                &file_path,
                context_lines,
                ignore_whitespace,
            )
        })
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
    app: AppHandle,
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
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || git_ops::unstage_files(&t.worktree_path, &paths)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let hash = flatten_join(
        tokio::task::spawn_blocking(move || git_ops::commit(&t.worktree_path, &message)).await,
    )?;
    emit_git_local_changed(&app, &task_id);
    Ok(hash)
}

#[tauri::command]
pub async fn git_push(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, db::DbWriteTx>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let wt = t.worktree_path.clone();
    let tid = t.id.clone();
    let tx = db_tx.inner().clone();
    flatten_join(
        tokio::task::spawn_blocking(move || {
            git_ops::push_branch(&wt)?;
            if let Ok(sha) = worktree::get_head_sha(&wt) {
                let _ = tx.try_send(db::DbWrite::SetLastPushedSha { id: tid, sha });
            }
            Ok(())
        })
        .await,
    )?;
    db::invalidate_github_cache(
        pool.inner(),
        &task_id,
        &["overview", "actions", "jobs", "logs"],
    )
    .await?;
    emit_git_local_changed(&app, &task_id);
    emit_github_remote_invalidated(&app, &task_id, &["overview", "actions"]);
    Ok(())
}

#[tauri::command]
pub async fn git_pull(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let output = flatten_join(
        tokio::task::spawn_blocking(move || git_ops::pull_branch(&t.worktree_path)).await,
    )?;
    db::invalidate_github_cache(
        pool.inner(),
        &task_id,
        &["overview", "actions", "jobs", "logs"],
    )
    .await?;
    emit_git_local_changed(&app, &task_id);
    emit_github_remote_invalidated(&app, &task_id, &["overview", "actions"]);
    Ok(output)
}

#[tauri::command]
pub async fn git_commit_and_push(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    message: String,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let hash = flatten_join(
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
    )?;
    db::invalidate_github_cache(
        pool.inner(),
        &task_id,
        &["overview", "actions", "jobs", "logs"],
    )
    .await?;
    emit_git_local_changed(&app, &task_id);
    emit_github_remote_invalidated(&app, &task_id, &["overview", "actions"]);
    Ok(hash)
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
                    let sha = git_ops::find_merge_base(&wt, &base).unwrap_or_default();
                    if !sha.is_empty() {
                        let _ = tx.try_send(db::DbWrite::SetMergeBaseSha {
                            id: tid,
                            sha: sha.clone(),
                        });
                    }
                    sha
                }
            };

            let cached_ref = if merge_base.is_empty() {
                None
            } else {
                Some(merge_base.as_str())
            };
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
        tokio::task::spawn_blocking(move || {
            git_ops::get_commit_files(&t.worktree_path, &commit_hash)
        })
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
            git_ops::get_commit_file_diff(
                &t.worktree_path,
                &commit_hash,
                &file_path,
                context_lines,
                ignore_whitespace,
            )
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
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    title: String,
    body: String,
    base: String,
) -> Result<github::PrInfo, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    reject_if_pinned(&t, "opened as pull requests")?;

    let pr = flatten_join(
        tokio::task::spawn_blocking(move || {
            github::create_pr(&t.worktree_path, &title, &body, &base)
        })
        .await,
    )?;
    db::invalidate_github_cache(pool.inner(), &task_id, &["overview"]).await?;
    emit_github_remote_invalidated(&app, &task_id, &["overview"]);
    Ok(pr)
}

#[tauri::command]
pub async fn mark_pr_ready(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::mark_pr_ready(&t.worktree_path)).await,
    )?;
    db::invalidate_github_cache(pool.inner(), &task_id, &["overview"]).await?;
    emit_github_remote_invalidated(&app, &task_id, &["overview"]);
    Ok(())
}

#[tauri::command]
pub async fn merge_pull_request(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, db::DbWriteTx>,
    task_id: String,
    force: Option<bool>,
    delete_branch: Option<bool>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    reject_if_pinned(&t, "merged")?;

    let force = force.unwrap_or(false);
    let delete_branch = delete_branch.unwrap_or(false);
    let wt = t.worktree_path.clone();
    let tid = t.id.clone();
    let tx = db_tx.inner().clone();
    flatten_join(
        tokio::task::spawn_blocking(move || {
            if let Ok(sha) = worktree::get_head_sha(&wt) {
                let _ = tx.try_send(db::DbWrite::SetLastPushedSha { id: tid, sha });
            }
            github::merge_pr(&wt, force, delete_branch)
        })
        .await,
    )?;
    db::invalidate_github_cache(
        pool.inner(),
        &task_id,
        &["overview", "actions", "jobs", "logs"],
    )
    .await?;
    emit_git_local_changed(&app, &task_id);
    emit_github_remote_invalidated(&app, &task_id, &["overview", "actions"]);
    Ok(())
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
    app: AppHandle,
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

    let pr = flatten_join(
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
    )?;
    db::invalidate_github_cache(
        pool.inner(),
        &task_id,
        &["overview", "actions", "jobs", "logs"],
    )
    .await?;
    emit_git_local_changed(&app, &task_id);
    emit_github_remote_invalidated(&app, &task_id, &["overview", "actions"]);
    Ok(pr)
}

#[tauri::command]
pub async fn get_ci_checks(
    pool: State<'_, SqlitePool>,
    task_id: String,
) -> Result<Vec<github::CiCheck>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(tokio::task::spawn_blocking(move || github::get_ci_checks(&t.worktree_path)).await)
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
pub async fn has_conflicts(pool: State<'_, SqlitePool>, task_id: String) -> Result<bool, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(tokio::task::spawn_blocking(move || github::has_conflicts(&t.worktree_path)).await)
}

#[tauri::command]
pub async fn get_github_overview(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    mode: Option<String>,
) -> Result<github_remote::GitHubOverviewSnapshot, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let mode = github_remote::RemoteFetchMode::parse(mode.as_deref());

    github_remote::get_overview(
        pool.inner(),
        &task_id,
        &t.worktree_path,
        mode,
        Some(github_remote_invalidator(&app)),
        Some(github_remote_debugger(&app)),
    )
    .await
}

// ---------------------------------------------------------------------------
// GitHub Actions (workflow runs)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_github_actions(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    limit: Option<u32>,
    mode: Option<String>,
) -> Result<github_remote::GitHubActionsSnapshot, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let limit = limit.unwrap_or(25);
    let mode = github_remote::RemoteFetchMode::parse(mode.as_deref());

    github_remote::get_actions(
        pool.inner(),
        &task_id,
        &t.worktree_path,
        limit,
        mode,
        Some(github_remote_invalidator(&app)),
        Some(github_remote_debugger(&app)),
    )
    .await
}

#[tauri::command]
pub async fn get_github_workflow_jobs(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    run_id: u64,
    mode: Option<String>,
) -> Result<github_remote::WorkflowJobsSnapshot, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let mode = github_remote::RemoteFetchMode::parse(mode.as_deref());

    github_remote::get_workflow_jobs(
        pool.inner(),
        &task_id,
        &t.worktree_path,
        run_id,
        mode,
        Some(github_remote_invalidator(&app)),
        Some(github_remote_debugger(&app)),
    )
    .await
}

#[tauri::command]
pub async fn get_github_workflow_log(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    job_id: u64,
    max_bytes: Option<u32>,
    mode: Option<String>,
) -> Result<github_remote::WorkflowLogSnapshot, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let mode = github_remote::RemoteFetchMode::parse(mode.as_deref());

    github_remote::get_workflow_log(
        pool.inner(),
        &task_id,
        &t.worktree_path,
        job_id,
        max_bytes.unwrap_or(0) as usize,
        mode,
        Some(github_remote_invalidator(&app)),
        Some(github_remote_debugger(&app)),
    )
    .await
}

#[tauri::command]
pub async fn list_workflow_runs(
    pool: State<'_, SqlitePool>,
    task_id: String,
    limit: Option<u32>,
) -> Result<Vec<github::WorkflowRun>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let limit = limit.unwrap_or(25);

    flatten_join(
        tokio::task::spawn_blocking(move || {
            github::list_workflow_runs_for_branch(&t.worktree_path, limit)
        })
        .await,
    )
}

#[tauri::command]
pub async fn list_workflow_jobs(
    pool: State<'_, SqlitePool>,
    task_id: String,
    run_id: u64,
) -> Result<Vec<github::WorkflowJob>, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::list_jobs_for_run(&t.worktree_path, run_id))
            .await,
    )
}

#[tauri::command]
pub async fn get_workflow_failed_logs(
    pool: State<'_, SqlitePool>,
    task_id: String,
    _run_id: u64,
    job_id: u64,
    max_bytes: Option<u32>,
) -> Result<String, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    // Default 0 = "no truncation" (full log). Callers that need a tail (e.g. the
    // fix-prompt flow, which stuffs logs into a chat message) pass an explicit cap.
    let max_bytes = max_bytes.unwrap_or(0) as usize;

    flatten_join(
        tokio::task::spawn_blocking(move || {
            github::get_failed_step_logs(&t.worktree_path, job_id, max_bytes)
        })
        .await,
    )
}

#[tauri::command]
pub async fn rerun_workflow_run(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    run_id: u64,
    failed_only: Option<bool>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let failed_only = failed_only.unwrap_or(false);

    flatten_join(
        tokio::task::spawn_blocking(move || {
            github::rerun_workflow(&t.worktree_path, run_id, failed_only)
        })
        .await,
    )?;
    db::invalidate_github_cache(pool.inner(), &task_id, &["actions", "jobs", "logs"]).await?;
    emit_github_remote_invalidated(&app, &task_id, &["actions"]);
    Ok(())
}

#[tauri::command]
pub async fn rerun_workflow_job(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    job_id: u64,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::rerun_workflow_job(&t.worktree_path, job_id))
            .await,
    )?;
    db::invalidate_github_cache(pool.inner(), &task_id, &["actions", "jobs", "logs"]).await?;
    emit_github_remote_invalidated(&app, &task_id, &["actions"]);
    Ok(())
}

#[tauri::command]
pub async fn cancel_workflow_run(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    task_id: String,
    run_id: u64,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    flatten_join(
        tokio::task::spawn_blocking(move || github::cancel_workflow(&t.worktree_path, run_id))
            .await,
    )?;
    db::invalidate_github_cache(pool.inner(), &task_id, &["actions", "jobs", "logs"]).await?;
    emit_github_remote_invalidated(&app, &task_id, &["actions"]);
    Ok(())
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
    is_start_command: Option<bool>,
) -> Result<pty::SpawnResult, String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    let repo_path = db::get_repo_path_for_task(pool.inner(), &task_id).await?;
    let env_vars = worktree::verun_env_vars(t.port_offset, &repo_path);
    let map = pty_map.inner().clone();
    let direct = direct_command.unwrap_or(false);
    // Frontend sends is_start_command explicitly when spawning the project start
    // command. Fall back to `direct` for older callers that conflated the two.
    let start_cmd = is_start_command.unwrap_or(direct);
    let name_override = if start_cmd {
        Some("Dev Server".to_string())
    } else {
        None
    };
    flatten_join(
        tokio::task::spawn_blocking(move || {
            pty::spawn_pty(
                app,
                map,
                task_id,
                t.worktree_path,
                rows,
                cols,
                initial_command,
                env_vars,
                direct,
                name_override,
                start_cmd,
                None,
            )
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
        tokio::task::spawn_blocking(move || pty::resize_pty(&map, &terminal_id, rows, cols)).await,
    )
}

#[tauri::command]
pub async fn pty_close(
    pty_map: State<'_, ActivePtyMap>,
    terminal_id: String,
) -> Result<(), String> {
    let map = pty_map.inner().clone();
    flatten_join(tokio::task::spawn_blocking(move || pty::close_pty(&map, &terminal_id)).await)
}

/// Return all PTYs currently alive for a task, along with their replay buffers.
/// Called by a freshly-opened task window to hydrate its local terminal store
/// so the user sees existing shells (and their scrollback) instead of a new one
/// being spawned.
#[tauri::command]
pub async fn pty_list_for_task(
    pty_map: State<'_, ActivePtyMap>,
    task_id: String,
) -> Result<Vec<pty::PtyListEntry>, String> {
    let map = pty_map.inner().clone();
    flatten_join(tokio::task::spawn_blocking(move || Ok(pty::list_for_task(&map, &task_id))).await)
}

// ---------------------------------------------------------------------------
// Claude terminal mode
// ---------------------------------------------------------------------------

/// Open a Claude Code PTY for a session. Spawns `claude --resume <id>` in a
/// real terminal and starts tailing the on-disk JSONL so new messages still
/// reach the DB-backed UI view.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn claude_terminal_open(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    app_data: State<'_, crate::blob::AppDataDir>,
    db_tx: State<'_, DbWriteTx>,
    pty_map: State<'_, ActivePtyMap>,
    ct_map: State<'_, ClaudeTerminalMap>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<OpenClaudeTerminalResult, String> {
    claude_terminal::open_claude_terminal(
        app,
        pool.inner(),
        app_data.0.clone(),
        db_tx.inner().clone(),
        pty_map.inner().clone(),
        ct_map.inner().clone(),
        session_id,
        rows,
        cols,
    )
    .await
}

/// Close the Claude PTY for a session: kill the child process and stop the
/// transcript tailer. Idempotent.
#[tauri::command]
pub async fn claude_terminal_close(
    pty_map: State<'_, ActivePtyMap>,
    ct_map: State<'_, ClaudeTerminalMap>,
    session_id: String,
) -> Result<(), String> {
    claude_terminal::close_claude_terminal(
        pty_map.inner().clone(),
        ct_map.inner().clone(),
        session_id,
    )
    .await
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn read_clipboard() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("pbpaste").output();
    #[cfg(target_os = "linux")]
    let output = std::process::Command::new("xclip")
        .args(["-selection", "clipboard", "-o"])
        .output();
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("powershell")
        .args(["-command", "Get-Clipboard"])
        .output();

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

pub use crate::agent::AgentSkill;

#[tauri::command]
pub async fn list_agent_skills(
    agent_kind: String,
    scan_root: Option<String>,
) -> Result<Vec<AgentSkill>, String> {
    let kind = crate::agent::AgentKind::parse(&agent_kind);
    if !kind.implementation().supports_skills() {
        return Ok(vec![]);
    }
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return Ok(vec![]);
    };
    tokio::task::spawn_blocking(move || {
        let agent = kind.implementation();
        let root = scan_root.as_deref().map(std::path::Path::new);
        agent.discover_skills(root, &home)
    })
    .await
    .map_err(|e| format!("skill discovery task failed: {e}"))
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
pub async fn check_agent(agent_type: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let agent = crate::agent::AgentKind::parse(&agent_type).implementation();
        check_agent_impl(&*agent)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

fn check_agent_impl(agent: &dyn crate::agent::Agent) -> Result<String, String> {
    let output = std::process::Command::new(agent.cli_binary())
        .args(agent.version_args())
        .output()
        .map_err(|_| {
            format!(
                "{} CLI not found. {}",
                agent.display_name(),
                agent.install_hint()
            )
        })?;
    if !output.status.success() {
        return Err(format!("{} CLI returned an error", agent.display_name()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Cached agent detection result — populated once at startup, refreshed on demand.
pub type AgentCache = std::sync::Arc<std::sync::RwLock<Vec<AgentInfo>>>;

pub fn new_agent_cache() -> AgentCache {
    std::sync::Arc::new(std::sync::RwLock::new(Vec::new()))
}

/// Reload the user's shell PATH, then detect installed agents and store
/// the result in the cache. The ordering is load-bearing: GUI-launched
/// apps on macOS start with a stripped PATH, so running detection first
/// would mark agents installed in nvm/homebrew/~/.local/bin as missing.
pub async fn init_agents_cache<R, D>(cache: AgentCache, reload_path: R, detect: D) -> Vec<AgentInfo>
where
    R: FnOnce() + Send + 'static,
    D: FnOnce() -> Vec<AgentInfo> + Send + 'static,
{
    let agents = tokio::task::spawn_blocking(move || {
        reload_path();
        detect()
    })
    .await
    .unwrap_or_default();
    *cache.write().unwrap() = agents.clone();
    agents
}

/// Blocking detection of all agents — run via spawn_blocking at startup.
pub fn detect_all_agents() -> Vec<AgentInfo> {
    crate::agent::AgentKind::all()
        .iter()
        .map(|&kind| {
            let agent = kind.implementation();
            let cli_version = check_agent_impl(&*agent).ok();
            let installed = cli_version.is_some();

            let models = if installed {
                agent
                    .model_list_args()
                    .and_then(|args| {
                        std::process::Command::new(agent.cli_binary())
                            .args(&args)
                            .output()
                            .ok()
                    })
                    .map(|out| agent.parse_model_list(&String::from_utf8_lossy(&out.stdout)))
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| agent.available_models())
            } else {
                agent.available_models()
            };

            AgentInfo {
                id: kind.as_str().to_string(),
                name: agent.display_name().to_string(),
                install_hint: agent.install_hint().to_string(),
                update_hint: agent.update_hint().to_string(),
                docs_url: agent.docs_url().to_string(),
                models,
                installed,
                cli_version,
                supports_streaming: agent.supports_streaming(),
                supports_resume: agent.supports_resume(),
                supports_plan_mode: agent.supports_plan_mode(),
                supports_model_selection: agent.supports_model_selection(),
                supports_effort: agent.supports_effort(),
                supports_skills: agent.supports_skills(),
                supports_attachments: agent.supports_attachments(),
                supports_fork: agent.supports_fork(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn list_available_agents(cache: State<'_, AgentCache>) -> Result<Vec<AgentInfo>, String> {
    Ok(cache.read().unwrap().clone())
}

/// Kick off a background re-detection and return immediately.
/// Results arrive via the `agents-updated` event.
#[tauri::command]
pub async fn refresh_agents(
    cache: State<'_, AgentCache>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cache = std::sync::Arc::clone(&*cache);
    tauri::async_runtime::spawn(async move {
        let agents = init_agents_cache(cache, crate::env_path::reload_now, detect_all_agents).await;
        let _ = app.emit("agents-updated", agents);
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub install_hint: String,
    pub update_hint: String,
    pub docs_url: String,
    pub models: Vec<crate::agent::ModelOption>,
    pub installed: bool,
    pub cli_version: Option<String>,
    pub supports_streaming: bool,
    pub supports_resume: bool,
    pub supports_plan_mode: bool,
    pub supports_model_selection: bool,
    pub supports_effort: bool,
    pub supports_skills: bool,
    pub supports_attachments: bool,
    pub supports_fork: bool,
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

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to run git check-ignore: {e}"))?;
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
    let result = std::process::Command::new("open")
        .arg("-a")
        .arg(&app)
        .arg(&path)
        .spawn();
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

/// Build a `FileEntry` for a single path, resolving symlinks so that a link
/// pointing at a directory is reported as a directory (letting the UI expand it).
/// Broken symlinks keep `is_symlink = true` and fall back to `is_dir = false`.
fn build_file_entry(
    entry_path: &std::path::Path,
    worktree: &std::path::Path,
) -> std::io::Result<FileEntry> {
    let link_meta = std::fs::symlink_metadata(entry_path)?;
    let is_symlink = link_meta.file_type().is_symlink();

    // For symlinks, resolve to decide whether the target is a directory.
    let target_meta = if is_symlink {
        std::fs::metadata(entry_path).ok()
    } else {
        Some(link_meta.clone())
    };

    let is_dir = target_meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    let size = target_meta
        .as_ref()
        .and_then(|m| if m.is_file() { Some(m.len()) } else { None });

    let name = entry_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let relative_path = entry_path
        .strip_prefix(worktree)
        .unwrap_or(entry_path)
        .to_string_lossy()
        .to_string();

    Ok(FileEntry {
        name,
        relative_path,
        is_dir,
        is_symlink,
        size,
    })
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

            let worktree_path = std::path::Path::new(&t.worktree_path);
            let mut entries = Vec::new();
            for result in WalkBuilder::new(&base)
                .max_depth(Some(1))
                .hidden(false)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .build()
            {
                let entry = result.map_err(|e| format!("Walk error: {e}"))?;
                // Skip the root directory itself
                if entry.path() == base {
                    continue;
                }
                let file_entry = build_file_entry(entry.path(), worktree_path)
                    .map_err(|e| format!("Metadata error: {e}"))?;
                entries.push(file_entry);
            }

            // Sort: directories first, then alphabetical (case-insensitive)
            entries.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
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
    let slice = if truncated {
        &bytes[..limit]
    } else {
        &bytes[..]
    };

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
    let canonical_file =
        std::fs::canonicalize(&full_path).map_err(|e| format!("Cannot resolve file: {e}"))?;

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
pub async fn lsp_stop(lsp_map: State<'_, LspMap>, task_id: String) -> Result<(), String> {
    crate::lsp::stop_server(&lsp_map, &task_id).await;
    Ok(())
}

#[tauri::command]
pub async fn tsgo_check_run(
    map: State<'_, TsgoCheckMap>,
    app: AppHandle,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    let binary = crate::lsp::resolve_lsp_binary(&app)?;
    crate::tsgo_check::run_check(&map, app, binary, task_id, worktree_path).await
}

#[tauri::command]
pub async fn tsgo_check_cancel(
    map: State<'_, TsgoCheckMap>,
    task_id: String,
) -> Result<(), String> {
    crate::tsgo_check::cancel(&map, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn workspace_search_start(
    pool: State<'_, SqlitePool>,
    map: State<'_, SearchMap>,
    app: AppHandle,
    task_id: String,
    query: String,
    opts: Option<SearchOpts>,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    crate::file_search::start(
        map.inner().clone(),
        app,
        task_id,
        t.worktree_path,
        query,
        opts.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn workspace_search_cancel(
    map: State<'_, SearchMap>,
    task_id: String,
) -> Result<(), String> {
    crate::file_search::cancel(&map, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn quit_app(active: State<'_, ActiveMap>) -> Result<(), String> {
    // Persistent agents keep CLIs alive across turns; drain them all so we
    // don't leak orphan processes after the app exits.
    let session_ids: Vec<String> = active.iter().map(|e| e.key().clone()).collect();
    for sid in session_ids {
        if let Some((_, mut proc)) = active.remove(&sid) {
            task::graceful_shutdown(&mut proc.child, &proc.stdin).await;
        }
    }
    std::process::exit(0);
}

// ── Notifications ──────────────────────────────────────────────────────

/// Dev-only: directly emit the navigate-to-task event without going through
/// the notification system. Call from browser devtools to test click navigation:
///   await window.__TAURI_INTERNALS__.invoke('debug_navigate_to_task', { taskId: '...', sessionId: '...' })
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_navigate_to_task(
    app: AppHandle,
    task_id: String,
    session_id: String,
) -> Result<(), String> {
    #[derive(Clone, Serialize)]
    struct Payload {
        task_id: String,
        session_id: String,
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    app.emit(
        "navigate-to-task",
        Payload {
            task_id,
            session_id,
        },
    )
    .map_err(|e| e.to_string())
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
        .send(db::DbWrite::UpdateStep {
            id,
            message,
            armed,
            model,
            plan_mode,
            thinking_mode,
            fast_mode,
            attachments_json,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))
}

#[tauri::command]
pub async fn delete_step(db_tx: State<'_, DbWriteTx>, id: String) -> Result<(), String> {
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
        // unminimize + show first — set_focus alone is unreliable on macOS
        // when the window is minimized or behind another app.
        let _ = win.unminimize();
        let _ = win.show();
        win.set_focus()
            .map_err(|e| format!("Failed to focus window: {e}"))?;
        let _ = app.emit(
            "task-window-changed",
            serde_json::json!({ "taskId": task_id, "open": true }),
        );
        return Ok(());
    }

    let title = task_name.unwrap_or_else(|| "Task".into());
    let url = format!("index.html?windowType=task&taskId={task_id}&windowLabel={label}");

    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
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
pub async fn open_new_task_window(app: AppHandle, project_id: String) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let label = format!("task-new-{id}");
    let url = format!("index.html?windowType=task&projectId={project_id}&windowLabel={label}");

    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
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
    window
        .destroy()
        .map_err(|e| format!("Failed to destroy window: {e}"))
}

// ---------------------------------------------------------------------------
// Blob store (attachments)
// ---------------------------------------------------------------------------

use crate::blob::{self, AppDataDir, BlobRef, StorageStats};

/// Upload bytes into the content-addressed blob store. Returns a ref the
/// frontend can persist in a Step / OutputItem instead of inlining base64.
/// Idempotent: identical bytes yield the same hash and reuse the on-disk file.
#[tauri::command]
pub async fn upload_attachment(
    pool: State<'_, SqlitePool>,
    app_data: State<'_, AppDataDir>,
    mime: String,
    data: Vec<u8>,
) -> Result<BlobRef, String> {
    blob::write_blob(pool.inner(), &app_data.0, &mime, &data).await
}

/// Read bytes back from the blob store. The frontend calls this lazily when
/// rendering an attached image so the chat-view restore path doesn't load
/// every blob up front.
#[tauri::command]
pub async fn get_blob(app_data: State<'_, AppDataDir>, hash: String) -> Result<Vec<u8>, String> {
    blob::read_blob_bytes(&app_data.0, &hash).await
}

/// Aggregate counts and byte totals for the Storage Breakdown UI.
#[tauri::command]
pub async fn get_storage_stats(pool: State<'_, SqlitePool>) -> Result<StorageStats, String> {
    blob::get_storage_stats(pool.inner()).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GcReport {
    pub reclaimed_unreferenced: u64,
    pub reclaimed_capped: u64,
}

/// Run the blob GC sweep. `ttl_ms <= 0` skips the TTL pass; `max_bytes <= 0`
/// skips the cap pass. Returns counts so the UI can show a toast with what
/// was reclaimed.
#[tauri::command]
pub async fn run_blob_gc(
    pool: State<'_, SqlitePool>,
    app_data: State<'_, AppDataDir>,
    ttl_ms: i64,
    max_bytes: i64,
) -> Result<GcReport, String> {
    let reclaimed_unreferenced = blob::gc_unreferenced(pool.inner(), &app_data.0, ttl_ms).await?;
    let reclaimed_capped = blob::enforce_storage_cap(pool.inner(), &app_data.0, max_bytes).await?;
    Ok(GcReport {
        reclaimed_unreferenced,
        reclaimed_capped,
    })
}

/// One-shot rewrite of legacy base64 attachments into blob refs. Idempotent
/// via an `app_meta` sentinel — safe to call on every startup.
#[tauri::command]
pub async fn migrate_legacy_attachments(
    pool: State<'_, SqlitePool>,
    app_data: State<'_, AppDataDir>,
) -> Result<blob::MigrationReport, String> {
    blob::migrate_legacy_attachments(pool.inner(), &app_data.0).await
}

// ---------------------------------------------------------------------------
// Pinned workspaces (#61)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pin_branch(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    project_id: String,
    branch: String,
) -> Result<Task, String> {
    let task = task::pin_branch(db_tx.inner(), pool.inner(), &project_id, &branch).await?;
    let _ = app.emit(
        "task-created",
        serde_json::json!({
            "taskId": task.id,
            "projectId": task.project_id,
            "sourceWindow": serde_json::Value::Null,
        }),
    );
    Ok(task)
}

#[tauri::command]
pub async fn unpin_task(
    pool: State<'_, SqlitePool>,
    db_tx: State<'_, DbWriteTx>,
    task_id: String,
) -> Result<(), String> {
    let t = db::get_task(pool.inner(), &task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;

    if !t.is_pinned {
        return Err("task is not pinned".into());
    }

    let project = db::get_project(pool.inner(), &t.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", t.project_id))?;

    // The auto-created main task has worktree_path == repo_path. Unpinning it
    // would expose archive UI that would try to git-worktree-remove the repo
    // root — always reject.
    if t.worktree_path == project.repo_path {
        return Err("cannot unpin the main workspace".into());
    }

    db_tx
        .send(db::DbWrite::SetTaskPinned {
            id: task_id,
            pinned: false,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn list_local_branches(
    pool: State<'_, SqlitePool>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;

    let repo_path = project.repo_path.clone();
    let mut branches = flatten_join(
        tokio::task::spawn_blocking(move || worktree::list_local_branches(&repo_path)).await,
    )?;

    // Exclude branches that are already pinned for this project.
    let tasks = db::list_tasks_for_project(pool.inner(), &project_id).await?;
    let pinned: std::collections::HashSet<String> = tasks
        .iter()
        .filter(|t| t.is_pinned && !t.archived)
        .map(|t| t.branch.clone())
        .collect();
    branches.retain(|b| !pinned.contains(b));
    Ok(branches)
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

    #[cfg(unix)]
    #[test]
    fn build_file_entry_treats_symlinked_directory_as_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let target = root.join("real_dir");
        std::fs::create_dir(&target).unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let entry = build_file_entry(&link, root).unwrap();
        assert_eq!(entry.name, "linked");
        assert_eq!(entry.relative_path, "linked");
        assert!(entry.is_symlink, "entry should be flagged as a symlink");
        assert!(
            entry.is_dir,
            "symlinked directory should be reported as a directory so the UI can expand it"
        );
        assert!(entry.size.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn build_file_entry_handles_broken_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let link = root.join("dangling");
        std::os::unix::fs::symlink(root.join("does_not_exist"), &link).unwrap();

        let entry = build_file_entry(&link, root).unwrap();
        assert!(entry.is_symlink);
        assert!(!entry.is_dir, "broken symlink is not a directory");
        assert!(entry.size.is_none());
    }

    #[test]
    fn resolve_config_path_uses_repo_root_when_no_task() {
        let p = resolve_config_path("/tmp/repo", None);
        assert_eq!(p, "/tmp/repo/.verun.json");
    }

    #[test]
    fn resolve_config_path_uses_worktree_when_task_given() {
        let p = resolve_config_path(
            "/tmp/repo",
            Some("/tmp/repo/.verun/worktrees/silly-penguin"),
        );
        assert_eq!(p, "/tmp/repo/.verun/worktrees/silly-penguin/.verun.json");
    }

    #[test]
    fn build_file_entry_reports_regular_file_size() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = root.join("hello.txt");
        std::fs::write(&file, b"hi").unwrap();

        let entry = build_file_entry(&file, root).unwrap();
        assert!(!entry.is_dir);
        assert!(!entry.is_symlink);
        assert_eq!(entry.size, Some(2));
    }

    /// Regression: GUI-launched apps on macOS inherit a stripped PATH.
    /// If agent detection ran before env_path::reload_now finished, every
    /// installed agent looked missing and the startup toast lied. Ordering
    /// must be: reload PATH, then detect.
    #[tokio::test]
    async fn init_agents_cache_reloads_path_before_detecting() {
        use std::sync::{Arc, Mutex};

        let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let o_reload = Arc::clone(&order);
        let o_detect = Arc::clone(&order);

        let cache = new_agent_cache();

        init_agents_cache(
            Arc::clone(&cache),
            move || {
                o_reload.lock().unwrap().push("reload");
            },
            move || {
                o_detect.lock().unwrap().push("detect");
                Vec::new()
            },
        )
        .await;

        assert_eq!(
            *order.lock().unwrap(),
            vec!["reload", "detect"],
            "PATH reload must complete before agent detection runs"
        );
    }

    #[tokio::test]
    async fn init_agents_cache_stores_detected_agents() {
        use std::sync::Arc;
        let cache = new_agent_cache();
        let sample = vec![AgentInfo {
            id: "claude".into(),
            name: "Claude".into(),
            install_hint: "".into(),
            update_hint: "".into(),
            docs_url: "".into(),
            models: Vec::new(),
            installed: true,
            cli_version: Some("1.0.0".into()),
            supports_streaming: true,
            supports_resume: true,
            supports_plan_mode: true,
            supports_model_selection: true,
            supports_effort: false,
            supports_skills: false,
            supports_attachments: true,
            supports_fork: true,
        }];
        let sample_clone = sample.clone();

        let returned =
            init_agents_cache(Arc::clone(&cache), || {}, move || sample_clone.clone()).await;

        assert_eq!(returned.len(), 1);
        assert_eq!(cache.read().unwrap().len(), 1);
        assert_eq!(cache.read().unwrap()[0].id, "claude");
    }

    // -- Pinned workspace (#61) guards --

    fn make_task(is_pinned: bool) -> Task {
        Task {
            id: "t-1".into(),
            project_id: "p-1".into(),
            name: None,
            worktree_path: "/tmp/wt".into(),
            branch: "b".into(),
            created_at: 0,
            merge_base_sha: None,
            port_offset: 0,
            archived: false,
            archived_at: None,
            last_commit_message: None,
            parent_task_id: None,
            agent_type: "claude".into(),
            last_pushed_sha: None,
            is_pinned,
        }
    }

    #[test]
    fn reject_if_pinned_blocks_pinned_task() {
        let t = make_task(true);
        let err = reject_if_pinned(&t, "archived").unwrap_err();
        assert!(err.contains("pinned"), "got: {err}");
        assert!(err.contains("archived"), "error message includes op: {err}");
    }

    #[test]
    fn reject_if_pinned_allows_unpinned_task() {
        let t = make_task(false);
        assert!(reject_if_pinned(&t, "archived").is_ok());
    }

    #[test]
    fn reject_if_pinned_surfaces_operation_in_error() {
        // Callers pass "merged", "used as a PR source", etc. The message has
        // to echo the op back so the frontend can show a meaningful toast.
        for op in ["archived", "merged", "deleted", "used as a PR source"] {
            let err = reject_if_pinned(&make_task(true), op).unwrap_err();
            assert!(err.contains(op), "op '{op}' missing from error: {err}");
        }
    }
}
