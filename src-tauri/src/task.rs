use crate::agent::AgentKind;
use crate::db::{self, DbWriteTx, Session, Task};
use crate::policy::TrustLevel;
use crate::stream;
use crate::worktree;
use dashmap::DashMap;
use serde::Deserialize;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Branch name generator — programming-humor themed, stack-aware
// ---------------------------------------------------------------------------

const ADJECTIVES: &[&str] = &[
    // State/condition
    "broken", "stale", "null", "dangling", "cursed", "legacy", "flaky", "frozen", "leaky",
    "panicking", "volatile", "blocked", "corrupt", "unhandled", "undefined", "deprecated",
    "recursive", "mutating", "thrashing", "fragile", "poisoned", "detached", "overloaded",
    "async",
    // Behavior
    "haunted", "sleeping", "spinning", "crashing", "burning", "exploding", "melting", "drifting",
    "sneaking", "lurking", "escaping", "leaking", "hanging", "starving", "evicting", "colliding",
    "flushing",
    // Dev-lifecycle
    "tangled", "nested", "bloated", "sharded", "cached", "proxied", "forked", "merged",
    "rebased", "squashed", "reverted", "patched", "shipped", "hotfixed", "hacked", "yolo",
    // Modern buzzwords
    "serverless", "containerized", "orchestrated", "distributed", "eventual", "idempotent",
    "immutable", "stateless", "reactive", "declarative", "imperative", "functional", "monadic",
    "curried", "memoized", "lazy",
];

const NOUNS_GENERIC: &[&str] = &[
    // Classic CS
    "pointer", "closure", "semaphore", "deadlock", "segfault", "exception", "footgun",
    "regression", "monolith", "bottleneck", "timeout", "mutex", "thread", "heap", "pipeline",
    "iterator", "dependency", "hotfix", "workaround", "refactor", "codebase", "spaghetti",
    "callback", "stack",
    // Architecture/infra
    "microservice", "abstraction", "singleton", "factory", "middleware", "gateway", "proxy",
    "cache", "queue", "broker", "replica", "sidecar", "loadbalancer", "circuit", "backpressure",
    "checkpoint",
    // Dev pain
    "migration", "rollback", "incident", "postmortem", "oncall", "flakiness", "flakytest",
    "techdebt", "bikeshed", "yagni", "rewrite", "greenfield", "brownfield", "triage", "runbook",
    // Modern concepts
    "container", "webhook", "cronjob", "sideeffect", "invariant", "predicate", "combinator",
    "monad", "functor", "reducer", "selector", "observable", "subscription", "serializer",
    "hydration", "abstraction", "interface",
];

const NOUNS_RUST: &[&str] = &[
    "borrow", "lifetime", "trait", "ownership", "unsafe", "transmute", "phantom", "future",
    "executor", "clippy", "linker", "crate", "macro", "reference", "slice", "deriving",
    "pinbox", "allocator", "borrowchecker", "dropglue", "sendbound", "syncbound", "arcmutex",
    "refcell", "rwlock", "channel", "tokioruntime", "asynctrait", "pinned", "variance",
    "covariance", "contravariance", "turbofish", "newtype", "typestate", "destructor", "waker",
    "poll", "spawntask", "blockingcall", "unsafecode", "rawpointer", "dangler", "useafterfree",
    "doublefree", "stacksmash", "intoverflow", "datarace", "borrowmut", "movesemantics",
    "copytype", "cloneimpl", "derefcoercion", "autoref",
];

const NOUNS_JS: &[&str] = &[
    "prototype", "hoisting", "coercion", "bundler", "polyfill", "transpiler", "promise",
    "hydration", "rerender", "middleware", "lockfile", "semver", "treeshake", "eslint",
    "tsconfig", "webpack", "vite", "closure", "eventloop", "callstack", "microtask",
    "macrotask", "settimeout", "npmaudit", "leftpad", "yarnwhy", "nodemodules", "peerconflict",
    "typewidening", "typenarrowing", "anytype", "assertion", "overload", "memoization",
    "stalestate", "staleclosure", "useeffect", "infiniteloop", "proptypes", "hookrule",
    "propdrilling", "reactivity", "solidstore", "sveltestores", "nextrouter", "bundlesize",
    "chunksplitting", "codesplitting", "lazyload", "suspense", "concurrentmode", "diffing",
    "treeflattening", "signalapocalypse",
];

const NOUNS_PYTHON: &[&str] = &[
    "pickle", "gil", "decorator", "metaclass", "generator", "virtualenv", "dunder", "lambda",
    "walrus", "asyncio", "celery", "pydantic", "namespace", "unpacking", "dataclass",
    "comprehension", "typehint", "importerror", "monkeypatch", "mutabledefault", "latebound",
    "circularimport", "venv", "conda", "poetrylock", "pipfreeze", "pipconflict", "egginfo",
    "abstractmethod", "classmethod", "staticmethod", "propertydecorator", "slots", "weakref",
    "finalizer", "garbagecollector", "cyclicref", "asyncgenerator", "coroutine", "threadlocal",
    "multiprocessing", "pickling", "shelve", "ormquery", "djangomigration", "flaskcontext",
    "fastapimodel", "pandasframe", "numpybroadcast", "typeerror", "indentationerror",
    "syntaxwarning", "deprecationwarn", "runtimeerror",
];

const NOUNS_GO: &[&str] = &[
    "goroutine", "channel", "interface", "defer", "recover", "embedding", "reflection",
    "vendor", "context", "waitgroup", "errorf", "nilpointer", "module", "struct", "receiver",
    "concurrency", "gofmt", "init", "goroutineleak", "channelblock", "selectstmt",
    "closurecapture", "nilinterface", "goroutinepool", "ticker", "timer", "signalchan",
    "syncmap", "atomicop", "mutexlock", "rwmutex", "oncefn", "poolreset", "goroutinerace",
    "datarace", "golangci", "govet", "gomod", "gosum", "buildtag", "cgocall", "unsafeptr",
    "typeassert", "panicrecovery", "namedreturn", "deferorder", "initorder", "blankimport",
    "shadowedvar", "shortdecl", "multireturn", "errorwrap", "errortarget", "errorchain",
];

const NOUNS_JAVA: &[&str] = &[
    "nullpointer", "classloader", "reflection", "serializable", "generics", "boilerplate",
    "singleton", "factory", "enterprise", "inheritance", "bytecode", "jvm", "annotation",
    "abstraction", "dependency", "injection", "exception", "stackoverflowex", "outofmemory",
    "classcastex", "arraybounds", "concurrentmod", "deadlockjvm", "threadpool", "executorservice",
    "springbean", "hibernateproxy", "jpaquery", "lazyload", "eagerfetch", "transactional",
    "aspectj", "cglibproxy", "lombokdata", "buildergenerator", "mapstruct", "jacksondeser",
    "gradledep", "mavenplugin", "classpathconflict", "jarconflict", "modulepath", "jigsaw",
    "recordtype", "sealedclass", "patternmatch", "virtualthread", "loom", "graalvm",
    "nativeimage", "jitcompile", "g1gc", "zgc",
];

fn collect_stack_nouns(repo_path: &str) -> Vec<&'static str> {
    let p = std::path::Path::new(repo_path);
    let mut nouns: Vec<&'static str> = Vec::new();
    let mut found_any = false;

    if p.join("Cargo.toml").exists() {
        nouns.extend_from_slice(NOUNS_RUST);
        found_any = true;
    }
    if p.join("go.mod").exists() {
        nouns.extend_from_slice(NOUNS_GO);
        found_any = true;
    }
    if p.join("requirements.txt").exists()
        || p.join("pyproject.toml").exists()
        || p.join("setup.py").exists()
    {
        nouns.extend_from_slice(NOUNS_PYTHON);
        found_any = true;
    }
    if p.join("package.json").exists() {
        nouns.extend_from_slice(NOUNS_JS);
        found_any = true;
    }
    if p.join("pom.xml").exists() || p.join("build.gradle").exists() {
        nouns.extend_from_slice(NOUNS_JAVA);
        found_any = true;
    }

    if !found_any {
        nouns.extend_from_slice(NOUNS_GENERIC);
    }
    nouns
}

pub fn generate_branch_name(repo_path: &str) -> String {
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

    let nouns = collect_stack_nouns(repo_path);
    let adj = ADJECTIVES[(h as usize) % ADJECTIVES.len()];
    let noun = nouns[((h >> 16) as usize) % nouns.len()];
    let num = (h >> 32) % 1000;

    format!("{adj}-{noun}-{num}")
}

// ---------------------------------------------------------------------------
// Active process tracking — only sessions currently processing a message
// ---------------------------------------------------------------------------

pub struct ActiveProcess {
    pub child: Child,
    /// Task this session belongs to. Lets `set_trust_level` find the right
    /// active processes to notify without a DB roundtrip.
    pub task_id: String,
    /// Kept alive so `stream_and_capture` can write control_response messages via the Arc clone.
    /// For persistent agents this stays Some across turns; for one-shot agents it's
    /// `take()`n on `turn_end` to close the fd and let the process exit.
    pub stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    /// True while a turn is in flight. For persistent agents the stream loop
    /// flips this to false on `turn_end` so the next `send_message` can take
    /// the fast path instead of erroring as "already processing".
    pub busy: Arc<AtomicBool>,
    /// Live trust level for this task. Shared with the stream loop so policy
    /// evaluation re-reads it on every tool call — IPC edits mid-run take
    /// effect on the next `can_use_tool` check instead of the next spawn.
    pub trust_level: Arc<AtomicU8>,
    /// Which agent owns this process. Lets `abort_message` /
    /// `close_session` / app-exit dispatch on the trait without a DB read.
    pub kind: AgentKind,
    /// Last-applied permission mode ("default" or "plan"). Persistent-session
    /// sends compare against this to decide whether to emit a
    /// `set_permission_mode` control_request before the user message.
    pub current_permission_mode: String,
    /// Last-applied model (`None` = CLI default). Persistent-session sends
    /// compare against this to decide whether to emit a `set_model`
    /// control_request before the user message.
    pub current_model: Option<String>,
    /// Last-applied effort flag (`thinking_mode`/`fast_mode`). The Claude CLI
    /// only accepts `--effort` at spawn — there is no mid-session control
    /// request — so any change forces a respawn.
    pub current_thinking_mode: bool,
    pub current_fast_mode: bool,
    /// Codex app-server thread id. `None` for non-RPC agents. Populated from
    /// the `thread/started` notification during spawn.
    pub codex_thread_id: Option<String>,
    /// Request-id → response-oneshot map for the Codex app-server session.
    /// `None` for non-RPC agents. The reader task writes to this; the main
    /// thread reads via `register_pending`.
    pub codex_pending: Option<crate::agent::codex_rpc::PendingRpcResponses>,
    /// Monotonic request-id source for RPC calls. `None` for non-RPC agents.
    pub codex_next_id: Option<Arc<AtomicI64>>,
    /// Codex app-server turn id for the currently-in-flight turn. `None` when
    /// no turn is running (idle, pre-warm, or after `turn/completed`). Set
    /// from the `turn/start` response (`result.turn.id`) and cleared on
    /// `turn/completed`. `turn/interrupt` requires this — sending just the
    /// thread id fails with `Invalid request: missing field turnId`.
    pub codex_current_turn_id: Option<Arc<TokioMutex<Option<String>>>>,
}

/// session_id → currently running claude process (only while processing a message)
pub type ActiveMap = Arc<DashMap<String, ActiveProcess>>;

pub fn new_active_map() -> ActiveMap {
    Arc::new(DashMap::new())
}

/// Intersect currently-active session ids with the session ids belonging to a
/// given task. Used by archive/delete to scope the kill to one task only.
fn active_session_ids_for_task<I, S>(active_ids: I, task_session_ids: &[S]) -> Vec<String>
where
    I: IntoIterator<Item = String>,
    S: AsRef<str>,
{
    let task_set: std::collections::HashSet<&str> =
        task_session_ids.iter().map(|s| s.as_ref()).collect();
    active_ids
        .into_iter()
        .filter(|id| task_set.contains(id.as_str()))
        .collect()
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

    let display_name = match hook_type {
        HookType::Setup => "Setup",
        HookType::Destroy => "Destroy",
    };
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
        Some(display_name.to_string()),
        false,
        Some(hook_type.as_str().to_string()),
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
                eprintln!(
                    "[verun] {} hook failed with exit code {code}",
                    bg_hook_type.as_str()
                );
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
/// For deny: `message` carries the user's reason (e.g. plan-viewer feedback)
/// so Claude can continue the turn with that context instead of seeing a
/// generic "user denied" placeholder.
pub struct ApprovalResponse {
    pub behavior: String,
    pub updated_input: Option<serde_json::Value>,
    pub message: Option<String>,
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

/// request_id → oneshot channel awaiting a matching `control_response` from the CLI.
/// Used by IPC callers that issue `control_request`s (interrupt, get_context_usage, ...)
/// and need to correlate the async reply.
pub type PendingControlResponses =
    Arc<DashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>;

pub fn new_pending_control_responses() -> PendingControlResponses {
    Arc::new(DashMap::new())
}

/// Best-effort graceful shutdown of a claude CLI subprocess. Matches the cadence
/// the official claude-agent-sdk-python uses: EOF on stdin, then a 5s grace,
/// then SIGTERM + 5s, then SIGKILL.
///
/// Why: hard SIGKILL interrupts the CLI mid-write of its session JSONL file,
/// causing the last assistant message to be lost on `--resume` (python-sdk #625/#729).
pub async fn graceful_shutdown(child: &mut Child, stdin: &Arc<TokioMutex<Option<ChildStdin>>>) {
    // 1. Drop stdin to send EOF — lets the CLI flush its transcript and exit cleanly.
    {
        let mut guard = stdin.lock().await;
        drop(guard.take());
    }

    // 2. Wait up to 5s for natural exit.
    if tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .is_ok()
    {
        return;
    }

    // 3. SIGTERM. tokio::process::Child only exposes SIGKILL directly; send SIGTERM via libc.
    //    libc::kill is Unix-only; on Windows we fall through to SIGKILL.
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_ok()
        {
            return;
        }
    }

    // 4. SIGKILL as last resort.
    let _ = child.start_kill();
    let _ = child.wait().await;
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
    pub agent_type: String, // flows to the first session, not stored on the task
    pub source_window: String,
}

pub async fn create_task(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    pty_map: &crate::pty::ActivePtyMap,
    hook_pty_map: &HookPtyMap,
    setup_in_progress: &SetupInProgress,
    params: CreateTaskParams,
) -> Result<(Task, Session), String> {
    let CreateTaskParams {
        project_id,
        repo_path,
        base_branch,
        setup_hook,
        port_offset,
        from_task_window,
        agent_type,
        source_window,
    } = params;
    let id = Uuid::new_v4().to_string();
    let branch = generate_branch_name(&repo_path);
    let now = epoch_ms();

    // Phase 1: Create worktree only (fast — git ops)
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
        worktree_path: worktree_path.clone(),
        branch,
        created_at: now,
        merge_base_sha: None,
        port_offset,
        archived: false,
        archived_at: None,
        last_commit_message: None,
        parent_task_id: None,
        agent_type: agent_type.clone(),
        last_pushed_sha: None,
    };

    db_tx
        .send(db::DbWrite::InsertTask(task.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    // Auto-create the first session with the chosen agent
    let session = create_session(app, db_tx, task.id.clone(), agent_type, None).await?;

    // Notify all windows about the new task so other windows can reload.
    // The source window skips the reload since it already has the task from
    // the IPC response — this avoids a race where the DB write queue hasn't
    // yet applied InsertTask and the reload would drop the new task.
    let _ = app.emit(
        "task-created",
        serde_json::json!({
            "taskId": task.id,
            "projectId": task.project_id,
            "sourceWindow": source_window,
        }),
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
    spawn_setup_hook(
        app,
        pty_map,
        hook_pty_map,
        setup_in_progress,
        &task.id,
        &worktree_path,
        &setup_hook,
        port_offset,
        &repo_path,
    );

    Ok((task, session))
}

#[allow(clippy::too_many_arguments)]
pub async fn delete_task(
    app: &AppHandle,
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    repo_path: &str,
    task: &Task,
    destroy_hook: &str,
    delete_branch: bool,
    skip_destroy_hook: bool,
) -> Result<(), String> {
    // Kill active processes belonging to THIS task only - never sessions on other tasks.
    let task_session_ids = db::list_all_session_ids_for_task(pool, &task.id)
        .await
        .unwrap_or_default();
    let active_ids = active.iter().map(|e| e.key().clone());
    for sid in active_session_ids_for_task(active_ids, &task_session_ids) {
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
    let hook = if skip_destroy_hook {
        String::new()
    } else {
        destroy_hook.to_string()
    };
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
    })
    .await;

    db_tx
        .send(db::DbWrite::DeleteTask {
            id: task.id.clone(),
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    let _ = app.emit(
        "task-removed",
        serde_json::json!({ "taskId": task.id, "reason": "deleted" }),
    );

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn archive_task(
    app: &AppHandle,
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    task: &Task,
    destroy_hook: &str,
    repo_path: &str,
    skip_destroy_hook: bool,
) -> Result<(), String> {
    // Kill active processes belonging to THIS task only - never sessions on other tasks.
    let task_session_ids = db::list_all_session_ids_for_task(pool, &task.id)
        .await
        .unwrap_or_default();
    let active_ids = active.iter().map(|e| e.key().clone());
    for sid in active_session_ids_for_task(active_ids, &task_session_ids) {
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

    // Flip the archive flag and notify listeners immediately. The destroy
    // hook + last-commit-message capture run in the background — the user
    // gets instant feedback (window closes, sidebar updates) and the hook's
    // exit status no longer blocks UI.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    db_tx
        .send(db::DbWrite::ArchiveTask {
            id: task.id.clone(),
            archived_at: now,
            last_commit_message: None,
        })
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    let _ = app.emit(
        "task-removed",
        serde_json::json!({ "taskId": task.id, "reason": "archived" }),
    );

    let rp = repo_path.to_string();
    let branch = task.branch.clone();
    let hook = if skip_destroy_hook {
        String::new()
    } else {
        destroy_hook.to_string()
    };
    let wtp = task.worktree_path.clone();
    let env_vars = worktree::verun_env_vars(task.port_offset, repo_path);
    let task_id = task.id.clone();
    let db_tx_bg = db_tx.clone();
    tokio::spawn(async move {
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

        if last_commit_message.is_some() {
            let _ = db_tx_bg
                .send(db::DbWrite::SetLastCommitMessage {
                    id: task_id,
                    msg: last_commit_message,
                })
                .await;
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/// Create a new session record (no process spawned yet — that happens on send_message)
pub async fn create_session(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    task_id: String,
    agent_type: String,
    model: Option<String>,
) -> Result<Session, String> {
    let session = Session {
        id: Uuid::new_v4().to_string(),
        task_id,
        name: None,
        resume_session_id: None,
        status: "idle".to_string(),
        started_at: epoch_ms(),
        ended_at: None,
        total_cost: 0.0,
        parent_session_id: None,
        forked_at_message_uuid: None,
        agent_type,
        model,
        closed_at: None,
    };

    db_tx
        .send(db::DbWrite::CreateSession(session.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;

    let _ = app.emit("session-created", &session);

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

pub struct SendMessageParams {
    pub session_id: String,
    pub task_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub port_offset: i64,
    pub trust_level: TrustLevel,
    pub message: String,
    pub resume_session_id: Option<String>,
    pub attachments: Vec<Attachment>,
    pub model: Option<String>,
    pub plan_mode: bool,
    pub thinking_mode: bool,
    pub fast_mode: bool,
    pub task_name: Option<String>,
    pub agent_type: String,
}

/// Send a message to the agent's CLI in this session's worktree.
///
/// Two paths, both trait-driven:
/// * **Fast path** (persistent agent, process already alive): encode the
///   user message via `agent.encode_stream_user_message` and write it to
///   the existing stdin. No spawn, no cold start.
/// * **Spawn path** (no live process, or non-persistent agent): build the
///   command, spawn the child, and hand off to `spawn_session_process`.
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    app: AppHandle,
    db_tx: &DbWriteTx,
    active: ActiveMap,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    pending_control_responses: PendingControlResponses,
    params: SendMessageParams,
) -> Result<(), String> {
    let SendMessageParams {
        session_id,
        task_id,
        project_id,
        worktree_path,
        repo_path,
        port_offset,
        trust_level,
        message,
        resume_session_id,
        attachments,
        model,
        plan_mode,
        thinking_mode,
        fast_mode,
        task_name,
        agent_type,
    } = params;
    let agent = AgentKind::parse(&agent_type).implementation();
    let is_first_turn = resume_session_id.as_ref().is_none_or(|s| s.is_empty());

    // ── Fast path: persistent agent with a live, idle process in `active` ──
    //
    // Three sub-decisions, evaluated against the `ActiveProcess` entry:
    //   1. Dead / missing   → fall through to spawn path.
    //   2. Busy             → error ("already processing").
    //   3. Effort changed   → kill and respawn (Claude CLI only accepts
    //                         `--effort` at spawn, no mid-session control).
    //   4. Mode/model diff  → write `set_permission_mode` / `set_model`
    //                         control_request frames before the user message.
    let want_permission_mode = if plan_mode { "plan" } else { "default" };
    if agent.persists_across_turns() {
        enum FastPath {
            Go {
                stdin: Arc<TokioMutex<Option<ChildStdin>>>,
                busy: Arc<AtomicBool>,
                send_set_permission_mode: bool,
                send_set_model: bool,
            },
            GoRpc {
                stdin: Arc<TokioMutex<Option<ChildStdin>>>,
                busy: Arc<AtomicBool>,
                thread_id: String,
                pending: crate::agent::codex_rpc::PendingRpcResponses,
                next_id: Arc<AtomicI64>,
                current_turn_id: Arc<TokioMutex<Option<String>>>,
            },
            Respawn,
            Spawn,
        }

        let decision = {
            if let Some(mut entry) = active.get_mut(&session_id) {
                let alive = matches!(entry.child.try_wait(), Ok(None));
                let busy_now = entry.busy.load(Ordering::SeqCst);
                if !alive {
                    drop(entry);
                    active.remove(&session_id);
                    FastPath::Spawn
                } else if busy_now {
                    return Err("Session is already processing a message".to_string());
                } else if entry.current_thinking_mode != thinking_mode
                    || entry.current_fast_mode != fast_mode
                {
                    drop(entry);
                    FastPath::Respawn
                } else if agent.uses_app_server() {
                    let thread_id = entry.codex_thread_id.clone().ok_or_else(|| {
                        "Codex RPC session missing thread id — cannot reuse process".to_string()
                    })?;
                    let pending = entry.codex_pending.clone().ok_or_else(|| {
                        "Codex RPC session missing pending map — cannot reuse process".to_string()
                    })?;
                    let next_id = entry.codex_next_id.clone().ok_or_else(|| {
                        "Codex RPC session missing request id counter — cannot reuse process"
                            .to_string()
                    })?;
                    let current_turn_id =
                        entry.codex_current_turn_id.clone().ok_or_else(|| {
                            "Codex RPC session missing current-turn slot — cannot reuse process"
                                .to_string()
                        })?;
                    entry.current_permission_mode = want_permission_mode.to_string();
                    entry.current_model.clone_from(&model);
                    FastPath::GoRpc {
                        stdin: entry.stdin.clone(),
                        busy: entry.busy.clone(),
                        thread_id,
                        pending,
                        next_id,
                        current_turn_id,
                    }
                } else {
                    let send_set_permission_mode =
                        entry.current_permission_mode != want_permission_mode;
                    let send_set_model = entry.current_model != model;
                    if send_set_permission_mode {
                        entry.current_permission_mode = want_permission_mode.to_string();
                    }
                    if send_set_model {
                        entry.current_model.clone_from(&model);
                    }
                    FastPath::Go {
                        stdin: entry.stdin.clone(),
                        busy: entry.busy.clone(),
                        send_set_permission_mode,
                        send_set_model,
                    }
                }
            } else {
                FastPath::Spawn
            }
        };

        match decision {
            FastPath::Go {
                stdin,
                busy,
                send_set_permission_mode,
                send_set_model,
            } => {
                let user_bytes = agent.encode_stream_user_message(&message, &attachments)?;
                persist_verun_user_message(
                    db_tx,
                    &session_id,
                    &message,
                    &attachments,
                    plan_mode,
                    thinking_mode,
                    fast_mode,
                )
                .await;
                spawn_session_title_generation(
                    app.clone(),
                    db_tx.clone(),
                    session_id.clone(),
                    task_id.clone(),
                    message.clone(),
                    worktree_path.clone(),
                    is_first_turn,
                    task_name.is_none(),
                );
                // Control requests must complete before the user message: the
                // CLI applies mode/model changes only after ACKing. Writing the
                // user message first (or before the ACK arrives) can race the
                // switch, leaving Claude running the previous mode/model.
                if send_set_permission_mode {
                    let req_id = new_control_request_id();
                    let bytes =
                        agent.encode_stream_set_permission_mode(&req_id, want_permission_mode)?;
                    await_control_ack(
                        &stdin,
                        &pending_control_responses,
                        &req_id,
                        &bytes,
                        "set_permission_mode",
                    )
                    .await?;
                }
                if send_set_model {
                    let req_id = new_control_request_id();
                    let bytes = agent.encode_stream_set_model(&req_id, model.as_deref())?;
                    await_control_ack(
                        &stdin,
                        &pending_control_responses,
                        &req_id,
                        &bytes,
                        "set_model",
                    )
                    .await?;
                }
                write_to_stdin(&stdin, &user_bytes).await?;
                busy.store(true, Ordering::SeqCst);
                let _ = db_tx
                    .send(db::DbWrite::UpdateSessionStatus {
                        id: session_id.clone(),
                        status: "running".to_string(),
                    })
                    .await;
                let _ = app.emit(
                    "session-status",
                    stream::SessionStatusEvent {
                        session_id,
                        status: "running".to_string(),
                        error: None,
                    },
                );
                return Ok(());
            }
            FastPath::GoRpc {
                stdin,
                busy,
                thread_id,
                pending,
                next_id,
                current_turn_id,
            } => {
                use crate::agent::codex_rpc;
                persist_verun_user_message(
                    db_tx,
                    &session_id,
                    &message,
                    &attachments,
                    plan_mode,
                    thinking_mode,
                    fast_mode,
                )
                .await;
                spawn_session_title_generation(
                    app.clone(),
                    db_tx.clone(),
                    session_id.clone(),
                    task_id.clone(),
                    message.clone(),
                    worktree_path.clone(),
                    is_first_turn,
                    task_name.is_none(),
                );

                let effort = effort_from_flags(thinking_mode, fast_mode);
                let image_urls: Vec<String> = attachments
                    .iter()
                    .filter_map(|a| {
                        if a.mime_type.starts_with("image/") {
                            Some(format!("data:{};base64,{}", a.mime_type, a.data_base64))
                        } else {
                            None
                        }
                    })
                    .collect();
                let turn_id = codex_rpc::next_request_id(&next_id);
                let turn_bytes = agent.encode_rpc_turn_start(
                    turn_id,
                    &crate::agent::CodexRpcTurnStartParams {
                        thread_id: &thread_id,
                        prompt: &message,
                        image_urls: &image_urls,
                        trust_level,
                        model: model.as_deref(),
                        effort: effort.as_deref(),
                        plan_mode,
                    },
                )?;
                // Clear the stale turn id from the previous turn before we
                // dispatch the new one — otherwise `abort_message` racing
                // ahead of `turn/start`'s response would send `turn/interrupt`
                // targeting the *previous* turn, leaving the real in-flight
                // turn running while the UI flipped to idle.
                *current_turn_id.lock().await = None;
                let turn_rx = codex_rpc::register_pending(&pending, turn_id);
                codex_rpc::write_frame(&stdin, &turn_bytes).await?;
                busy.store(true, Ordering::SeqCst);
                spawn_turn_start_response_watcher(
                    app.clone(),
                    db_tx.clone(),
                    session_id.clone(),
                    busy.clone(),
                    current_turn_id.clone(),
                    turn_rx,
                );
                let _ = db_tx
                    .send(db::DbWrite::UpdateSessionStatus {
                        id: session_id.clone(),
                        status: "running".to_string(),
                    })
                    .await;
                let _ = app.emit(
                    "session-status",
                    stream::SessionStatusEvent {
                        session_id,
                        status: "running".to_string(),
                        error: None,
                    },
                );
                return Ok(());
            }
            FastPath::Respawn => {
                if let Some((_, mut proc)) = active.remove(&session_id) {
                    graceful_shutdown(&mut proc.child, &proc.stdin).await;
                }
            }
            FastPath::Spawn => {}
        }
    }

    // ── Spawn path ──
    if active.contains_key(&session_id) {
        return Err("Session is already processing a message".to_string());
    }

    spawn_session_title_generation(
        app.clone(),
        db_tx.clone(),
        session_id.clone(),
        task_id.clone(),
        message.clone(),
        worktree_path.clone(),
        is_first_turn,
        task_name.is_none(),
    );

    persist_verun_user_message(
        db_tx,
        &session_id,
        &message,
        &attachments,
        plan_mode,
        thinking_mode,
        fast_mode,
    )
    .await;

    spawn_session_process(
        app,
        db_tx.clone(),
        active,
        pending_approvals,
        pending_approval_meta,
        pending_control_responses,
        SpawnSessionParams {
            session_id,
            task_id,
            project_id,
            worktree_path,
            repo_path,
            port_offset,
            trust_level,
            resume_session_id,
            model,
            plan_mode,
            thinking_mode,
            fast_mode,
            agent_type,
            message,
            attachments,
            prewarm: false,
        },
    )
    .await
}

/// Persist the user's message to `output_lines` so it shows up after reload.
/// Fire-and-forget semantics (send on the write queue; errors are logged upstream).
async fn persist_verun_user_message(
    db_tx: &DbWriteTx,
    session_id: &str,
    message: &str,
    attachments: &[Attachment],
    plan_mode: bool,
    thinking_mode: bool,
    fast_mode: bool,
) {
    let attachment_names: Vec<&str> = attachments.iter().map(|a| a.name.as_str()).collect();
    let user_line = serde_json::json!({
        "type": "verun_user_message",
        "text": message,
        "attachments": attachment_names,
        "plan_mode": plan_mode,
        "thinking_mode": thinking_mode,
        "fast_mode": fast_mode,
    })
    .to_string();
    let _ = db_tx
        .send(db::DbWrite::InsertOutputLines {
            session_id: session_id.to_string(),
            lines: vec![(user_line, epoch_ms())],
        })
        .await;
}

/// Kick off the background Haiku call that names the session and task.
/// No-op unless there's something to name.
#[allow(clippy::too_many_arguments)]
fn spawn_session_title_generation(
    app: AppHandle,
    db_tx: DbWriteTx,
    session_id: String,
    task_id: String,
    message: String,
    worktree_path: String,
    is_first_turn: bool,
    task_needs_name: bool,
) {
    let needs_session_name = is_first_turn && !message.is_empty();
    let needs_task_name = task_needs_name && !message.is_empty();
    if !needs_session_name && !needs_task_name {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if let Some(title) = generate_session_title(&message, &worktree_path).await {
            if needs_session_name {
                let _ = db_tx
                    .send(db::DbWrite::UpdateSessionName {
                        id: session_id.clone(),
                        name: title.clone(),
                    })
                    .await;
                let _ = app.emit(
                    "session-name",
                    stream::SessionNameEvent {
                        session_id,
                        name: title.clone(),
                    },
                );
            }
            if needs_task_name {
                let _ = db_tx
                    .send(db::DbWrite::UpdateTaskName {
                        id: task_id.clone(),
                        name: title.clone(),
                    })
                    .await;
                let _ = app.emit(
                    "task-name",
                    stream::TaskNameEvent {
                        task_id,
                        name: title,
                    },
                );
            }
        }
    });
}

/// Send a `control_request` frame and block until the CLI's matching
/// `control_response` arrives. Use this when the next stdin write depends on
/// the CLI having fully applied the request (e.g. a `set_permission_mode`
/// before the user message, so Claude runs in the new mode).
async fn await_control_ack(
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending: &PendingControlResponses,
    request_id: &str,
    bytes: &[u8],
    label: &str,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    pending.insert(request_id.to_string(), tx);
    if let Err(e) = write_to_stdin(stdin, bytes).await {
        pending.remove(request_id);
        return Err(e);
    }
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(e))) => Err(format!("{label} failed: {e}")),
        Ok(Err(_)) => Err(format!("{label}: response channel dropped")),
        Err(_) => {
            pending.remove(request_id);
            Err(format!("{label}: CLI did not ACK within 5s"))
        }
    }
}

/// Write a payload to the session's stdin, keeping the fd open afterwards.
/// Used both by the send-message fast path (user message) and abort (interrupt frame).
async fn write_to_stdin(
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    bytes: &[u8],
) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    let writer = guard
        .as_mut()
        .ok_or_else(|| "Session stdin is closed".to_string())?;
    writer
        .write_all(bytes)
        .await
        .map_err(|e| format!("write stdin: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush stdin: {e}"))?;
    Ok(())
}

/// Params for [`spawn_session_process`]. `prewarm=true` skips writing any
/// initial user message; the CLI just boots and waits for the first send.
pub struct SpawnSessionParams {
    pub session_id: String,
    pub task_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub repo_path: String,
    pub port_offset: i64,
    pub trust_level: TrustLevel,
    pub resume_session_id: Option<String>,
    pub model: Option<String>,
    pub plan_mode: bool,
    pub thinking_mode: bool,
    pub fast_mode: bool,
    pub agent_type: String,
    pub message: String,
    pub attachments: Vec<Attachment>,
    pub prewarm: bool,
}

/// Spawn a `codex app-server` subprocess and bootstrap the JSON-RPC
/// session. Handles `initialize` → `initialized` → `thread/{start,resume}` →
/// (optional `turn/start`) before registering the process in `active` and
/// kicking off the RPC stream monitor.
///
/// Called from `spawn_session_process` when `agent.uses_app_server()` is
/// true. Short-circuits the Claude-style path entirely — no stream-json
/// user message, no control_request plumbing.
#[allow(clippy::too_many_arguments)]
async fn spawn_codex_app_server_session(
    app: AppHandle,
    db_tx: DbWriteTx,
    active: ActiveMap,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    agent: Box<dyn crate::agent::Agent>,
    params: SpawnSessionParams,
) -> Result<(), String> {
    use crate::agent::codex_rpc;

    let SpawnSessionParams {
        session_id,
        task_id,
        project_id,
        worktree_path,
        repo_path,
        port_offset,
        trust_level,
        resume_session_id,
        model,
        plan_mode,
        thinking_mode,
        fast_mode,
        agent_type,
        message,
        attachments,
        prewarm,
    } = params;

    let args_list = agent.build_session_args(&crate::agent::SessionArgs {
        resume_session_id: None,
        model: model.as_deref(),
        plan_mode,
        thinking_mode,
        fast_mode,
        trust_level,
        worktree_path: &worktree_path,
        repo_path: &repo_path,
        message: &message,
    });

    eprintln!(
        "[verun][{}] spawn (app-server{}): {} {}",
        agent.display_name(),
        if prewarm { ", prewarm" } else { "" },
        agent.cli_binary(),
        args_list.join(" ")
    );
    eprintln!("[verun][{}] cwd: {}", agent.display_name(), worktree_path);

    let mut cmd = tokio::process::Command::new(agent.cli_binary());
    cmd.args(&args_list);
    for (k, v) in worktree::verun_env_vars(port_offset, &repo_path) {
        cmd.env(&k, &v);
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env("CLAUDE_CODE_ENTRYPOINT", "verun");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&worktree_path);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", agent.display_name()))?;
    eprintln!(
        "[verun][{}] spawned pid={:?}",
        agent.display_name(),
        child.id()
    );

    let stdin_handle = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;
    let stdin = Arc::new(TokioMutex::new(Some(stdin_handle)));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        let agent_name = agent.display_name().to_string();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    eprintln!("[verun][{agent_name}][stderr][{sid}] {trimmed}");
                }
                line.clear();
            }
        });
    }

    let pending = codex_rpc::new_pending_rpc_responses();
    let next_id = Arc::new(AtomicI64::new(1));
    let (events_tx, events_rx) =
        tokio::sync::mpsc::unbounded_channel::<codex_rpc::CodexRpcEvent>();
    codex_rpc::spawn_reader(stdout, pending.clone(), events_tx);

    // -- 1. initialize + initialized --
    let init_id = codex_rpc::next_request_id(&next_id);
    let init_bytes = agent.encode_rpc_initialize(
        init_id,
        &crate::agent::CodexRpcClientInfo {
            name: "verun",
            version: env!("CARGO_PKG_VERSION"),
        },
    )?;
    codex_rpc::call(&stdin, &pending, init_id, &init_bytes)
        .await
        .map_err(|e| format!("codex initialize failed: {e}"))?;
    let initialized = agent.encode_rpc_initialized_notification()?;
    codex_rpc::write_frame(&stdin, &initialized).await?;

    // -- 2. thread/start (with thread/resume fallback on recoverable err) --
    let resume = resume_session_id.as_deref().filter(|s| !s.is_empty());
    let thread_id: String = if let Some(rid) = resume {
        let rid_owned = rid.to_string();
        let resume_id = codex_rpc::next_request_id(&next_id);
        let resume_bytes = agent.encode_rpc_thread_resume(
            resume_id,
            &crate::agent::CodexRpcThreadResumeParams {
                thread_id: &rid_owned,
                cwd: &worktree_path,
                trust_level,
            },
        )?;
        match codex_rpc::call(&stdin, &pending, resume_id, &resume_bytes).await {
            Ok(_) => rid_owned,
            Err(err) if codex_rpc::is_recoverable_thread_resume_error(&err.message) => {
                eprintln!(
                    "[verun][codex-rpc][{session_id}] thread/resume recoverable, falling back to thread/start: {err}"
                );
                start_new_thread(&*agent, &stdin, &pending, &next_id, &worktree_path, trust_level, model.as_deref()).await?
            }
            Err(err) => return Err(format!("codex thread/resume failed: {err}")),
        }
    } else {
        start_new_thread(&*agent, &stdin, &pending, &next_id, &worktree_path, trust_level, model.as_deref()).await?
    };

    // Persist the thread id immediately — no waiting for turn end.
    let _ = db_tx
        .send(db::DbWrite::SetResumeSessionId {
            id: session_id.clone(),
            resume_session_id: thread_id.clone(),
        })
        .await;

    let busy = Arc::new(AtomicBool::new(!prewarm));
    let current_turn_id: Arc<TokioMutex<Option<String>>> = Arc::new(TokioMutex::new(None));

    // -- 3. turn/start (unless prewarming) --
    if !prewarm {
        let effort = effort_from_flags(thinking_mode, fast_mode);
        let image_urls: Vec<String> = attachments
            .iter()
            .filter_map(|a| {
                if a.mime_type.starts_with("image/") {
                    Some(format!("data:{};base64,{}", a.mime_type, a.data_base64))
                } else {
                    None
                }
            })
            .collect();
        let turn_id = codex_rpc::next_request_id(&next_id);
        let turn_bytes = agent.encode_rpc_turn_start(
            turn_id,
            &crate::agent::CodexRpcTurnStartParams {
                thread_id: &thread_id,
                prompt: &message,
                image_urls: &image_urls,
                trust_level,
                model: model.as_deref(),
                effort: effort.as_deref(),
                plan_mode,
            },
        )?;
        // Register a pending slot and keep the receiver — codex app-server
        // resolves `turn/start` synchronously with the Codex turn id
        // (`result.turn.id`), so the watcher populates
        // `codex_current_turn_id` (needed for `turn/interrupt`) on success
        // and surfaces any JSON-RPC error (e.g. missing `experimentalApi`
        // capability) on failure.
        let turn_rx = codex_rpc::register_pending(&pending, turn_id);
        codex_rpc::write_frame(&stdin, &turn_bytes).await?;
        spawn_turn_start_response_watcher(
            app.clone(),
            db_tx.clone(),
            session_id.clone(),
            busy.clone(),
            current_turn_id.clone(),
            turn_rx,
        );
    }

    if !prewarm {
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
                error: None,
            },
        );
    }

    let kind = AgentKind::parse(&agent_type);
    let trust_level_atom = Arc::new(AtomicU8::new(trust_level.to_u8()));
    active.insert(
        session_id.clone(),
        ActiveProcess {
            child,
            task_id: task_id.clone(),
            stdin: stdin.clone(),
            busy: busy.clone(),
            trust_level: trust_level_atom,
            kind,
            current_permission_mode: if plan_mode { "plan" } else { "default" }.to_string(),
            current_model: model.clone(),
            current_thinking_mode: thinking_mode,
            current_fast_mode: fast_mode,
            codex_thread_id: Some(thread_id),
            codex_pending: Some(pending),
            codex_next_id: Some(next_id),
            codex_current_turn_id: Some(current_turn_id.clone()),
        },
    );

    // -- 4. Monitor: drive the RPC event stream, then clean up on reader close --
    let monitor_app = app.clone();
    let monitor_db_tx = db_tx.clone();
    let monitor_sid = session_id.clone();
    let monitor_tid = task_id.clone();
    let monitor_pid = project_id.clone();
    let monitor_active = active.clone();
    let monitor_pending = pending_approvals;
    let monitor_pending_meta = pending_approval_meta;
    let monitor_wt = worktree_path.clone();
    let monitor_agent = AgentKind::parse(&agent_type).implementation();
    let monitor_busy = busy.clone();
    let monitor_stdin = stdin;
    let monitor_current_turn_id = current_turn_id;
    tokio::spawn(async move {
        let wt_for_hooks = monitor_wt.clone();
        let stream_result = stream::stream_and_capture_rpc(
            monitor_app.clone(),
            monitor_sid.clone(),
            monitor_tid.clone(),
            events_rx,
            monitor_stdin,
            monitor_busy,
            monitor_pending,
            monitor_pending_meta,
            monitor_db_tx.clone(),
            &*monitor_agent,
            monitor_current_turn_id,
            monitor_wt.clone().into(),
        )
        .await;

        if stream_result.total_cost > 0.0 {
            let _ = monitor_db_tx
                .send(db::DbWrite::AccumulateSessionCost {
                    id: monitor_sid.clone(),
                    cost: stream_result.total_cost,
                })
                .await;
        }

        let status = if let Some((_, mut proc)) = monitor_active.remove(&monitor_sid) {
            let exit_status = proc.child.wait().await.ok();
            let exit_code = exit_status.as_ref().and_then(|s| s.code());
            eprintln!(
                "[verun][codex-rpc][{monitor_sid}] exited code={exit_code:?}"
            );
            stream::map_exit_status(exit_code)
        } else {
            return;
        };

        let config_path = format!("{wt_for_hooks}/.verun.json");
        if let Some((setup, destroy, start)) = parse_verun_config_file(&config_path) {
            let auto_start =
                if let Some(pool) = monitor_app.try_state::<sqlx::sqlite::SqlitePool>() {
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
            let _ = monitor_app.emit(
                "project-hooks-updated",
                serde_json::json!({
                    "projectId": monitor_pid,
                    "setupHook": setup,
                    "destroyHook": destroy,
                    "startCommand": start,
                }),
            );
        }

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

        let error_msg = if final_status == "error" {
            stream_result
                .error
                .or_else(|| Some("Codex session exited unexpectedly".to_string()))
        } else {
            None
        };
        let _ = monitor_app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id: monitor_sid,
                status: final_status.to_string(),
                error: error_msg,
            },
        );
        let _ = monitor_app.emit(
            "git-status-changed",
            stream::GitStatusChangedEvent {
                task_id: monitor_tid,
            },
        );
    });

    Ok(())
}

async fn start_new_thread(
    agent: &dyn crate::agent::Agent,
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending: &crate::agent::codex_rpc::PendingRpcResponses,
    next_id: &AtomicI64,
    worktree_path: &str,
    trust_level: TrustLevel,
    model: Option<&str>,
) -> Result<String, String> {
    use crate::agent::codex_rpc;
    let req_id = codex_rpc::next_request_id(next_id);
    let bytes = agent.encode_rpc_thread_start(
        req_id,
        &crate::agent::CodexRpcThreadStartParams {
            cwd: worktree_path,
            trust_level,
            model,
        },
    )?;
    let result = codex_rpc::call(stdin, pending, req_id, &bytes)
        .await
        .map_err(|e| format!("codex thread/start failed: {e}"))?;
    result
        .pointer("/thread/id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "codex thread/start response missing thread.id".to_string())
}

fn effort_from_flags(thinking_mode: bool, fast_mode: bool) -> Option<String> {
    // Map Verun's thinking/fast binary knobs to a Codex reasoning effort
    // string. Mirrors t3code's mapping in `CodexSessionRuntime`.
    match (thinking_mode, fast_mode) {
        (true, _) => Some("high".to_string()),
        (_, true) => Some("low".to_string()),
        _ => None,
    }
}

/// Watch the JSON-RPC response for a `turn/start`.
///
/// codex app-server resolves `turn/start` synchronously (not at
/// `turn/completed`): the response body is `{turn: {id, status:"inProgress", …}}`.
/// We extract `turn.id` into `current_turn_id` so a subsequent
/// `turn/interrupt` can carry the required `turnId`. On a JSON-RPC error
/// (e.g. a protocol-level rejection like missing `experimentalApi`
/// capability), we flip busy + session-status here so the UI is not stuck in
/// `running` — the monitor would otherwise never see a `turn/completed`.
fn spawn_turn_start_response_watcher(
    app: AppHandle,
    db_tx: DbWriteTx,
    session_id: String,
    busy: Arc<AtomicBool>,
    current_turn_id: Arc<TokioMutex<Option<String>>>,
    rx: tokio::sync::oneshot::Receiver<
        Result<serde_json::Value, crate::agent::codex_rpc::JsonRpcError>,
    >,
) {
    tokio::spawn(async move {
        let err_msg = match rx.await {
            Ok(Ok(val)) => {
                if let Some(tid) = val
                    .pointer("/turn/id")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
                {
                    *current_turn_id.lock().await = Some(tid);
                }
                return;
            }
            Ok(Err(err)) => err.message,
            Err(_) => return,
        };
        if !busy.load(Ordering::SeqCst) {
            return;
        }
        eprintln!(
            "[verun][codex-rpc][{session_id}] turn/start failed: {err_msg}"
        );
        busy.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "session-output",
            stream::SessionOutputEvent {
                session_id: session_id.clone(),
                items: vec![stream::OutputItem::ErrorMessage {
                    message: err_msg.clone(),
                    raw: None,
                }],
            },
        );
        let _ = db_tx
            .send(db::DbWrite::UpdateSessionStatus {
                id: session_id.clone(),
                status: "error".to_string(),
            })
            .await;
        let _ = app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id,
                status: "error".to_string(),
                error: Some(err_msg),
            },
        );
    });
}

/// Spawn a new CLI process for this session and start the stream monitor.
///
/// Registers the child in `active` with `busy = !prewarm` (pre-warm leaves
/// the process idle). The caller is responsible for persisting the user
/// message and kicking off title generation.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_session_process(
    app: AppHandle,
    db_tx: DbWriteTx,
    active: ActiveMap,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    pending_control_responses: PendingControlResponses,
    params: SpawnSessionParams,
) -> Result<(), String> {
    let agent = AgentKind::parse(&params.agent_type).implementation();

    if agent.uses_app_server() {
        return spawn_codex_app_server_session(
            app,
            db_tx,
            active,
            pending_approvals,
            pending_approval_meta,
            agent,
            params,
        )
        .await;
    }

    let SpawnSessionParams {
        session_id,
        task_id,
        project_id,
        worktree_path,
        repo_path,
        port_offset,
        trust_level,
        resume_session_id,
        model,
        plan_mode,
        thinking_mode,
        fast_mode,
        agent_type,
        message,
        attachments,
        prewarm,
    } = params;
    let resume_id = resume_session_id.as_deref().filter(|s| !s.is_empty());
    let session_args = crate::agent::SessionArgs {
        resume_session_id: resume_id,
        model: model.as_deref(),
        plan_mode,
        thinking_mode,
        fast_mode,
        trust_level,
        worktree_path: &worktree_path,
        repo_path: &repo_path,
        message: &message,
    };

    let args_list = agent.build_session_args(&session_args);
    eprintln!(
        "[verun][{}] spawn{}: {} {}",
        agent.display_name(),
        if prewarm { " (prewarm)" } else { "" },
        agent.cli_binary(),
        args_list.join(" ")
    );
    eprintln!("[verun][{}] cwd: {}", agent.display_name(), worktree_path);
    eprintln!(
        "[verun][{}] input_mode: {:?}",
        agent.display_name(),
        agent.input_mode()
    );

    let mut cmd = tokio::process::Command::new(agent.cli_binary());
    cmd.args(&args_list);
    for (k, v) in worktree::verun_env_vars(port_offset, &repo_path) {
        cmd.env(&k, &v);
    }
    // Match claude-agent-sdk-python: strip `CLAUDECODE` (issue #573) so the spawned
    // CLI doesn't detect itself as nested, and tag the entrypoint for Anthropic telemetry.
    cmd.env_remove("CLAUDECODE");
    cmd.env("CLAUDE_CODE_ENTRYPOINT", "verun");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&worktree_path);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", agent.display_name()))?;

    eprintln!(
        "[verun][{}] spawned pid={:?}",
        agent.display_name(),
        child.id()
    );

    let stdin = match agent.input_mode() {
        crate::agent::InputMode::StreamJsonStdin => {
            let mut stdin_handle = child
                .stdin
                .take()
                .ok_or_else(|| "Failed to capture stdin".to_string())?;

            if !prewarm {
                let bytes = agent.encode_stream_user_message(&message, &attachments)?;
                stdin_handle
                    .write_all(&bytes)
                    .await
                    .map_err(|e| format!("Failed to write to stdin: {e}"))?;
                stdin_handle
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush stdin: {e}"))?;
            }

            // Keep stdin open — persistent agents reuse it for subsequent
            // user messages + control_request/response frames.
            Arc::new(TokioMutex::new(Some(stdin_handle)))
        }
        crate::agent::InputMode::PositionalOrStdin => {
            // Non-stream agents take the prompt as a positional arg (already in args_list).
            // Close stdin so the process doesn't wait for input.
            let stdin_handle = child.stdin.take();
            drop(stdin_handle);
            Arc::new(TokioMutex::new(None::<tokio::process::ChildStdin>))
        }
        crate::agent::InputMode::JsonRpcStdio => {
            // Codex `app-server`: keep stdin open; the RPC client drives
            // `initialize` → `thread/start` → `turn/start` itself. The full
            // branch lives in the Codex-specific spawn path (Phase 4); this
            // arm is the transitional default so the legacy flow compiles.
            let stdin_handle = child
                .stdin
                .take()
                .ok_or_else(|| "Failed to capture stdin".to_string())?;
            Arc::new(TokioMutex::new(Some(stdin_handle)))
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    // Forward stderr to logs (previously silently discarded — critical for debugging non-Claude agents).
    if let Some(stderr) = child.stderr.take() {
        let agent_name = agent.display_name().to_string();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    eprintln!("[verun][{agent_name}][stderr][{sid}] {trimmed}");
                }
                line.clear();
            }
        });
    }

    // Busy flag: prewarm = idle, real send = in-flight. Stream loop will flip
    // it to false on turn_end (only meaningful for persistent agents).
    let busy = Arc::new(AtomicBool::new(!prewarm));

    // Mark session as running (skip for prewarm — the session is idle).
    if !prewarm {
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
                error: None,
            },
        );
    }

    // Track the active process
    let kind = AgentKind::parse(&agent_type);
    let trust_level_atom = Arc::new(AtomicU8::new(trust_level.to_u8()));
    active.insert(
        session_id.clone(),
        ActiveProcess {
            child,
            task_id: task_id.clone(),
            stdin: stdin.clone(),
            busy: busy.clone(),
            trust_level: trust_level_atom.clone(),
            kind,
            current_permission_mode: if plan_mode { "plan" } else { "default" }.to_string(),
            current_model: model.clone(),
            current_thinking_mode: thinking_mode,
            current_fast_mode: fast_mode,
            codex_thread_id: None,
            codex_pending: None,
            codex_next_id: None,
            codex_current_turn_id: None,
        },
    );

    // Spawn monitor: stream output, detect exit, update DB
    let monitor_app = app.clone();
    let monitor_db_tx = db_tx.clone();
    let monitor_sid = session_id.clone();
    let monitor_tid = task_id.clone();
    let monitor_pid = project_id.clone();
    let monitor_active = active.clone();
    let monitor_pending = pending_approvals.clone();
    let monitor_pending_meta = pending_approval_meta.clone();
    let monitor_pending_ctrl = pending_control_responses.clone();
    let monitor_wt = worktree_path.clone();
    let monitor_repo = repo_path;
    let monitor_trust = trust_level_atom.clone();
    let monitor_agent = AgentKind::parse(&agent_type).implementation();
    let monitor_busy = busy.clone();
    tokio::spawn(async move {
        // Stream stdout lines to frontend + DB
        let wt_for_hooks = monitor_wt.clone();
        let stream_result = stream::stream_and_capture(
            monitor_app.clone(),
            monitor_sid.clone(),
            monitor_tid.clone(),
            stdout,
            stdin,
            monitor_busy,
            monitor_pending,
            monitor_pending_meta,
            monitor_pending_ctrl,
            monitor_db_tx.clone(),
            monitor_wt,
            monitor_repo,
            monitor_trust,
            monitor_agent,
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
            let exit_status = proc.child.wait().await.ok();
            let exit_code = exit_status.as_ref().and_then(|s| s.code());
            eprintln!("[verun][{}] exited code={:?}", monitor_sid, exit_code);
            stream::map_exit_status(exit_code)
        } else {
            // Aborted by abort_message
            return;
        };

        // Check for .verun.json config written by Claude auto-detect
        let config_path = format!("{wt_for_hooks}/.verun.json");
        if let Some((setup, destroy, start)) = parse_verun_config_file(&config_path) {
            // Look up existing auto_start so auto-detect doesn't reset it
            let auto_start = if let Some(pool) = monitor_app.try_state::<sqlx::sqlite::SqlitePool>()
            {
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
            let _ = monitor_app.emit(
                "project-hooks-updated",
                serde_json::json!({
                    "projectId": monitor_pid,
                    "setupHook": setup,
                    "destroyHook": destroy,
                    "startCommand": start,
                }),
            );
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

        let error_msg = if final_status == "error" {
            stream_result
                .error
                .or_else(|| Some("Session exited unexpectedly".to_string()))
        } else {
            None
        };
        let _ = monitor_app.emit(
            "session-status",
            stream::SessionStatusEvent {
                session_id: monitor_sid,
                status: final_status.to_string(),
                error: error_msg,
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

/// Abort the in-flight turn.
///
/// Dispatches on [`crate::agent::AbortStrategy`]:
/// * `Interrupt` (persistent agents): write a control_request interrupt frame
///   to stdin and leave the process alive. Emits `session-status: idle` and
///   `session-aborted` immediately — both near-instant.
/// * `Kill` (one-shot agents): remove from `active` and run
///   `graceful_shutdown` (EOF → SIGTERM → SIGKILL) in the background.
///   The process exits; a subsequent `send_message` respawns with `--resume`.
pub async fn abort_message(
    app: &AppHandle,
    db_tx: &DbWriteTx,
    active: &ActiveMap,
    session_id: &str,
) -> Result<(), String> {
    let kind = match active.get(session_id) {
        Some(entry) => entry.kind,
        None => return Ok(()), // Nothing to abort
    };
    let agent = kind.implementation();

    match agent.abort_strategy() {
        crate::agent::AbortStrategy::Interrupt => {
            let (stdin, rpc_state, busy) = match active.get(session_id) {
                Some(entry) => {
                    let rpc = if agent.uses_app_server() {
                        match (
                            entry.codex_thread_id.clone(),
                            entry.codex_pending.clone(),
                            entry.codex_next_id.clone(),
                            entry.codex_current_turn_id.clone(),
                        ) {
                            (Some(tid), Some(pending), Some(next_id), Some(current_turn)) => {
                                Some((tid, pending, next_id, current_turn))
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                    (entry.stdin.clone(), rpc, entry.busy.clone())
                }
                None => return Ok(()),
            };
            let (maybe_bytes, sent_rpc_interrupt) = if let Some((
                ref thread_id,
                ref _pending,
                ref next_id,
                ref current_turn_id,
            )) = rpc_state
            {
                // codex app-server requires both threadId AND turnId on
                // `turn/interrupt`. If `turn/start`'s response hasn't yet
                // populated the slot — either because we're mid-dispatch or
                // because the server is still processing the first frame —
                // we do NOT know which turn to cancel. Silently dropping the
                // interrupt *and* flipping the session to idle would leave
                // the real turn running under a UI that says it stopped.
                // Instead, treat a missing turn id as "abort is in-flight,
                // bail out and let the stream loop clear state on the real
                // `turn/completed { status: "interrupted" }` frame".
                let turn_id_opt = current_turn_id.lock().await.clone();
                match turn_id_opt {
                    Some(turn_id) => {
                        let req_id = crate::agent::codex_rpc::next_request_id(next_id);
                        (
                            Some(agent.encode_rpc_turn_interrupt(req_id, thread_id, &turn_id)?),
                            true,
                        )
                    }
                    None => {
                        eprintln!(
                            "[verun][codex-rpc][{session_id}] abort requested before turn/start resolved — skipping interrupt and leaving busy flag set so the stream loop can clear it on turn/completed"
                        );
                        (None, false)
                    }
                }
            } else {
                (Some(agent.encode_stream_interrupt(&new_control_request_id())?), false)
            };
            if let Some(bytes) = maybe_bytes {
                // Best-effort: if stdin is already closed we fall through
                // (session will hit the regular exit path).
                let _ = write_to_stdin(&stdin, &bytes).await;
            }

            // Only flip the session to idle when we actually sent an RPC
            // interrupt (or we're on the legacy kill path, handled below).
            // If we skipped the interrupt because the turn id was not yet
            // known, the real turn is still running — leave busy set and
            // let `turn/completed` drive the status.
            if sent_rpc_interrupt || rpc_state.is_none() {
                // Clear busy so the next send_message doesn't bounce with
                // "already processing". The stream monitor will later see
                // `turn/completed { status: "interrupted" }` and clear
                // again — idempotent.
                busy.store(false, Ordering::SeqCst);

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
                        error: None,
                    },
                );
                // Interrupt completes on a single stdin write; no background
                // wait. Emit session-aborted right away so the frontend
                // drains armed steps.
                let _ = app.emit("session-aborted", session_id.to_string());
            }
        }
        crate::agent::AbortStrategy::Kill => {
            let Some((_, mut proc)) = active.remove(session_id) else {
                return Ok(());
            };
            // Send interrupt first so the CLI cancels token generation immediately,
            // instead of finishing the in-flight turn before seeing EOF on stdin.
            // Non-persistent agents: best-effort, most won't support it.
            if let Ok(bytes) = agent.encode_stream_interrupt(&new_control_request_id()) {
                let _ = write_to_stdin(&proc.stdin, &bytes).await;
            }

            // Do the EOF → SIGTERM → SIGKILL dance in the background so the UI
            // doesn't block on the grace period. Emit `session-aborted` when truly
            // stopped so the frontend can drain its armed-step queue.
            let app_clone = app.clone();
            let sid_clone = session_id.to_string();
            tokio::spawn(async move {
                graceful_shutdown(&mut proc.child, &proc.stdin).await;
                let _ = app_clone.emit("session-aborted", sid_clone);
            });

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
                    error: None,
                },
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Control protocol helpers — send `control_request` to a running CLI over stdin
// and correlate the `control_response` reply.
// ---------------------------------------------------------------------------

/// Generate a unique request id matching the claude-agent-sdk format.
fn new_control_request_id() -> String {
    let mut bytes = [0u8; 4];
    getrandom_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("req_{}_{hex}", uuid::Uuid::new_v4().simple())
}

/// Tiny wrapper around /dev/urandom — avoids pulling in a new crate just for 4 bytes.
fn getrandom_bytes(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    }
}

/// Write a `control_request` JSON line to the given stdin and optionally register
/// a oneshot to await the matching `control_response`. Returns the request id.
async fn send_control_request(
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending: Option<&PendingControlResponses>,
    request: serde_json::Value,
) -> Result<
    (
        String,
        Option<oneshot::Receiver<Result<serde_json::Value, String>>>,
    ),
    String,
> {
    let request_id = new_control_request_id();
    let envelope = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    });

    let mut payload = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    payload.push('\n');

    let rx = if let Some(pending) = pending {
        let (tx, rx) = oneshot::channel();
        pending.insert(request_id.clone(), tx);
        Some(rx)
    } else {
        None
    };

    let mut guard = stdin.lock().await;
    let writer = guard
        .as_mut()
        .ok_or_else(|| "Session stdin is closed".to_string())?;
    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;

    Ok((request_id, rx))
}

/// Send `{subtype: "interrupt"}` to cancel the current turn without killing the process.
/// Fire-and-forget — the CLI ACKs via a control_response we don't need to inspect.
pub async fn interrupt_session(active: &ActiveMap, session_id: &str) -> Result<(), String> {
    let stdin = active
        .get(session_id)
        .map(|proc| proc.stdin.clone())
        .ok_or_else(|| "No active session".to_string())?;

    let (_req_id, _rx) = send_control_request(
        &stdin,
        None,
        serde_json::json!({ "subtype": "interrupt" }),
    )
    .await?;
    Ok(())
}

/// Ask the CLI for the current context-window usage, awaiting the response.
pub async fn get_session_context_usage(
    active: &ActiveMap,
    pending: &PendingControlResponses,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let stdin = active
        .get(session_id)
        .map(|proc| proc.stdin.clone())
        .ok_or_else(|| "No active session".to_string())?;

    let (request_id, rx) = send_control_request(
        &stdin,
        Some(pending),
        serde_json::json!({ "subtype": "get_context_usage" }),
    )
    .await?;
    let rx = rx.expect("pending map provided");

    let result = tokio::time::timeout(Duration::from_secs(10), rx).await;

    // Always clean up the pending entry on timeout so we don't leak.
    if result.is_err() {
        pending.remove(&request_id);
    }

    match result {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("Session closed before responding".to_string()),
        Err(_) => Err("Timed out waiting for CLI response".to_string()),
    }
}

fn title_generation_args(prompt: &str) -> Vec<String> {
    vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "text".into(),
        "--no-session-persistence".into(),
        "--strict-mcp-config".into(),
        "--model".into(),
        "haiku".into(),
    ]
}

/// Generate a short title using a standalone Haiku call (fast, doesn't affect session).
/// Uses the Claude CLI regardless of agent type since title generation is a Verun feature.
async fn generate_session_title(first_message: &str, worktree_path: &str) -> Option<String> {
    let prompt = format!(
        "Generate a 3-5 word title summarizing what the user wants. Reply with ONLY the title, nothing else. If the message is too vague or unclear to summarize (e.g. just a greeting), reply with exactly NONE.\n\nUser message: {}",
        first_message.chars().take(300).collect::<String>()
    );
    let output = tokio::process::Command::new(AgentKind::Claude.implementation().cli_binary())
        .args(title_generation_args(&prompt))
        .env_remove("CLAUDECODE")
        .env("CLAUDE_CODE_ENTRYPOINT", "verun")
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
    app: &AppHandle,
    pool: &sqlx::sqlite::SqlitePool,
    source_session_id: String,
    fork_after_message_uuid: String,
) -> Result<Session, String> {
    let parent = db::get_session(pool, &source_session_id)
        .await?
        .ok_or_else(|| format!("Session {source_session_id} not found"))?;
    let parent_csid = parent
        .resume_session_id
        .clone()
        .ok_or_else(|| "Parent session has no resume session id (never started?)".to_string())?;

    let task = db::get_task(pool, &parent.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", parent.task_id))?;

    let agent_impl = AgentKind::parse(&parent.agent_type).implementation();
    let new_csid = Uuid::new_v4().to_string();
    let new_verun_sid = Uuid::new_v4().to_string();
    let now = epoch_ms();

    // Truncate the on-disk JSONL transcript (Claude only).
    if agent_impl.uses_claude_jsonl() {
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
    }

    // Load parent output_lines outside the transaction so we can hold the
    // boundary check's error path separate from DB state.
    let parent_lines = db::get_output_lines(pool, &parent.id).await?;

    let new_session = Session {
        id: new_verun_sid.clone(),
        task_id: parent.task_id.clone(),
        name: parent.name.as_ref().map(|n| format!("{n} (fork)")),
        resume_session_id: Some(new_csid),
        status: "idle".to_string(),
        started_at: now,
        ended_at: None,
        total_cost: 0.0,
        parent_session_id: Some(parent.id.clone()),
        forked_at_message_uuid: Some(fork_after_message_uuid.clone()),
        agent_type: parent.agent_type.clone(),
        model: parent.model.clone(),
        closed_at: None,
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

    let _ = app.emit("session-created", &new_session);

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
        "INSERT INTO sessions (id, task_id, name, resume_session_id, status, started_at, ended_at, total_cost, parent_session_id, forked_at_message_uuid, agent_type, model, closed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.task_id)
    .bind(&s.name)
    .bind(&s.resume_session_id)
    .bind(&s.status)
    .bind(s.started_at)
    .bind(s.ended_at)
    .bind(s.total_cost)
    .bind(&s.parent_session_id)
    .bind(&s.forked_at_message_uuid)
    .bind(&s.agent_type)
    .bind(&s.model)
    .bind(s.closed_at)
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
        "INSERT INTO tasks (id, project_id, name, worktree_path, branch, created_at, port_offset, parent_task_id, agent_type) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&t.id)
    .bind(&t.project_id)
    .bind(&t.name)
    .bind(&t.worktree_path)
    .bind(&t.branch)
    .bind(t.created_at)
    .bind(t.port_offset)
    .bind(&t.parent_task_id)
    .bind(&t.agent_type)
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
        .resume_session_id
        .clone()
        .ok_or_else(|| "Parent session has no resume session id (never started?)".to_string())?;
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
    let repo_path = project.repo_path.clone();
    let branch = generate_branch_name(&repo_path);
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
                        run_git_ignoring_env(&new_pb, &["read-tree", "--reset", "-u", &tree_ref])
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
        agent_type: parent_session.agent_type.clone(),
        last_pushed_sha: None,
    };

    let parent_agent = AgentKind::parse(&parent_session.agent_type).implementation();
    let new_csid = Uuid::new_v4().to_string();
    let new_verun_sid = Uuid::new_v4().to_string();
    let now = epoch_ms();

    // Truncate on-disk JSONL transcript (Claude only)
    if parent_agent.uses_claude_jsonl() {
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
    }

    let new_session = Session {
        id: new_verun_sid.clone(),
        task_id: new_task.id.clone(),
        name: parent_session.name.as_ref().map(|n| format!("{n} (fork)")),
        resume_session_id: Some(new_csid),
        status: "idle".to_string(),
        started_at: now,
        ended_at: None,
        total_cost: 0.0,
        parent_session_id: Some(parent_session.id.clone()),
        forked_at_message_uuid: Some(fork_after_message_uuid.clone()),
        agent_type: parent_session.agent_type.clone(),
        model: parent_session.model.clone(),
        closed_at: None,
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
    let _ = app.emit("session-created", &new_session);

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
    fn branch_name_format() {
        let name = generate_branch_name("");
        let parts: Vec<&str> = name.split('-').collect();
        assert!(!name.is_empty(), "Branch name should not be empty");
        assert!(
            parts.last().unwrap().parse::<u64>().is_ok(),
            "Last part should be a number, got: {name}"
        );
    }

    #[test]
    fn branch_names_vary() {
        let a = generate_branch_name("");
        std::thread::sleep(std::time::Duration::from_millis(1));
        let b = generate_branch_name("");
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
    fn word_banks_have_enough_variety() {
        assert!(ADJECTIVES.len() >= 72);
        assert!(NOUNS_GENERIC.len() >= 72);
    }

    #[test]
    fn collect_stack_nouns_empty_path_returns_generic() {
        let nouns = collect_stack_nouns("/tmp/verun-nonexistent-test-path-xyz");
        assert_eq!(nouns, NOUNS_GENERIC);
    }

    #[test]
    fn collect_stack_nouns_merges_multiple_stacks() {
        let dir = std::env::temp_dir().join(format!("verun-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();

        let nouns = collect_stack_nouns(dir.to_str().unwrap());
        let has_rust = NOUNS_RUST.iter().any(|n| nouns.contains(n));
        let has_js = NOUNS_JS.iter().any(|n| nouns.contains(n));
        assert!(has_rust, "Should contain Rust nouns");
        assert!(has_js, "Should contain JS nouns");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn control_request_id_is_unique_and_prefixed() {
        let a = new_control_request_id();
        let b = new_control_request_id();
        assert!(a.starts_with("req_"));
        assert!(b.starts_with("req_"));
        assert_ne!(a, b);
    }

    // Regression: archiving / deleting a task must not kill sessions on other tasks.
    // See https://github.com/SoftwareSavants/verun/issues/169
    #[test]
    fn active_session_ids_for_task_returns_only_matching_sessions() {
        let active_ids = vec!["s1".to_string(), "s2".to_string(), "s3".to_string()];
        let task_session_ids = ["s2".to_string(), "s4".to_string()];
        let result = active_session_ids_for_task(active_ids, &task_session_ids);
        assert_eq!(result, vec!["s2".to_string()]);
    }

    #[test]
    fn active_session_ids_for_task_empty_when_no_overlap() {
        let active_ids = vec!["s1".to_string()];
        let task_session_ids = ["s2".to_string()];
        let result = active_session_ids_for_task(active_ids, &task_session_ids);
        assert!(result.is_empty());
    }

    #[test]
    fn active_session_ids_for_task_excludes_other_tasks_sessions() {
        // Active sessions: s1, s2 belong to task A; s3, s4 belong to task B.
        // Archiving task B should return only s3, s4 - never s1, s2.
        let active_ids: Vec<String> =
            vec!["s1".into(), "s2".into(), "s3".into(), "s4".into()];
        let task_b_session_ids = ["s3".to_string(), "s4".to_string()];
        let mut result = active_session_ids_for_task(active_ids, &task_b_session_ids);
        result.sort();
        assert_eq!(result, vec!["s3".to_string(), "s4".to_string()]);
    }

    #[test]
    fn title_generation_args_disables_mcp() {
        let args = title_generation_args("do something");
        assert!(
            args.iter().any(|a| a == "--strict-mcp-config"),
            "title generation must pass --strict-mcp-config to avoid MCP context inflation"
        );
    }

    #[test]
    fn title_generation_args_includes_required_flags() {
        let args = title_generation_args("test prompt");
        assert!(args.iter().any(|a| a == "-p"));
        assert!(args.iter().any(|a| a == "test prompt"));
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
        assert!(args.iter().any(|a| a == "haiku"));
    }
}
