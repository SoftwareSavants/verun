use crate::db::{self, DbWriteTx, Session, Task};
use crate::policy::TrustLevel;
use crate::stream;
use crate::worktree;
use dashmap::DashMap;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
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

/// task_id → true while the setup hook is still running in the background
pub type SetupInProgress = Arc<DashMap<String, bool>>;

pub fn new_setup_in_progress() -> SetupInProgress {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Hook PTY tracking — maps task_id to active hook terminal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookType {
    Setup,
    Destroy,
}

impl HookType {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookType::Setup => "setup",
            HookType::Destroy => "destroy",
        }
    }
}

#[allow(dead_code)]
pub struct HookPtyEntry {
    pub terminal_id: String,
    pub hook_type: HookType,
}

/// task_id → currently running hook PTY (setup or destroy)
pub type HookPtyMap = Arc<DashMap<String, HookPtyEntry>>;

pub fn new_hook_pty_map() -> HookPtyMap {
    Arc::new(DashMap::new())
}

/// Spawn a hook command via PTY so output streams to the frontend in real-time.
/// Returns the terminal_id on success.
#[allow(clippy::too_many_arguments)]
pub fn spawn_hook_pty(
    app: &AppHandle,
    pty_map: &crate::pty::ActivePtyMap,
    hook_pty_map: &HookPtyMap,
    setup_in_progress: &SetupInProgress,
    task_id: &str,
    worktree_path: &str,
    hook_command: &str,
    hook_type: HookType,
    port_offset: i64,
    repo_path: &str,
) -> Result<crate::pty::SpawnResult, String> {
    if hook_command.is_empty() {
        return Err(format!("No {} hook configured", hook_type.as_str()));
    }

    if hook_pty_map.contains_key(task_id) {
        return Err("A hook is already running for this task".to_string());
    }

    let env_vars = worktree::verun_env_vars(port_offset, repo_path);

    let result = crate::pty::spawn_pty(
        app.clone(),
        pty_map.clone(),
        task_id.to_string(),
        worktree_path.to_string(),
        24,
        80,
        Some(hook_command.to_string()),
        env_vars,
        true, // direct_command — PTY exits when hook exits
    )?;

    hook_pty_map.insert(
        task_id.to_string(),
        HookPtyEntry {
            terminal_id: result.terminal_id.clone(),
            hook_type,
        },
    );

    if hook_type == HookType::Setup {
        setup_in_progress.insert(task_id.to_string(), true);
    }

    let _ = app.emit(
        "setup-hook",
        crate::stream::SetupHookEvent {
            task_id: task_id.to_string(),
            status: "running".to_string(),
            error: None,
            terminal_id: Some(result.terminal_id.clone()),
            hook_type: Some(hook_type.as_str().to_string()),
        },
    );

    // Listen for pty-exited to detect hook completion and emit status
    let bg_app = app.clone();
    let bg_task_id = task_id.to_string();
    let bg_terminal_id = result.terminal_id.clone();
    let bg_hook_pty_map = hook_pty_map.clone();
    let bg_sip = setup_in_progress.clone();
    let bg_hook_type = hook_type;

    tokio::spawn(async move {
        use tauri::Listener;
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<u32>>();
        let tx = std::sync::Mutex::new(Some(tx));
        let target_tid = bg_terminal_id.clone();

        let unlisten_id = bg_app.listen("pty-exited", move |event| {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                if payload.get("terminalId").and_then(|v| v.as_str()) == Some(&target_tid) {
                    let exit_code = payload
                        .get("exitCode")
                        .and_then(|v| v.as_u64())
                        .map(|c| c as u32);
                    if let Some(sender) = tx.lock().ok().and_then(|mut s| s.take()) {
                        let _ = sender.send(exit_code);
                    }
                }
            }
        });

        let exit_code = rx.await.unwrap_or(None);

        bg_app.unlisten(unlisten_id);

        // Clean up tracking maps
        bg_hook_pty_map.remove(&bg_task_id);
        if bg_hook_type == HookType::Setup {
            bg_sip.remove(&bg_task_id);
        }

        let (status, error) = match exit_code {
            Some(0) => ("completed".to_string(), None),
            Some(code) => {
                eprintln!("[verun] {} hook failed with exit code {code}", bg_hook_type.as_str());
                ("failed".to_string(), Some(format!("Exit code: {code}")))
            }
            None => {
                eprintln!("[verun] {} hook terminated", bg_hook_type.as_str());
                ("failed".to_string(), Some("Process terminated".to_string()))
            }
        };

        let _ = bg_app.emit(
            "setup-hook",
            crate::stream::SetupHookEvent {
                task_id: bg_task_id.clone(),
                status,
                error,
                terminal_id: Some(bg_terminal_id),
                hook_type: Some(bg_hook_type.as_str().to_string()),
            },
        );

        // If setup completed, auto-send queued messages
        // (the frontend handles this via the setup-hook event listener)
    });

    Ok(result)
}

/// Run a setup hook in the background via PTY, emitting events to the frontend.
/// Shared by task creation and task restoration.
#[allow(clippy::too_many_arguments)]
pub fn spawn_setup_hook(
    app: &AppHandle,
    pty_map: &crate::pty::ActivePtyMap,
    hook_pty_map: &HookPtyMap,
    setup_in_progress: &SetupInProgress,
    task_id: &str,
    worktree_path: &str,
    setup_hook: &str,
    port_offset: i64,
    repo_path: &str,
) {
    if setup_hook.is_empty() {
        return;
    }

    if let Err(e) = spawn_hook_pty(
        app,
        pty_map,
        hook_pty_map,
        setup_in_progress,
        task_id,
        worktree_path,
        setup_hook,
        HookType::Setup,
        port_offset,
        repo_path,
    ) {
        eprintln!("[verun] failed to spawn setup hook PTY: {e}");
        // Fall back: emit failed event so frontend isn't stuck
        let _ = app.emit(
            "setup-hook",
            crate::stream::SetupHookEvent {
                task_id: task_id.to_string(),
                status: "failed".to_string(),
                error: Some(e),
                terminal_id: None,
                hook_type: Some("setup".to_string()),
            },
        );
    }
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

pub struct CreateTaskParams {
    pub project_id: String,
    pub repo_path: String,
    pub base_branch: String,
    pub setup_hook: String,
    pub port_offset: i64,
    pub from_task_window: bool,
}

pub async fn create_task(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    pty_map: &crate::pty::ActivePtyMap,
    hook_pty_map: &HookPtyMap,
    setup_in_progress: &SetupInProgress,
    params: CreateTaskParams,
) -> Result<(Task, Session), String> {
    let CreateTaskParams { project_id, repo_path, base_branch, setup_hook, port_offset, from_task_window } = params;
    let id = Uuid::new_v4().to_string();
    let branch = funny_branch_name();
    let now = epoch_ms();

    // Phase 1: Create worktree only (fast — git ops)
    let worktree_path = {
        let rp = repo_path.clone();
        let br = branch.clone();
        let bb = base_branch;
        tokio::task::spawn_blocking(move || {
            worktree::create_worktree(&rp, &br, &bb)
        })
            .await
            .map_err(|e| format!("Join error: {e}"))?
    }?;

    let task = Task {
        id,
        project_id,
        name: None,
        worktree_path: worktree_path.clone(),
        branch,
        created_at: now,
        merge_base_sha: None,
        port_offset,
        archived: false,
        archived_at: None,
        last_commit_message: None,
        parent_task_id: None,
    };

    db_tx
        .send(db::DbWrite::InsertTask(task.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Auto-create the first session
    let session = create_session(db_tx, task.id.clone()).await?;

    // Notify all windows about the new task so other windows can reload
    let _ = app.emit(
        "task-created",
        serde_json::json!({ "taskId": task.id, "projectId": task.project_id }),
    );

    // If created from a task window, also mark it as windowed BEFORE spawning the hook
    // so the main window knows to ignore this task's setup events
    if from_task_window {
        let _ = app.emit(
            "task-window-changed",
            serde_json::json!({ "taskId": task.id, "open": true }),
        );
    }

    // Phase 2: Run setup hook in background (if non-empty)
    spawn_setup_hook(app, pty_map, hook_pty_map, setup_in_progress, &task.id, &worktree_path, &setup_hook, port_offset, &repo_path);

    Ok((task, session))
}

#[allow(clippy::too_many_arguments)]
pub async fn delete_task(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    repo_path: &str,
    task: &Task,
    destroy_hook: &str,
    delete_branch: bool,
    skip_destroy_hook: bool,
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

    // Clean up hook tracking
    if let Some(hook_map) = app.try_state::<HookPtyMap>() {
        hook_map.remove(&task.id);
    }

    let rp = repo_path.to_string();
    let wtp = task.worktree_path.clone();
    let hook = if skip_destroy_hook { String::new() } else { destroy_hook.to_string() };
    let branch = task.branch.clone();
    let env_vars = worktree::verun_env_vars(task.port_offset, repo_path);
    let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
        if !hook.is_empty() {
            if let Err(e) = worktree::run_hook(&wtp, &hook, &env_vars) {
                eprintln!("[verun] destroy hook failed: {e}");
            }
        }
        worktree::delete_worktree(&rp, &wtp)?;
        if delete_branch {
            if let Err(e) = worktree::delete_branch(&rp, &branch) {
                eprintln!("[verun] branch delete failed: {e}");
            }
        }
        Ok(())
    }).await;

    db_tx
        .send(db::DbWrite::DeleteTask { id: task.id.clone() })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    let _ = app.emit(
        "task-removed",
        serde_json::json!({ "taskId": task.id, "reason": "deleted" }),
    );

    Ok(())
}

pub async fn archive_task(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    task: &Task,
    destroy_hook: &str,
    repo_path: &str,
    skip_destroy_hook: bool,
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

    // Clean up hook tracking
    if let Some(hook_map) = app.try_state::<HookPtyMap>() {
        hook_map.remove(&task.id);
    }

    // Run destroy hook (unless skipped) and capture last commit message
    let rp = repo_path.to_string();
    let branch = task.branch.clone();
    let hook = if skip_destroy_hook { String::new() } else { destroy_hook.to_string() };
    let wtp = task.worktree_path.clone();
    let env_vars = worktree::verun_env_vars(task.port_offset, repo_path);
    let last_commit_message = tokio::task::spawn_blocking(move || {
        if !hook.is_empty() {
            if let Err(e) = worktree::run_hook(&wtp, &hook, &env_vars) {
                eprintln!("[verun] destroy hook failed: {e}");
            }
        }
        worktree::last_commit_message(&rp, &branch)
    })
    .await
    .unwrap_or(None);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    db_tx
        .send(db::DbWrite::ArchiveTask {
            id: task.id.clone(),
            archived_at: now,
            last_commit_message,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    let _ = app.emit(
        "task-removed",
        serde_json::json!({ "taskId": task.id, "reason": "archived" }),
    );

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
        total_cost: 0.0,
        parent_session_id: None,
        forked_at_message_uuid: None,
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
    pub project_id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub port_offset: i64,
    pub trust_level: TrustLevel,
    pub message: String,
    pub claude_session_id: Option<String>,
    pub attachments: Vec<Attachment>,
    pub model: Option<String>,
    pub plan_mode: bool,
    pub thinking_mode: bool,
    pub fast_mode: bool,
    pub task_name: Option<String>,
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
    let SendMessageParams { session_id, task_id, project_id, worktree_path, repo_path, port_offset, trust_level, message, claude_session_id, attachments, model, plan_mode, thinking_mode, fast_mode, task_name } = params;
    // Don't allow concurrent messages on the same session
    if active.contains_key(&session_id) {
        return Err("Session is already processing a message".to_string());
    }

    let is_first_turn = claude_session_id.as_ref().is_none_or(|s| s.is_empty());

    // Generate AI title in background (non-blocking, tab shows "New session" until it arrives)
    let needs_session_name = is_first_turn && !message.is_empty();
    let needs_task_name = task_name.is_none() && !message.is_empty();
    if needs_session_name || needs_task_name {
        let title_app = app.clone();
        let title_db = db_tx.clone();
        let title_sid = session_id.clone();
        let title_tid = task_id.clone();
        let title_msg = message.clone();
        let title_wt = worktree_path.clone();
        tokio::spawn(async move {
            if let Some(title) = generate_session_title(&title_msg, &title_wt).await {
                if needs_session_name {
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
                }
                if needs_task_name {
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
    for (k, v) in worktree::verun_env_vars(port_offset, &repo_path) {
        cmd.env(&k, &v);
    }
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



    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    // Drain stderr so the OS pipe buffer (~64KB) never fills.
    // If it fills, the child blocks on stderr writes and appears frozen.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                line.clear();
            }
        });
    }

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
    let monitor_pid = project_id.clone();
    let monitor_active = active.clone();
    let monitor_pending = pending_approvals.clone();
    let monitor_pending_meta = pending_approval_meta.clone();
    let monitor_wt = worktree_path.clone();
    let monitor_repo = repo_path;
    let monitor_trust = trust_level;
    tokio::spawn(async move {
        // Stream stdout lines to frontend + DB
        let wt_for_hooks = monitor_wt.clone();
        let stream_result = stream::stream_and_capture(
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

        // Persist accumulated session cost
        if stream_result.total_cost > 0.0 {
            let _ = monitor_db_tx
                .send(db::DbWrite::AccumulateSessionCost {
                    id: monitor_sid.clone(),
                    cost: stream_result.total_cost,
                })
                .await;
        }

        // Process exited — get exit code
        let status = if let Some((_, mut proc)) = monitor_active.remove(&monitor_sid) {
            let exit = proc.child.wait().await.ok().and_then(|s| s.code());
            stream::map_exit_status(exit)
        } else {
            // Aborted by abort_message
            return;
        };

        // Try to extract claude session_id from captured output
        if let Some(csid) = extract_claude_session_id(&stream_result.lines) {
            let _ = monitor_db_tx
                .send(db::DbWrite::SetClaudeSessionId {
                    id: monitor_sid.clone(),
                    claude_session_id: csid,
                })
                .await;
        }

        // Check for .verun.json config written by Claude auto-detect
        let config_path = format!("{wt_for_hooks}/.verun.json");
        if let Some((setup, destroy, start)) = parse_verun_config_file(&config_path) {
            // Look up existing auto_start so auto-detect doesn't reset it
            let auto_start = if let Some(pool) = monitor_app.try_state::<sqlx::sqlite::SqlitePool>() {
                db::get_project(pool.inner(), &monitor_pid)
                    .await
                    .ok()
                    .flatten()
                    .map(|p| p.auto_start)
                    .unwrap_or(false)
            } else {
                false
            };
            let _ = monitor_db_tx
                .send(db::DbWrite::UpdateProjectHooks {
                    id: monitor_pid.clone(),
                    setup_hook: setup.clone(),
                    destroy_hook: destroy.clone(),
                    start_command: start.clone(),
                    auto_start,
                })
                .await;
            let _ = monitor_app.emit("project-hooks-updated", serde_json::json!({
                "projectId": monitor_pid,
                "setupHook": setup,
                "destroyHook": destroy,
                "startCommand": start,
            }));
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
        "Generate a 3-5 word title summarizing what the user wants. Reply with ONLY the title, nothing else. If the message is too vague or unclear to summarize (e.g. just a greeting), reply with exactly NONE.\n\nUser message: {}",
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
    if title.is_empty() || title.len() > 60 || title.eq_ignore_ascii_case("NONE") {
        None
    } else {
        Some(title)
    }
}

/// Parse a .verun.json config file. Returns (setup_hook, destroy_hook, start_command) if valid.
/// Supports the structured format: { hooks: { setup, destroy }, startCommand }
pub fn parse_verun_config_file(path: &str) -> Option<(String, String, String)> {
    let content = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;

    let hooks = v.get("hooks");
    let setup = hooks
        .and_then(|h| h.get("setup"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let destroy = hooks
        .and_then(|h| h.get("destroy"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let start = v
        .get("startCommand")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Only return if at least one field is set
    if setup.is_empty() && destroy.is_empty() && start.is_empty() {
        return None;
    }

    Some((setup, destroy, start))
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

// ---------------------------------------------------------------------------
// Fork from a past message
// ---------------------------------------------------------------------------

/// Worktree state to use when forking to a new task. The "in this task" fork
/// path always preserves the parent's worktree as-is and is not gated by this
/// enum.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeForkState {
    /// Use the per-turn snapshot of the worktree taken at the chosen message.
    Snapshot,
    /// Copy the parent's current worktree state (HEAD + uncommitted changes).
    Current,
}

/// Fork a session at a specific assistant message uuid into a NEW session
/// inside the SAME task (the worktree is unchanged).
///
/// The new session has a fresh claude session id; we hand-craft a truncated
/// JSONL transcript at `~/.claude/projects/<dir>/<new-uuid>.jsonl` so
/// `claude --resume <new-uuid>` picks up exactly the prefix the user chose.
///
/// We also copy the parent's `output_lines` rows up to and including the
/// `verun_turn_snapshot` marker for `fork_after_message_uuid` so the new
/// session's chat view shows the inherited history. Session row + output
/// lines are written in a single transaction for consistency.
pub async fn fork_session_in_task(
    pool: &sqlx::sqlite::SqlitePool,
    source_session_id: String,
    fork_after_message_uuid: String,
) -> Result<Session, String> {
    let parent = db::get_session(pool, &source_session_id)
        .await?
        .ok_or_else(|| format!("Session {source_session_id} not found"))?;
    let parent_csid = parent
        .claude_session_id
        .clone()
        .ok_or_else(|| "Parent session has no claude session id (never started?)".to_string())?;

    let task = db::get_task(pool, &parent.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", parent.task_id))?;

    let new_csid = Uuid::new_v4().to_string();
    let new_verun_sid = Uuid::new_v4().to_string();
    let now = epoch_ms();

    // Truncate the on-disk JSONL transcript.
    let worktree_path = task.worktree_path.clone();
    let parent_csid_for_blocking = parent_csid.clone();
    let new_csid_for_blocking = new_csid.clone();
    let fork_uuid_for_blocking = fork_after_message_uuid.clone();
    tokio::task::spawn_blocking(move || {
        let wt = std::path::Path::new(&worktree_path);
        let src = crate::claude_jsonl::session_path(wt, &parent_csid_for_blocking)
            .ok_or_else(|| "no $HOME for jsonl path".to_string())?;
        let dest = crate::claude_jsonl::session_path(wt, &new_csid_for_blocking)
            .ok_or_else(|| "no $HOME for jsonl path".to_string())?;
        crate::claude_jsonl::truncate_after_message(
            &src,
            &dest,
            &new_csid_for_blocking,
            &fork_uuid_for_blocking,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    // Load parent output_lines outside the transaction so we can hold the
    // boundary check's error path separate from DB state.
    let parent_lines = db::get_output_lines(pool, &parent.id).await?;

    let new_session = Session {
        id: new_verun_sid.clone(),
        task_id: parent.task_id.clone(),
        name: parent.name.as_ref().map(|n| format!("{n} (fork)")),
        claude_session_id: Some(new_csid),
        status: "idle".to_string(),
        started_at: now,
        ended_at: None,
        total_cost: 0.0,
        parent_session_id: Some(parent.id.clone()),
        forked_at_message_uuid: Some(fork_after_message_uuid.clone()),
    };

    // Single transaction: insert session row + copy output_lines up to the
    // matching verun_turn_snapshot marker. If the marker is missing we fail
    // BEFORE committing so the DB stays clean.
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    insert_session_row_tx(&mut tx, &new_session).await?;
    copy_output_lines_up_to_marker_tx(
        &mut tx,
        &parent_lines,
        &new_verun_sid,
        &fork_after_message_uuid,
    )
    .await?;
    copy_turn_snapshots_tx(&mut tx, &parent.id, &new_verun_sid).await?;
    tx.commit().await.map_err(|e| format!("commit: {e}"))?;

    Ok(new_session)
}

/// Copy parent output_lines to the new session up to and including the
/// `verun_turn_snapshot` marker whose `messageUuid` matches `fork_uuid`.
/// Fails with a clear error if the marker is missing — otherwise the copy
/// silently includes the entire parent session.
async fn copy_output_lines_up_to_marker_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    parent_lines: &[crate::db::OutputLine],
    new_session_id: &str,
    fork_uuid: &str,
) -> Result<(), String> {
    let needle = format!("\"messageUuid\":\"{fork_uuid}\"");
    let mut found = false;
    let mut insert_count = 0usize;
    for ol in parent_lines {
        sqlx::query("INSERT INTO output_lines (session_id, line, emitted_at) VALUES (?, ?, ?)")
            .bind(new_session_id)
            .bind(&ol.line)
            .bind(ol.emitted_at)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("insert output_line: {e}"))?;
        insert_count += 1;
        if ol.line.contains("\"verun_turn_snapshot\"") && ol.line.contains(&needle) {
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!(
            "fork marker not found for message {fork_uuid} (scanned {insert_count} rows)"
        ));
    }
    Ok(())
}

/// Copy `turn_snapshots` rows from the parent session to the newly-forked
/// session. Without this the forked session has output_lines markers that
/// reference message uuids, but no corresponding snapshot rows under its own
/// session_id — so every subsequent fork from the forked session in
/// "code as of this message" mode fails with "no snapshot exists for this
/// message". The git commit objects themselves are shared (they're anchored
/// under refs/verun/snapshots/<parent>/... regardless of this table), so
/// these are cheap pointer rows, not a duplication of git state.
async fn copy_turn_snapshots_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    parent_session_id: &str,
    new_session_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR IGNORE INTO turn_snapshots (session_id, message_uuid, stash_sha, created_at) \
         SELECT ?, message_uuid, stash_sha, created_at \
         FROM turn_snapshots WHERE session_id = ?",
    )
    .bind(new_session_id)
    .bind(parent_session_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("copy turn_snapshots: {e}"))?;
    Ok(())
}

async fn insert_session_row_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    s: &Session,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sessions (id, task_id, name, claude_session_id, status, started_at, ended_at, total_cost, parent_session_id, forked_at_message_uuid) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.task_id)
    .bind(&s.name)
    .bind(&s.claude_session_id)
    .bind(&s.status)
    .bind(s.started_at)
    .bind(s.ended_at)
    .bind(s.total_cost)
    .bind(&s.parent_session_id)
    .bind(&s.forked_at_message_uuid)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("insert session: {e}"))?;
    Ok(())
}

async fn insert_task_row_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    t: &Task,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO tasks (id, project_id, name, worktree_path, branch, created_at, port_offset, parent_task_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&t.id)
    .bind(&t.project_id)
    .bind(&t.name)
    .bind(&t.worktree_path)
    .bind(&t.branch)
    .bind(t.created_at)
    .bind(t.port_offset)
    .bind(&t.parent_task_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("insert task: {e}"))?;
    Ok(())
}

/// Fork a session into a NEW task with its OWN worktree.
///
/// `worktree_state` controls whether the new worktree starts from the
/// per-turn snapshot taken at the chosen message (true counterfactual) or
/// from the parent's current worktree state (HEAD + any uncommitted edits).
///
/// Returns the new task + session. The caller is responsible for spawning
/// the project's setup hook on the new worktree (see ipc::fork_session_to_new_task).
pub async fn fork_session_to_new_task(
    app: &AppHandle,
    pool: &sqlx::sqlite::SqlitePool,
    source_session_id: String,
    fork_after_message_uuid: String,
    worktree_state: WorktreeForkState,
) -> Result<(Task, Session), String> {
    let parent_session = db::get_session(pool, &source_session_id)
        .await?
        .ok_or_else(|| format!("Session {source_session_id} not found"))?;
    let parent_csid = parent_session
        .claude_session_id
        .clone()
        .ok_or_else(|| "Parent session has no claude session id (never started?)".to_string())?;
    let parent_task = db::get_task(pool, &parent_session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", parent_session.task_id))?;
    let project = db::get_project(pool, &parent_task.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", parent_task.project_id))?;

    // Snapshot SHA lookup for "code as it was at this message" mode.
    let snapshot_sha = match worktree_state {
        WorktreeForkState::Snapshot => Some(
            db::get_turn_snapshot(pool, &parent_session.id, &fork_after_message_uuid)
                .await?
                .ok_or_else(|| {
                    "no snapshot exists for this message — try 'current code' instead".to_string()
                })?
                .stash_sha,
        ),
        WorktreeForkState::Current => None,
    };

    // Load parent output_lines BEFORE creating the worktree so a missing
    // marker fails fast without leaving stray filesystem state behind.
    let parent_lines = db::get_output_lines(pool, &parent_session.id).await?;
    validate_fork_marker_present(&parent_lines, &fork_after_message_uuid)?;

    // Create the new worktree (off the runtime).
    let branch = funny_branch_name();
    let repo_path = project.repo_path.clone();
    let parent_worktree = parent_task.worktree_path.clone();
    let base_branch = project.base_branch.clone();
    let branch_for_blocking = branch.clone();
    let snapshot_for_blocking = snapshot_sha.clone();
    let new_worktree_path = tokio::task::spawn_blocking(move || -> Result<String, String> {
        match snapshot_for_blocking {
            Some(sha) => {
                // Build the new worktree path manually so we can hand it to
                // restore_into_new_worktree, then attach a real branch after.
                let new_path = std::path::Path::new(&repo_path)
                    .join(".verun")
                    .join("worktrees")
                    .join(&branch_for_blocking);
                let new_path_str = new_path
                    .to_str()
                    .ok_or_else(|| "non-utf8 worktree path".to_string())?
                    .to_string();
                crate::snapshots::restore_into_new_worktree(
                    std::path::Path::new(&repo_path),
                    &new_path,
                    &sha,
                )
                .map_err(|e| e.to_string())?;
                // Attach the funny branch name pointing at the snapshot's HEAD
                // parent so subsequent commits go on a real branch (not detached).
                run_git_ignoring_env(&new_path, &["checkout", "-b", &branch_for_blocking])
                    .map_err(|e| format!("git checkout -b {branch_for_blocking}: {e}"))?;
                Ok(new_path_str)
            }
            None => {
                // Plain worktree creation, then overlay the parent's current
                // tracked + untracked changes via a transient commit-tree so
                // uncommitted work is carried over. Unlike the per-turn
                // snapshot machinery this does NOT anchor a ref — git gc
                // will reap the transient commit when nothing else holds it.
                let new_path = crate::worktree::create_worktree(
                    &repo_path,
                    &branch_for_blocking,
                    &base_branch,
                )?;
                let parent_wt = std::path::Path::new(&parent_worktree);
                match crate::snapshots::ephemeral_snapshot(parent_wt) {
                    Ok(Some(temp_sha)) => {
                        let new_pb = std::path::PathBuf::from(&new_path);
                        let tree_ref = format!("{temp_sha}^{{tree}}");
                        run_git_ignoring_env(
                            &new_pb,
                            &["read-tree", "--reset", "-u", &tree_ref],
                        )
                        .map_err(|e| format!("git read-tree on new worktree: {e}"))?;
                    }
                    Ok(None) => {
                        // Parent worktree has no HEAD — nothing to overlay.
                    }
                    Err(e) => {
                        // Non-fatal: the new worktree is usable without the overlay,
                        // the user just loses their uncommitted parent work.
                        eprintln!("[verun] fork-current ephemeral snapshot failed: {e}");
                    }
                }
                Ok(new_path)
            }
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let new_task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: parent_task.project_id.clone(),
        name: parent_task.name.as_ref().map(|n| format!("{n} (fork)")),
        worktree_path: new_worktree_path,
        branch,
        created_at: epoch_ms(),
        merge_base_sha: None,
        port_offset: db::next_port_offset(pool, &parent_task.project_id).await?,
        archived: false,
        archived_at: None,
        last_commit_message: None,
        parent_task_id: Some(parent_task.id.clone()),
    };

    // Write the truncated on-disk JSONL into the NEW worktree's projects dir
    // (Claude keys transcripts by cwd, so the new session's cwd is what
    // matters for `claude --resume`).
    let new_csid = Uuid::new_v4().to_string();
    let new_verun_sid = Uuid::new_v4().to_string();
    let now = epoch_ms();

    let parent_csid_for_blocking = parent_csid.clone();
    let new_csid_for_blocking = new_csid.clone();
    let fork_uuid_for_blocking = fork_after_message_uuid.clone();
    let new_wt_for_blocking = new_task.worktree_path.clone();
    let parent_wt_for_blocking = parent_task.worktree_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let parent_wt = std::path::Path::new(&parent_wt_for_blocking);
        let new_wt = std::path::Path::new(&new_wt_for_blocking);
        let src = crate::claude_jsonl::session_path(parent_wt, &parent_csid_for_blocking)
            .ok_or_else(|| "no $HOME for src jsonl".to_string())?;
        let dest = crate::claude_jsonl::session_path(new_wt, &new_csid_for_blocking)
            .ok_or_else(|| "no $HOME for dest jsonl".to_string())?;
        crate::claude_jsonl::truncate_after_message(
            &src,
            &dest,
            &new_csid_for_blocking,
            &fork_uuid_for_blocking,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    let new_session = Session {
        id: new_verun_sid.clone(),
        task_id: new_task.id.clone(),
        name: parent_session.name.as_ref().map(|n| format!("{n} (fork)")),
        claude_session_id: Some(new_csid),
        status: "idle".to_string(),
        started_at: now,
        ended_at: None,
        total_cost: 0.0,
        parent_session_id: Some(parent_session.id.clone()),
        forked_at_message_uuid: Some(fork_after_message_uuid.clone()),
    };

    // Single transaction: task row + session row + copied output_lines.
    // If anything fails, the DB rolls back cleanly. The filesystem worktree
    // is already created at this point — on failure the caller should tell
    // the user to clean up, but that's rare given we validated the marker up top.
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    insert_task_row_tx(&mut tx, &new_task).await?;
    insert_session_row_tx(&mut tx, &new_session).await?;
    copy_output_lines_up_to_marker_tx(
        &mut tx,
        &parent_lines,
        &new_verun_sid,
        &fork_after_message_uuid,
    )
    .await?;
    copy_turn_snapshots_tx(&mut tx, &parent_session.id, &new_verun_sid).await?;
    tx.commit().await.map_err(|e| format!("commit: {e}"))?;

    let _ = app.emit(
        "task-created",
        serde_json::json!({ "taskId": new_task.id, "projectId": new_task.project_id }),
    );

    Ok((new_task, new_session))
}

/// Scan parent output_lines for a `verun_turn_snapshot` marker whose
/// `messageUuid` matches. Fails fast before we spin up worktrees or open
/// transactions when the fork point doesn't exist in the parent session.
fn validate_fork_marker_present(
    parent_lines: &[crate::db::OutputLine],
    fork_uuid: &str,
) -> Result<(), String> {
    let needle = format!("\"messageUuid\":\"{fork_uuid}\"");
    let found = parent_lines
        .iter()
        .any(|ol| ol.line.contains("\"verun_turn_snapshot\"") && ol.line.contains(&needle));
    if !found {
        return Err(format!(
            "no turn-snapshot marker for message {fork_uuid} in parent session — the fork point must be an assistant turn that was snapshotted on turn-end"
        ));
    }
    Ok(())
}

/// Run a git command in `cwd` with inherited `GIT_*` env vars stripped so
/// the child process always operates on the given directory's own git state.
fn run_git_ignoring_env(cwd: &std::path::Path, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
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
