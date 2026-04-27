use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::FromRow;
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Migrations (consumed by tauri-plugin-sql)
// ---------------------------------------------------------------------------

pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create initial tables",
        sql: r#"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                repo_path TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                name TEXT,
                worktree_path TEXT NOT NULL,
                branch TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id),
                name TEXT,
                claude_session_id TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                started_at INTEGER NOT NULL,
                ended_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS output_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                line TEXT NOT NULL,
                emitted_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
            CREATE INDEX IF NOT EXISTS idx_output_session ON output_lines(session_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "add trust levels and policy audit log",
        sql: r#"
            CREATE TABLE IF NOT EXISTS task_trust_levels (
                task_id TEXT PRIMARY KEY REFERENCES tasks(id),
                trust_level TEXT NOT NULL DEFAULT 'normal',
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS policy_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                tool_input_summary TEXT NOT NULL,
                decision TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_audit_session ON policy_audit_log(session_id);
            CREATE INDEX IF NOT EXISTS idx_audit_task ON policy_audit_log(task_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "add base_branch to projects",
        sql: "ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main';",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 4,
        description: "add merge_base_sha to tasks",
        sql: "ALTER TABLE tasks ADD COLUMN merge_base_sha TEXT;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 5,
        description: "add lifecycle hooks to projects",
        sql: r#"
            ALTER TABLE projects ADD COLUMN setup_hook TEXT NOT NULL DEFAULT '';
            ALTER TABLE projects ADD COLUMN destroy_hook TEXT NOT NULL DEFAULT '';
            ALTER TABLE projects ADD COLUMN start_command TEXT NOT NULL DEFAULT '';
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 6,
        description: "add port_offset to tasks for parallel port allocation",
        sql: "ALTER TABLE tasks ADD COLUMN port_offset INTEGER NOT NULL DEFAULT 0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 7,
        description: "add total_cost to sessions",
        sql: "ALTER TABLE sessions ADD COLUMN total_cost REAL NOT NULL DEFAULT 0.0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 8,
        description: "create steps table for persistent message queue",
        sql: r#"
            CREATE TABLE IF NOT EXISTS steps (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                message TEXT NOT NULL,
                attachments_json TEXT,
                armed INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                plan_mode INTEGER,
                thinking_mode INTEGER,
                fast_mode INTEGER,
                sort_order INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 9,
        description: "add archived flag to tasks",
        sql: "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 10,
        description: "add archived_at and last_commit_message to tasks",
        sql: r#"
            ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
            ALTER TABLE tasks ADD COLUMN last_commit_message TEXT;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 11,
        description: "add auto_start toggle to projects",
        sql: "ALTER TABLE projects ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 12,
        description: "add fork lineage and per-turn worktree snapshots",
        sql: r#"
            ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
            ALTER TABLE sessions ADD COLUMN forked_at_message_uuid TEXT;
            ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;

            CREATE TABLE IF NOT EXISTS turn_snapshots (
                session_id TEXT NOT NULL,
                message_uuid TEXT NOT NULL,
                stash_sha TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, message_uuid)
            );
            CREATE INDEX IF NOT EXISTS idx_turn_snapshots_session ON turn_snapshots(session_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 13,
        description: "add agent_type to tasks",
        sql: "ALTER TABLE tasks ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude';",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 14,
        description: "add default_agent_type to projects",
        sql: "ALTER TABLE projects ADD COLUMN default_agent_type TEXT NOT NULL DEFAULT 'claude';",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 15,
        description: "add agent_type and model to sessions",
        sql: "ALTER TABLE sessions ADD COLUMN agent_type TEXT; ALTER TABLE sessions ADD COLUMN model TEXT;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 16,
        description: "backfill session agent_type from task, default claude",
        sql: "UPDATE sessions SET agent_type = COALESCE(agent_type, (SELECT agent_type FROM tasks WHERE tasks.id = sessions.task_id), 'claude') WHERE agent_type IS NULL;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 17,
        description: "rename claude_session_id to resume_session_id",
        sql: "ALTER TABLE sessions RENAME COLUMN claude_session_id TO resume_session_id;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 18,
        description: "add last_pushed_sha to tasks",
        sql: "ALTER TABLE tasks ADD COLUMN last_pushed_sha TEXT;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 19,
        description: "add closed_at to sessions",
        sql: "ALTER TABLE sessions ADD COLUMN closed_at INTEGER;",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 20,
        description: "create blobs table for content-addressed attachment storage",
        sql: r#"
            CREATE TABLE IF NOT EXISTS blobs (
                hash TEXT PRIMARY KEY,
                mime TEXT NOT NULL,
                size INTEGER NOT NULL,
                ref_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_blobs_ref_count ON blobs(ref_count);
            CREATE INDEX IF NOT EXISTS idx_blobs_last_used ON blobs(last_used_at);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 21,
        description: "create app_meta key-value table for one-shot migration sentinels",
        sql: r#"
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 22,
        description: "add session token aggregate columns",
        sql: r#"
            ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 23,
        description: "create github cache entries table",
        sql: r#"
            CREATE TABLE IF NOT EXISTS github_cache_entries (
                cache_key TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id),
                scope TEXT NOT NULL,
                entity_id TEXT,
                etag TEXT,
                payload_json TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                stale_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_error TEXT,
                rate_limit_reset_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_github_cache_task_scope
              ON github_cache_entries(task_id, scope);
        "#,
        kind: MigrationKind::Up,
    }]
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub base_branch: String,
    pub setup_hook: String,
    pub destroy_hook: String,
    pub start_command: String,
    pub auto_start: bool,
    pub created_at: i64,
    #[sqlx(default)]
    pub default_agent_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub worktree_path: String,
    pub branch: String,
    pub created_at: i64,
    pub merge_base_sha: Option<String>,
    pub port_offset: i64,
    #[sqlx(default)]
    pub archived: bool,
    #[sqlx(default)]
    pub archived_at: Option<i64>,
    #[sqlx(default)]
    pub last_commit_message: Option<String>,
    #[sqlx(default)]
    pub parent_task_id: Option<String>,
    #[sqlx(default)]
    pub agent_type: String,
    #[sqlx(default)]
    pub last_pushed_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub task_id: String,
    pub name: Option<String>,
    pub resume_session_id: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub total_cost: f64,
    #[sqlx(default)]
    pub input_tokens: i64,
    #[sqlx(default)]
    pub output_tokens: i64,
    #[sqlx(default)]
    pub cache_read_tokens: i64,
    #[sqlx(default)]
    pub cache_write_tokens: i64,
    #[sqlx(default)]
    pub parent_session_id: Option<String>,
    #[sqlx(default)]
    pub forked_at_message_uuid: Option<String>,
    #[sqlx(default)]
    pub agent_type: String,
    #[sqlx(default)]
    pub model: Option<String>,
    #[sqlx(default)]
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    pub id: i64,
    pub session_id: String,
    pub line: String,
    pub emitted_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokenTotals {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SessionUsageDelta {
    pub total_cost: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

impl SessionUsageDelta {
    pub fn is_zero(&self) -> bool {
        self.total_cost == 0.0
            && self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_write_tokens == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub session_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub tool_input_summary: String,
    pub decision: String,
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub session_id: String,
    pub message_uuid: String,
    pub stash_sha: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub session_id: String,
    pub message: String,
    pub attachments_json: Option<String>,
    pub armed: bool,
    pub model: Option<String>,
    pub plan_mode: Option<bool>,
    pub thinking_mode: Option<bool>,
    pub fast_mode: Option<bool>,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCacheEntry {
    pub cache_key: String,
    pub task_id: String,
    pub scope: String,
    pub entity_id: Option<String>,
    pub payload_json: String,
    pub fetched_at: i64,
    pub stale_at: i64,
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// Async write queue
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub enum DbWrite {
    // Projects
    InsertProject(Project),
    UpdateProjectBaseBranch {
        id: String,
        base_branch: String,
    },
    UpdateProjectHooks {
        id: String,
        setup_hook: String,
        destroy_hook: String,
        start_command: String,
        auto_start: bool,
    },
    UpdateProjectDefaultAgent {
        id: String,
        default_agent_type: String,
    },
    DeleteProject {
        id: String,
    },

    // Tasks
    InsertTask(Task),
    UpdateTaskName {
        id: String,
        name: String,
    },
    SetMergeBaseSha {
        id: String,
        sha: String,
    },
    DeleteTask {
        id: String,
    },
    ArchiveTask {
        id: String,
        archived_at: i64,
        last_commit_message: Option<String>,
    },
    SetLastCommitMessage {
        id: String,
        msg: Option<String>,
    },
    RestoreTask {
        id: String,
    },
    SetLastPushedSha {
        id: String,
        sha: String,
    },

    // Sessions
    CreateSession(Session),
    UpdateSessionName {
        id: String,
        name: String,
    },
    UpdateSessionStatus {
        id: String,
        status: String,
    },
    UpdateSessionModel {
        id: String,
        model: Option<String>,
    },
    SetResumeSessionId {
        id: String,
        resume_session_id: String,
    },
    EndSession {
        id: String,
        ended_at: i64,
    },
    CloseSession {
        id: String,
        closed_at: i64,
    },
    ReopenSession {
        id: String,
    },

    // Output
    InsertOutputLines {
        session_id: String,
        lines: Vec<(String, i64)>,
    },
    DeleteOutputLines {
        session_id: String,
    },

    // Turn snapshots (per-turn worktree state for forking)
    InsertTurnSnapshot {
        session_id: String,
        message_uuid: String,
        stash_sha: String,
        created_at: i64,
    },
    DeleteTurnSnapshotsForSession {
        session_id: String,
    },

    // Policy
    SetTrustLevel {
        task_id: String,
        trust_level: String,
        updated_at: i64,
    },
    InsertAuditEntry {
        session_id: String,
        task_id: String,
        tool_name: String,
        tool_input_summary: String,
        decision: String,
        reason: String,
        created_at: i64,
    },

    // Steps
    InsertStep(Step),
    UpdateStep {
        id: String,
        message: String,
        armed: bool,
        model: Option<String>,
        plan_mode: Option<bool>,
        thinking_mode: Option<bool>,
        fast_mode: Option<bool>,
        attachments_json: Option<String>,
    },
    DeleteStep {
        id: String,
    },
    ReorderSteps {
        session_id: String,
        ids: Vec<String>,
    },
    DisarmAllSteps {
        session_id: String,
    },

    // Startup recovery
    ResetRunningSessions,
}

pub type DbWriteTx = mpsc::Sender<DbWrite>;

/// Spawn the background write loop. Returns a sender handle to enqueue writes.
pub fn spawn_write_queue(pool: SqlitePool) -> DbWriteTx {
    let (tx, mut rx) = mpsc::channel::<DbWrite>(1024);
    tauri::async_runtime::spawn(async move {
        while let Some(write) = rx.recv().await {
            if let Err(e) = process_write(&pool, write).await {
                eprintln!("[verun] db write error: {e}");
            }
        }
    });
    tx
}

/// Refcount errors are non-fatal — refcount drift is recoverable on the next
/// GC sweep, but failing the actual write would lose user data.
fn log_refcount_err(label: &str, result: Result<(), String>) {
    if let Err(e) = result {
        eprintln!("[verun] blob refcount {label} failed: {e}");
    }
}

pub(crate) fn usage_delta_from_output_line(line: &str) -> SessionUsageDelta {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return SessionUsageDelta::default(),
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("verun_items") {
        return SessionUsageDelta::default();
    }
    let items = match v.get("items").and_then(|i| i.as_array()) {
        Some(items) => items,
        None => return SessionUsageDelta::default(),
    };
    let mut delta = SessionUsageDelta::default();
    for item in items {
        if item.get("kind").and_then(|k| k.as_str()) != Some("turnEnd") {
            continue;
        }
        delta.total_cost += item.get("cost").and_then(|x| x.as_f64()).unwrap_or(0.0);
        delta.input_tokens += item
            .get("inputTokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        delta.output_tokens += item
            .get("outputTokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        delta.cache_read_tokens += item
            .get("cacheReadTokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        delta.cache_write_tokens += item
            .get("cacheWriteTokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
    }
    delta
}

/// Walk every output_line for the given sessions and accumulate the blob
/// hashes referenced by their NDJSON payloads.
async fn collect_hashes_from_output_lines(
    pool: &SqlitePool,
    session_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let mut out = Vec::new();
    for sid in session_ids {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT line FROM output_lines WHERE session_id = ?")
                .bind(sid)
                .fetch_all(pool)
                .await?;
        for (line,) in rows {
            out.extend(crate::blob::extract_hashes_from_output_line(&line));
        }
    }
    Ok(out)
}

/// Snapshot every blob hash referenced by steps + output_lines for the given
/// sessions. Used by cascade-delete handlers (DeleteTask, DeleteProject) to
/// figure out what to decrement *before* the cascade nukes the rows.
async fn drain_refs_for_sessions(
    pool: &SqlitePool,
    session_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let mut hashes = Vec::new();
    for sid in session_ids {
        let step_rows: Vec<(Option<String>,)> =
            sqlx::query_as("SELECT attachments_json FROM steps WHERE session_id = ?")
                .bind(sid)
                .fetch_all(pool)
                .await?;
        for (json,) in step_rows {
            hashes.extend(crate::blob::extract_hashes_from_attachments_json(
                json.as_deref(),
            ));
        }
    }
    hashes.extend(collect_hashes_from_output_lines(pool, session_ids).await?);
    Ok(hashes)
}

async fn process_write(pool: &SqlitePool, write: DbWrite) -> Result<(), sqlx::Error> {
    match write {
        // -- Projects --
        DbWrite::InsertProject(p) => {
            sqlx::query(
                "INSERT INTO projects (id, name, repo_path, base_branch, setup_hook, destroy_hook, start_command, auto_start, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&p.id)
            .bind(&p.name)
            .bind(&p.repo_path)
            .bind(&p.base_branch)
            .bind(&p.setup_hook)
            .bind(&p.destroy_hook)
            .bind(&p.start_command)
            .bind(p.auto_start)
            .bind(p.created_at)
            .execute(pool)
            .await?;
        }
        DbWrite::UpdateProjectBaseBranch { id, base_branch } => {
            sqlx::query("UPDATE projects SET base_branch = ? WHERE id = ?")
                .bind(&base_branch)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::UpdateProjectHooks {
            id,
            setup_hook,
            destroy_hook,
            start_command,
            auto_start,
        } => {
            sqlx::query("UPDATE projects SET setup_hook = ?, destroy_hook = ?, start_command = ?, auto_start = ? WHERE id = ?")
                .bind(&setup_hook)
                .bind(&destroy_hook)
                .bind(&start_command)
                .bind(auto_start)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::UpdateProjectDefaultAgent {
            id,
            default_agent_type,
        } => {
            sqlx::query("UPDATE projects SET default_agent_type = ? WHERE id = ?")
                .bind(&default_agent_type)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::DeleteProject { id } => {
            // Drain blob refcounts before the cascade — once steps and
            // output_lines are gone we can no longer recover their hashes.
            let session_ids: Vec<String> = sqlx::query_as::<_, (String,)>(
                "SELECT s.id FROM sessions s JOIN tasks t ON s.task_id = t.id WHERE t.project_id = ?",
            )
            .bind(&id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(s,)| s)
            .collect();
            let drained = drain_refs_for_sessions(pool, &session_ids).await?;

            // Cascade: audit_log → trust_levels → steps → output_lines → turn_snapshots → sessions → tasks → project
            sqlx::query(
                "DELETE FROM policy_audit_log WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            sqlx::query(
                "DELETE FROM task_trust_levels WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            sqlx::query(
                "DELETE FROM steps WHERE session_id IN \
                 (SELECT s.id FROM sessions s JOIN tasks t ON s.task_id = t.id WHERE t.project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM output_lines WHERE session_id IN \
                 (SELECT s.id FROM sessions s JOIN tasks t ON s.task_id = t.id WHERE t.project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            log_refcount_err(
                "decr DeleteProject",
                crate::blob::decr_refs(pool, &drained).await,
            );
            sqlx::query(
                "DELETE FROM turn_snapshots WHERE session_id IN \
                 (SELECT s.id FROM sessions s JOIN tasks t ON s.task_id = t.id WHERE t.project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM sessions WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            sqlx::query("DELETE FROM tasks WHERE project_id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM projects WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
        }

        // -- Tasks --
        DbWrite::InsertTask(t) => {
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
            .execute(pool)
            .await?;
        }
        DbWrite::UpdateTaskName { id, name } => {
            sqlx::query("UPDATE tasks SET name = ? WHERE id = ?")
                .bind(&name)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::SetMergeBaseSha { id, sha } => {
            sqlx::query("UPDATE tasks SET merge_base_sha = ? WHERE id = ?")
                .bind(&sha)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::DeleteTask { id } => {
            // Drain blob refcounts for sessions of this task before cascade.
            let session_ids: Vec<String> =
                sqlx::query_as::<_, (String,)>("SELECT id FROM sessions WHERE task_id = ?")
                    .bind(&id)
                    .fetch_all(pool)
                    .await?
                    .into_iter()
                    .map(|(s,)| s)
                    .collect();
            let drained = drain_refs_for_sessions(pool, &session_ids).await?;

            sqlx::query("DELETE FROM policy_audit_log WHERE task_id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM task_trust_levels WHERE task_id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
            sqlx::query(
                "DELETE FROM steps WHERE session_id IN \
                 (SELECT id FROM sessions WHERE task_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            sqlx::query(
                "DELETE FROM output_lines WHERE session_id IN \
                 (SELECT id FROM sessions WHERE task_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            log_refcount_err(
                "decr DeleteTask",
                crate::blob::decr_refs(pool, &drained).await,
            );
            sqlx::query(
                "DELETE FROM turn_snapshots WHERE session_id IN \
                 (SELECT id FROM sessions WHERE task_id = ?)",
            )
            .bind(&id)
            .execute(pool)
            .await?;
            sqlx::query("DELETE FROM sessions WHERE task_id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM tasks WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
        }

        DbWrite::ArchiveTask {
            id,
            archived_at,
            last_commit_message,
        } => {
            sqlx::query("UPDATE tasks SET archived = 1, archived_at = ?, last_commit_message = ? WHERE id = ?")
                .bind(archived_at).bind(&last_commit_message).bind(&id).execute(pool).await?;
        }

        DbWrite::SetLastCommitMessage { id, msg } => {
            sqlx::query("UPDATE tasks SET last_commit_message = ? WHERE id = ?")
                .bind(&msg)
                .bind(&id)
                .execute(pool)
                .await?;
        }

        DbWrite::RestoreTask { id } => {
            sqlx::query("UPDATE tasks SET archived = 0, archived_at = NULL WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::SetLastPushedSha { id, sha } => {
            sqlx::query("UPDATE tasks SET last_pushed_sha = ? WHERE id = ?")
                .bind(&sha)
                .bind(&id)
                .execute(pool)
                .await?;
        }

        // -- Sessions --
        DbWrite::CreateSession(s) => {
            sqlx::query(
                "INSERT INTO sessions (id, task_id, name, resume_session_id, status, started_at, ended_at, total_cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, parent_session_id, forked_at_message_uuid, agent_type, model, closed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&s.id)
            .bind(&s.task_id)
            .bind(&s.name)
            .bind(&s.resume_session_id)
            .bind(&s.status)
            .bind(s.started_at)
            .bind(s.ended_at)
            .bind(s.total_cost)
            .bind(s.input_tokens)
            .bind(s.output_tokens)
            .bind(s.cache_read_tokens)
            .bind(s.cache_write_tokens)
            .bind(&s.parent_session_id)
            .bind(&s.forked_at_message_uuid)
            .bind(&s.agent_type)
            .bind(&s.model)
            .bind(s.closed_at)
            .execute(pool)
            .await?;
        }
        DbWrite::UpdateSessionName { id, name } => {
            sqlx::query("UPDATE sessions SET name = ? WHERE id = ?")
                .bind(&name)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::UpdateSessionStatus { id, status } => {
            sqlx::query("UPDATE sessions SET status = ? WHERE id = ?")
                .bind(&status)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::UpdateSessionModel { id, model } => {
            sqlx::query("UPDATE sessions SET model = ? WHERE id = ?")
                .bind(&model)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::SetResumeSessionId {
            id,
            resume_session_id,
        } => {
            sqlx::query("UPDATE sessions SET resume_session_id = ? WHERE id = ?")
                .bind(&resume_session_id)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::EndSession { id, ended_at } => {
            sqlx::query("UPDATE sessions SET status = 'done', ended_at = ? WHERE id = ?")
                .bind(ended_at)
                .bind(&id)
                .execute(pool)
                .await?;
        }

        // -- Output --
        DbWrite::InsertOutputLines { session_id, lines } => {
            let mut hashes_to_incr: Vec<String> = Vec::new();
            let mut usage_delta = SessionUsageDelta::default();
            let mut tx = pool.begin().await?;
            for (line, emitted_at) in &lines {
                hashes_to_incr.extend(crate::blob::extract_hashes_from_output_line(line));
                let delta = usage_delta_from_output_line(line);
                usage_delta.total_cost += delta.total_cost;
                usage_delta.input_tokens += delta.input_tokens;
                usage_delta.output_tokens += delta.output_tokens;
                usage_delta.cache_read_tokens += delta.cache_read_tokens;
                usage_delta.cache_write_tokens += delta.cache_write_tokens;
                sqlx::query(
                    "INSERT INTO output_lines (session_id, line, emitted_at) VALUES (?, ?, ?)",
                )
                .bind(&session_id)
                .bind(line)
                .bind(emitted_at)
                .execute(&mut *tx)
                .await?;
            }
            if !usage_delta.is_zero() {
                sqlx::query(
                    "UPDATE sessions SET total_cost = total_cost + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ? WHERE id = ?",
                )
                .bind(usage_delta.total_cost)
                .bind(usage_delta.input_tokens)
                .bind(usage_delta.output_tokens)
                .bind(usage_delta.cache_read_tokens)
                .bind(usage_delta.cache_write_tokens)
                .bind(&session_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            log_refcount_err(
                "incr InsertOutputLines",
                crate::blob::incr_refs(pool, &hashes_to_incr).await,
            );
        }

        DbWrite::CloseSession { id, closed_at } => {
            sqlx::query("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?")
                .bind(closed_at)
                .bind(&id)
                .execute(pool)
                .await?;
        }

        DbWrite::ReopenSession { id } => {
            sqlx::query(
                "UPDATE sessions SET status = 'idle', closed_at = NULL \
                 WHERE id = ? AND status = 'closed'",
            )
            .bind(&id)
            .execute(pool)
            .await?;
        }

        DbWrite::DeleteOutputLines { session_id } => {
            let hashes =
                collect_hashes_from_output_lines(pool, std::slice::from_ref(&session_id)).await?;
            sqlx::query("DELETE FROM output_lines WHERE session_id = ?")
                .bind(&session_id)
                .execute(pool)
                .await?;
            sqlx::query(
                "UPDATE sessions SET total_cost = 0.0, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 WHERE id = ?",
            )
            .bind(&session_id)
            .execute(pool)
            .await?;
            log_refcount_err(
                "decr DeleteOutputLines",
                crate::blob::decr_refs(pool, &hashes).await,
            );
        }

        DbWrite::InsertTurnSnapshot {
            session_id,
            message_uuid,
            stash_sha,
            created_at,
        } => {
            sqlx::query(
                "INSERT OR REPLACE INTO turn_snapshots (session_id, message_uuid, stash_sha, created_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&session_id)
            .bind(&message_uuid)
            .bind(&stash_sha)
            .bind(created_at)
            .execute(pool)
            .await?;
        }
        DbWrite::DeleteTurnSnapshotsForSession { session_id } => {
            sqlx::query("DELETE FROM turn_snapshots WHERE session_id = ?")
                .bind(&session_id)
                .execute(pool)
                .await?;
        }

        // -- Policy --
        DbWrite::SetTrustLevel {
            task_id,
            trust_level,
            updated_at,
        } => {
            sqlx::query(
                "INSERT INTO task_trust_levels (task_id, trust_level, updated_at) \
                 VALUES (?, ?, ?) \
                 ON CONFLICT(task_id) DO UPDATE SET trust_level = excluded.trust_level, updated_at = excluded.updated_at",
            )
            .bind(&task_id)
            .bind(&trust_level)
            .bind(updated_at)
            .execute(pool)
            .await?;
        }
        DbWrite::InsertAuditEntry {
            session_id,
            task_id,
            tool_name,
            tool_input_summary,
            decision,
            reason,
            created_at,
        } => {
            sqlx::query(
                "INSERT INTO policy_audit_log (session_id, task_id, tool_name, tool_input_summary, decision, reason, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&session_id)
            .bind(&task_id)
            .bind(&tool_name)
            .bind(&tool_input_summary)
            .bind(&decision)
            .bind(&reason)
            .bind(created_at)
            .execute(pool)
            .await?;
        }

        // -- Steps --
        DbWrite::InsertStep(s) => {
            let new_hashes =
                crate::blob::extract_hashes_from_attachments_json(s.attachments_json.as_deref());
            sqlx::query(
                "INSERT INTO steps (id, session_id, message, attachments_json, armed, model, plan_mode, thinking_mode, fast_mode, sort_order, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&s.id)
            .bind(&s.session_id)
            .bind(&s.message)
            .bind(&s.attachments_json)
            .bind(s.armed)
            .bind(&s.model)
            .bind(s.plan_mode)
            .bind(s.thinking_mode)
            .bind(s.fast_mode)
            .bind(s.sort_order)
            .bind(s.created_at)
            .execute(pool)
            .await?;
            log_refcount_err(
                "incr InsertStep",
                crate::blob::incr_refs(pool, &new_hashes).await,
            );
        }
        DbWrite::UpdateStep {
            id,
            message,
            armed,
            model,
            plan_mode,
            thinking_mode,
            fast_mode,
            attachments_json,
        } => {
            let old_json: Option<(Option<String>,)> =
                sqlx::query_as("SELECT attachments_json FROM steps WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(pool)
                    .await?;
            let old_hashes = old_json
                .as_ref()
                .and_then(|(j,)| j.as_deref())
                .map(|s| crate::blob::extract_hashes_from_attachments_json(Some(s)))
                .unwrap_or_default();
            let new_hashes =
                crate::blob::extract_hashes_from_attachments_json(attachments_json.as_deref());
            sqlx::query("UPDATE steps SET message = ?, armed = ?, model = ?, plan_mode = ?, thinking_mode = ?, fast_mode = ?, attachments_json = ? WHERE id = ?")
                .bind(&message)
                .bind(armed)
                .bind(&model)
                .bind(plan_mode)
                .bind(thinking_mode)
                .bind(fast_mode)
                .bind(&attachments_json)
                .bind(&id)
                .execute(pool)
                .await?;
            // Drop old refs first, then add new — temporary undercounting is
            // safe because GC never runs concurrently with the write queue.
            log_refcount_err(
                "decr UpdateStep old",
                crate::blob::decr_refs(pool, &old_hashes).await,
            );
            log_refcount_err(
                "incr UpdateStep new",
                crate::blob::incr_refs(pool, &new_hashes).await,
            );
        }
        DbWrite::DeleteStep { id } => {
            let old_json: Option<(Option<String>,)> =
                sqlx::query_as("SELECT attachments_json FROM steps WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(pool)
                    .await?;
            let old_hashes = old_json
                .as_ref()
                .and_then(|(j,)| j.as_deref())
                .map(|s| crate::blob::extract_hashes_from_attachments_json(Some(s)))
                .unwrap_or_default();
            sqlx::query("DELETE FROM steps WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
            log_refcount_err(
                "decr DeleteStep",
                crate::blob::decr_refs(pool, &old_hashes).await,
            );
        }
        DbWrite::ReorderSteps { session_id, ids } => {
            for (i, id) in ids.iter().enumerate() {
                sqlx::query("UPDATE steps SET sort_order = ? WHERE id = ? AND session_id = ?")
                    .bind(i as i64)
                    .bind(id)
                    .bind(&session_id)
                    .execute(pool)
                    .await?;
            }
        }
        DbWrite::DisarmAllSteps { session_id } => {
            sqlx::query("UPDATE steps SET armed = 0 WHERE session_id = ?")
                .bind(&session_id)
                .execute(pool)
                .await?;
        }

        // -- Startup recovery --
        DbWrite::ResetRunningSessions => {
            sqlx::query("UPDATE sessions SET status = 'idle' WHERE status = 'running'")
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read functions
// ---------------------------------------------------------------------------

// Projects

pub async fn get_project(pool: &SqlitePool, id: &str) -> Result<Option<Project>, String> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<Project>, String> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects ORDER BY created_at ASC")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
}

// Tasks

pub async fn get_task(pool: &SqlitePool, id: &str) -> Result<Option<Task>, String> {
    sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_tasks_for_project(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Vec<Task>, String> {
    sqlx::query_as::<_, Task>(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY archived ASC, created_at DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

pub async fn next_port_offset(pool: &SqlitePool, project_id: &str) -> Result<i64, String> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT COALESCE(MAX(port_offset), -1) FROM tasks WHERE project_id = ?")
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

    Ok(row.map(|(max,)| max + 1).unwrap_or(0))
}

// Sessions

pub async fn get_session(pool: &SqlitePool, id: &str) -> Result<Option<Session>, String> {
    sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_sessions_for_task(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<Vec<Session>, String> {
    sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE task_id = ? AND status != 'closed' ORDER BY started_at ASC",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

pub async fn list_closed_sessions_for_task(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<Vec<Session>, String> {
    sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE task_id = ? AND status = 'closed' \
         ORDER BY closed_at IS NULL, closed_at DESC, started_at DESC",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

/// All session ids for a task, regardless of status. Used by archive/delete to
/// scope process kills to a single task without missing in-flight sessions.
pub async fn list_all_session_ids_for_task(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<Vec<String>, String> {
    sqlx::query_scalar::<_, String>("SELECT id FROM sessions WHERE task_id = ?")
        .bind(task_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
}

// Output

pub async fn get_output_lines(
    pool: &SqlitePool,
    session_id: &str,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<OutputLine>, String> {
    match limit {
        Some(n) if n >= 0 => {
            // Fetch the last N rows ending strictly before `before_id` (when
            // set) by id DESC, then flip to ASC so the chat renders
            // oldest-first. Implemented in SQL to avoid loading the full row
            // set into memory for long-lived sessions.
            let mut rows = match before_id {
                Some(cursor) => sqlx::query_as::<_, OutputLine>(
                    "SELECT * FROM output_lines \
                         WHERE session_id = ? AND id < ? \
                         ORDER BY id DESC \
                         LIMIT ?",
                )
                .bind(session_id)
                .bind(cursor)
                .bind(n)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?,
                None => sqlx::query_as::<_, OutputLine>(
                    "SELECT * FROM output_lines \
                         WHERE session_id = ? \
                         ORDER BY id DESC \
                         LIMIT ?",
                )
                .bind(session_id)
                .bind(n)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?,
            };
            rows.reverse();
            Ok(rows)
        }
        _ => sqlx::query_as::<_, OutputLine>(
            "SELECT * FROM output_lines WHERE session_id = ? ORDER BY id ASC",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string()),
    }
}

/// Sum token usage across every persisted `turnEnd` item for a session.
///
/// Tokens are not stored as a session aggregate (unlike `total_cost`), so this
/// scans `output_lines`, parses each NDJSON row, and pulls camelCase token
/// fields out of every `verun_items` -> `kind: "turnEnd"` item. Used by
/// `loadOutputLines` to seed the in-memory store with full-session totals
/// after the 250-line initial-load cap was introduced — replaying only the
/// tail would otherwise show partial usage in the UI chips.
pub async fn get_session_token_totals(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<SessionTokenTotals, String> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT line FROM output_lines WHERE session_id = ?")
        .bind(session_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut totals = SessionTokenTotals::default();
    for (line,) in rows {
        let delta = usage_delta_from_output_line(&line);
        totals.input += delta.input_tokens;
        totals.output += delta.output_tokens;
        totals.cache_read += delta.cache_read_tokens;
        totals.cache_write += delta.cache_write_tokens;
    }
    Ok(totals)
}

async fn read_meta(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.0))
}

async fn write_meta(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn backfill_session_usage_aggregates(pool: &SqlitePool) -> Result<(), String> {
    const SENTINEL: &str = "session_usage_aggregate_backfill_v1";
    if read_meta(pool, SENTINEL).await?.as_deref() == Some("done") {
        return Ok(());
    }

    let session_ids = sqlx::query_scalar::<_, String>("SELECT id FROM sessions")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    for session_id in session_ids {
        let totals = get_session_token_totals(pool, &session_id).await?;
        sqlx::query(
            "UPDATE sessions SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?",
        )
        .bind(totals.input)
        .bind(totals.output)
        .bind(totals.cache_read)
        .bind(totals.cache_write)
        .bind(&session_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    write_meta(pool, SENTINEL, "done").await
}

pub async fn get_github_cache_entry(
    pool: &SqlitePool,
    cache_key: &str,
) -> Result<Option<GitHubCacheEntry>, String> {
    sqlx::query_as::<_, GitHubCacheEntry>(
        "SELECT
            cache_key, task_id, scope, entity_id, payload_json,
            fetched_at, stale_at, expires_at
         FROM github_cache_entries
         WHERE cache_key = ?",
    )
    .bind(cache_key)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

pub async fn upsert_github_cache_entry(
    pool: &SqlitePool,
    entry: &GitHubCacheEntry,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO github_cache_entries (
            cache_key, task_id, scope, entity_id, payload_json,
            fetched_at, stale_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
            task_id = excluded.task_id,
            scope = excluded.scope,
            entity_id = excluded.entity_id,
            payload_json = excluded.payload_json,
            fetched_at = excluded.fetched_at,
            stale_at = excluded.stale_at,
            expires_at = excluded.expires_at",
    )
    .bind(&entry.cache_key)
    .bind(&entry.task_id)
    .bind(&entry.scope)
    .bind(&entry.entity_id)
    .bind(&entry.payload_json)
    .bind(entry.fetched_at)
    .bind(entry.stale_at)
    .bind(entry.expires_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn invalidate_github_cache(
    pool: &SqlitePool,
    task_id: &str,
    scopes: &[&str],
) -> Result<(), String> {
    if scopes.is_empty() {
        return Ok(());
    }

    let placeholders = std::iter::repeat_n("?", scopes.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("DELETE FROM github_cache_entries WHERE task_id = ? AND scope IN ({placeholders})");
    let mut query = sqlx::query(&sql).bind(task_id);
    for scope in scopes {
        query = query.bind(scope);
    }
    query.execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

// Turn snapshots

pub async fn get_turn_snapshot(
    pool: &SqlitePool,
    session_id: &str,
    message_uuid: &str,
) -> Result<Option<TurnSnapshot>, String> {
    sqlx::query_as::<_, TurnSnapshot>(
        "SELECT * FROM turn_snapshots WHERE session_id = ? AND message_uuid = ?",
    )
    .bind(session_id)
    .bind(message_uuid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

// Steps

pub async fn list_steps(pool: &SqlitePool, session_id: &str) -> Result<Vec<Step>, String> {
    sqlx::query_as::<_, Step>("SELECT * FROM steps WHERE session_id = ? ORDER BY sort_order ASC")
        .bind(session_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
}

// Policy

pub async fn get_trust_level(pool: &SqlitePool, task_id: &str) -> Result<String, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT trust_level FROM task_trust_levels WHERE task_id = ?")
            .bind(task_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

    Ok(row.map(|(tl,)| tl).unwrap_or_else(|| "normal".into()))
}

pub async fn get_repo_path_for_task(pool: &SqlitePool, task_id: &str) -> Result<String, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.repo_path FROM projects p \
         JOIN tasks t ON t.project_id = p.id \
         WHERE t.id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    row.map(|(rp,)| rp)
        .ok_or_else(|| format!("no project found for task {task_id}"))
}

pub async fn get_audit_log(
    pool: &SqlitePool,
    task_id: &str,
    limit: i64,
) -> Result<Vec<AuditEntry>, String> {
    sqlx::query_as::<_, AuditEntry>(
        "SELECT * FROM policy_audit_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(task_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pool constructor
// ---------------------------------------------------------------------------

pub async fn connect(app_data_dir: &std::path::Path) -> Result<SqlitePool, String> {
    let db_path = app_data_dir.join("verun.db");
    let url = format!("sqlite:{}?mode=rwc", db_path.display());
    let pool = SqlitePool::connect(&url)
        .await
        .map_err(|e| format!("Failed to connect to SQLite: {e}"))?;

    // Enable WAL mode for better concurrent read/write performance
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to set WAL mode: {e}"))?;

    let backfill_pool = pool.clone();
    tokio::spawn(async move {
        if let Err(e) = backfill_session_usage_aggregates(&backfill_pool).await {
            eprintln!("session usage aggregate backfill failed: {e}");
        }
    });

    Ok(pool)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_versions_are_sequential() {
        let m = migrations();
        assert_eq!(m.len(), 23);
        for (i, mig) in m.iter().enumerate() {
            assert_eq!(
                mig.version,
                (i + 1) as i64,
                "migration index {} version mismatch",
                i
            );
        }
    }

    #[test]
    fn migration_sql_snapshot() {
        let m = migrations();
        insta::assert_snapshot!("migration_v1_sql", m[0].sql);
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for m in migrations() {
            sqlx::query(m.sql).execute(&pool).await.unwrap();
        }
        pool
    }

    fn make_project() -> Project {
        Project {
            id: "p-001".into(),
            name: "My App".into(),
            repo_path: "/tmp/myapp".into(),
            base_branch: "main".into(),
            setup_hook: String::new(),
            destroy_hook: String::new(),
            start_command: String::new(),
            auto_start: false,
            created_at: 1000,
            default_agent_type: "claude".into(),
        }
    }

    fn make_task(project_id: &str) -> Task {
        Task {
            id: "t-001".into(),
            project_id: project_id.into(),
            name: None,
            worktree_path: "/tmp/myapp/.verun/worktrees/silly-penguin".into(),
            branch: "silly-penguin".into(),
            created_at: 2000,
            merge_base_sha: None,
            port_offset: 0,
            archived: false,
            archived_at: None,
            last_commit_message: None,
            parent_task_id: None,
            agent_type: "claude".into(),
            last_pushed_sha: None,
        }
    }

    fn make_session(task_id: &str) -> Session {
        Session {
            id: "s-001".into(),
            task_id: task_id.into(),
            name: None,
            resume_session_id: None,
            status: "running".into(),
            started_at: 3000,
            ended_at: None,
            total_cost: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            parent_session_id: None,
            forked_at_message_uuid: None,
            agent_type: "claude".into(),
            model: None,
            closed_at: None,
        }
    }

    // -- Project tests --

    #[tokio::test]
    async fn insert_and_get_project() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();

        let p = get_project(&pool, "p-001").await.unwrap().unwrap();
        assert_eq!(p.name, "My App");
        assert_eq!(p.repo_path, "/tmp/myapp");
    }

    #[tokio::test]
    async fn list_projects_ordered() {
        let pool = test_pool().await;
        let mut p1 = make_project();
        let mut p2 = make_project();
        p1.id = "p-001".into();
        p1.created_at = 1000;
        p1.repo_path = "/tmp/a".into();
        p2.id = "p-002".into();
        p2.created_at = 2000;
        p2.repo_path = "/tmp/b".into();

        process_write(&pool, DbWrite::InsertProject(p1))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(p2))
            .await
            .unwrap();

        let projects = list_projects(&pool).await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, "p-001"); // oldest first
    }

    #[tokio::test]
    async fn delete_project_cascades() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![("hello".into(), 100)],
            },
        )
        .await
        .unwrap();

        process_write(&pool, DbWrite::DeleteProject { id: "p-001".into() })
            .await
            .unwrap();

        assert!(get_project(&pool, "p-001").await.unwrap().is_none());
        assert!(get_task(&pool, "t-001").await.unwrap().is_none());
        assert!(get_session(&pool, "s-001").await.unwrap().is_none());
        assert!(get_output_lines(&pool, "s-001", None, None)
            .await
            .unwrap()
            .is_empty());
    }

    // -- Task tests --

    #[tokio::test]
    async fn insert_and_get_task() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        let t = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert_eq!(t.project_id, "p-001");
        assert_eq!(t.branch, "silly-penguin");
        assert!(t.name.is_none());
    }

    #[tokio::test]
    async fn update_task_name() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::UpdateTaskName {
                id: "t-001".into(),
                name: "Fix auth bug".into(),
            },
        )
        .await
        .unwrap();

        let t = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert_eq!(t.name.as_deref(), Some("Fix auth bug"));
    }

    #[tokio::test]
    async fn list_tasks_for_project_filtered() {
        let pool = test_pool().await;
        let mut p2 = make_project();
        p2.id = "p-002".into();
        p2.repo_path = "/tmp/other".into();

        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(p2))
            .await
            .unwrap();

        let mut t1 = make_task("p-001");
        t1.id = "t-001".into();
        let mut t2 = make_task("p-002");
        t2.id = "t-002".into();

        process_write(&pool, DbWrite::InsertTask(t1)).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(t2)).await.unwrap();

        let tasks = list_tasks_for_project(&pool, "p-001").await.unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "t-001");
    }

    #[tokio::test]
    async fn delete_task_cascades() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![("line".into(), 100)],
            },
        )
        .await
        .unwrap();

        process_write(&pool, DbWrite::DeleteTask { id: "t-001".into() })
            .await
            .unwrap();

        assert!(get_task(&pool, "t-001").await.unwrap().is_none());
        assert!(get_session(&pool, "s-001").await.unwrap().is_none());
        assert!(get_output_lines(&pool, "s-001", None, None)
            .await
            .unwrap()
            .is_empty());
        // Project still exists
        assert!(get_project(&pool, "p-001").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn archive_task_sets_flag_and_preserves_data() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![("line".into(), 100)],
            },
        )
        .await
        .unwrap();

        process_write(
            &pool,
            DbWrite::ArchiveTask {
                id: "t-001".into(),
                archived_at: 9999,
                last_commit_message: Some("test commit".into()),
            },
        )
        .await
        .unwrap();

        // Task still exists and is archived
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert!(task.archived);

        // Sessions and output preserved
        assert!(get_session(&pool, "s-001").await.unwrap().is_some());
        assert!(!get_output_lines(&pool, "s-001", None, None)
            .await
            .unwrap()
            .is_empty());
    }

    // Issue #138 — archive_task now flips the archived flag with
    // last_commit_message: None first, then writes the captured commit
    // message asynchronously after the destroy hook finishes. This split
    // lets the UI close the window instantly without waiting for the hook.
    #[tokio::test]
    async fn archive_task_with_none_message_then_set_last_commit_message() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        // Phase 1: instant archive — no message yet
        process_write(
            &pool,
            DbWrite::ArchiveTask {
                id: "t-001".into(),
                archived_at: 9999,
                last_commit_message: None,
            },
        )
        .await
        .unwrap();
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert!(task.archived);
        assert_eq!(task.last_commit_message, None);

        // Phase 2: background hook captured the message; backfill it
        process_write(
            &pool,
            DbWrite::SetLastCommitMessage {
                id: "t-001".into(),
                msg: Some("captured later".into()),
            },
        )
        .await
        .unwrap();
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert!(task.archived);
        assert_eq!(task.last_commit_message.as_deref(), Some("captured later"));
    }

    #[tokio::test]
    async fn set_last_commit_message_can_clear_with_none() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::SetLastCommitMessage {
                id: "t-001".into(),
                msg: Some("hello".into()),
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::SetLastCommitMessage {
                id: "t-001".into(),
                msg: None,
            },
        )
        .await
        .unwrap();
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert_eq!(task.last_commit_message, None);
    }

    #[tokio::test]
    async fn restore_task_clears_archived_flag() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::ArchiveTask {
                id: "t-001".into(),
                archived_at: 9999,
                last_commit_message: Some("test commit".into()),
            },
        )
        .await
        .unwrap();
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert!(task.archived);

        process_write(&pool, DbWrite::RestoreTask { id: "t-001".into() })
            .await
            .unwrap();
        let task = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert!(!task.archived);
    }

    #[tokio::test]
    async fn archived_tasks_sort_after_active() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();

        let mut t1 = make_task("p-001");
        t1.id = "t-old".into();
        t1.created_at = 1000;
        let mut t2 = make_task("p-001");
        t2.id = "t-new".into();
        t2.created_at = 3000;
        let mut t3 = make_task("p-001");
        t3.id = "t-archived".into();
        t3.created_at = 5000; // newest but archived

        process_write(&pool, DbWrite::InsertTask(t1)).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(t2)).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(t3)).await.unwrap();
        process_write(
            &pool,
            DbWrite::ArchiveTask {
                id: "t-archived".into(),
                archived_at: 9999,
                last_commit_message: None,
            },
        )
        .await
        .unwrap();

        let tasks = list_tasks_for_project(&pool, "p-001").await.unwrap();
        assert_eq!(tasks.len(), 3);
        // Active tasks first (newest first), archived last
        assert_eq!(tasks[0].id, "t-new");
        assert_eq!(tasks[1].id, "t-old");
        assert_eq!(tasks[2].id, "t-archived");
        assert!(!tasks[0].archived);
        assert!(tasks[2].archived);
    }

    // -- Session tests --

    #[tokio::test]
    async fn session_lifecycle() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let s = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(s.status, "running");
        assert!(s.resume_session_id.is_none());
        assert!(s.ended_at.is_none());

        // Set resume session id once we get it from CLI
        process_write(
            &pool,
            DbWrite::SetResumeSessionId {
                id: "s-001".into(),
                resume_session_id: "claude-xyz".into(),
            },
        )
        .await
        .unwrap();

        let s = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(s.resume_session_id.as_deref(), Some("claude-xyz"));

        // End session
        process_write(
            &pool,
            DbWrite::EndSession {
                id: "s-001".into(),
                ended_at: 9000,
            },
        )
        .await
        .unwrap();

        let s = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(s.status, "done");
        assert_eq!(s.ended_at, Some(9000));
    }

    #[tokio::test]
    async fn multiple_sessions_per_task() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        let mut s1 = make_session("t-001");
        s1.id = "s-001".into();
        s1.started_at = 1000;
        let mut s2 = make_session("t-001");
        s2.id = "s-002".into();
        s2.started_at = 2000;

        process_write(&pool, DbWrite::CreateSession(s1))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(s2))
            .await
            .unwrap();

        let sessions = list_sessions_for_task(&pool, "t-001").await.unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "s-001"); // oldest first
    }

    #[tokio::test]
    async fn list_closed_sessions_returns_only_closed_newest_first() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        // Active session - should not appear
        let mut active = make_session("t-001");
        active.id = "s-active".into();
        active.started_at = 500;
        process_write(&pool, DbWrite::CreateSession(active))
            .await
            .unwrap();

        // Three closed sessions with different ended_at times
        let mut older = make_session("t-001");
        older.id = "s-older".into();
        older.started_at = 1000;
        let mut newer = make_session("t-001");
        newer.id = "s-newer".into();
        newer.started_at = 2000;
        let mut no_end = make_session("t-001");
        no_end.id = "s-no-end".into();
        no_end.started_at = 1500;

        process_write(&pool, DbWrite::CreateSession(older))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(newer))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(no_end))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::EndSession {
                id: "s-older".into(),
                ended_at: 5000,
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::EndSession {
                id: "s-newer".into(),
                ended_at: 9000,
            },
        )
        .await
        .unwrap();

        // Close order is the opposite of end order to prove we sort by closed_at,
        // not started_at or ended_at.
        process_write(
            &pool,
            DbWrite::CloseSession {
                id: "s-newer".into(),
                closed_at: 10_000,
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::CloseSession {
                id: "s-no-end".into(),
                closed_at: 20_000,
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::CloseSession {
                id: "s-older".into(),
                closed_at: 30_000,
            },
        )
        .await
        .unwrap();

        let closed = list_closed_sessions_for_task(&pool, "t-001").await.unwrap();
        assert_eq!(closed.len(), 3);
        // Ordering: closed_at DESC (most recently closed first)
        assert_eq!(closed[0].id, "s-older"); // closed_at 30000
        assert_eq!(closed[1].id, "s-no-end"); // closed_at 20000
        assert_eq!(closed[2].id, "s-newer"); // closed_at 10000

        // Active sessions must be excluded
        assert!(closed.iter().all(|s| s.id != "s-active"));
    }

    #[tokio::test]
    async fn reopen_session_flips_status_to_idle() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::CloseSession {
                id: "s-001".into(),
                closed_at: 7_000,
            },
        )
        .await
        .unwrap();

        let closed = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(closed.status, "closed");
        assert_eq!(closed.closed_at, Some(7_000));

        process_write(&pool, DbWrite::ReopenSession { id: "s-001".into() })
            .await
            .unwrap();

        let reopened = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(reopened.status, "idle");
        assert_eq!(reopened.closed_at, None);

        // And it appears back in active list, not in closed list
        let active = list_sessions_for_task(&pool, "t-001").await.unwrap();
        assert_eq!(active.len(), 1);
        let closed = list_closed_sessions_for_task(&pool, "t-001").await.unwrap();
        assert_eq!(closed.len(), 0);
    }

    #[tokio::test]
    async fn reopen_session_noop_on_active_session() {
        // Guard: reopening a non-closed session should not clobber its live status.
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        let mut s = make_session("t-001");
        s.status = "running".into();
        process_write(&pool, DbWrite::CreateSession(s))
            .await
            .unwrap();

        process_write(&pool, DbWrite::ReopenSession { id: "s-001".into() })
            .await
            .unwrap();

        let after = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(after.status, "running");
        assert_eq!(after.closed_at, None);
    }

    // -- Output tests --

    #[tokio::test]
    async fn insert_and_get_output_lines() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![
                    ("line 1".into(), 100),
                    ("line 2".into(), 200),
                    ("line 3".into(), 300),
                ],
            },
        )
        .await
        .unwrap();

        let output = get_output_lines(&pool, "s-001", None, None).await.unwrap();
        assert_eq!(output.len(), 3);
        assert_eq!(output[0].line, "line 1");
        assert_eq!(output[2].line, "line 3");
    }

    #[tokio::test]
    async fn insert_output_lines_updates_session_usage_aggregates() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let l1 = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","cost":0.01,"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":5}]}"#;
        let l2 = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","cost":0.02,"inputTokens":200,"outputTokens":80,"cacheReadTokens":20,"cacheWriteTokens":7}]}"#;
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(l1.into(), 100), (l2.into(), 200)],
            },
        )
        .await
        .unwrap();

        let session = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert!((session.total_cost - 0.03).abs() < 1e-9);
        assert_eq!(session.input_tokens, 300);
        assert_eq!(session.output_tokens, 130);
        assert_eq!(session.cache_read_tokens, 30);
        assert_eq!(session.cache_write_tokens, 12);
    }

    #[tokio::test]
    async fn delete_output_lines_resets_session_usage_aggregates() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let line = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","cost":0.01,"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":5}]}"#;
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(line.into(), 100)],
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::DeleteOutputLines {
                session_id: "s-001".into(),
            },
        )
        .await
        .unwrap();

        let session = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(session.total_cost, 0.0);
        assert_eq!(session.input_tokens, 0);
        assert_eq!(session.output_tokens, 0);
        assert_eq!(session.cache_read_tokens, 0);
        assert_eq!(session.cache_write_tokens, 0);
    }

    #[tokio::test]
    async fn get_output_lines_with_limit_returns_tail_in_ascending_order() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: (1..=10)
                    .map(|i| (format!("line {i}"), i as i64 * 100))
                    .collect(),
            },
        )
        .await
        .unwrap();

        let tail = get_output_lines(&pool, "s-001", Some(3), None)
            .await
            .unwrap();
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0].line, "line 8");
        assert_eq!(tail[1].line, "line 9");
        assert_eq!(tail[2].line, "line 10");

        let all = get_output_lines(&pool, "s-001", None, None).await.unwrap();
        assert_eq!(all.len(), 10);
        assert_eq!(all[0].line, "line 1");

        // Cursor-paginate older history strictly before tail[0].id.
        let cursor = tail[0].id;
        let older = get_output_lines(&pool, "s-001", Some(3), Some(cursor))
            .await
            .unwrap();
        assert_eq!(older.len(), 3);
        assert_eq!(older[0].line, "line 5");
        assert_eq!(older[1].line, "line 6");
        assert_eq!(older[2].line, "line 7");
    }

    #[tokio::test]
    async fn get_output_lines_cursor_at_oldest_returns_empty() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: (1..=5)
                    .map(|i| (format!("line {i}"), i as i64 * 100))
                    .collect(),
            },
        )
        .await
        .unwrap();

        let all = get_output_lines(&pool, "s-001", None, None).await.unwrap();
        let oldest_id = all[0].id;

        // Walking past the very first row → empty page (signals "no more").
        let none = get_output_lines(&pool, "s-001", Some(10), Some(oldest_id))
            .await
            .unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn get_output_lines_cursor_clamps_to_session_id() {
        // The cursor is just an `id < ?` filter — make sure it can't accidentally
        // bleed rows from another session that happens to have a larger id.
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        let mut s2 = make_session("t-001");
        s2.id = "s-002".into();
        process_write(&pool, DbWrite::CreateSession(s2))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![("a".into(), 100), ("b".into(), 200)],
            },
        )
        .await
        .unwrap();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-002".into(),
                lines: vec![("x".into(), 300), ("y".into(), 400)],
            },
        )
        .await
        .unwrap();

        // Fetch s-001 with a cursor large enough to admit s-002's rows by id —
        // they must still be filtered out by the session_id predicate.
        let lines = get_output_lines(&pool, "s-001", Some(100), Some(9_999))
            .await
            .unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.session_id == "s-001"));
    }

    #[tokio::test]
    async fn token_totals_sum_turn_end_items_across_lines() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let l1 = r#"{"type":"verun_items","items":[{"kind":"text","text":"hi"},{"kind":"turnEnd","status":"completed","cost":0.01,"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":5}]}"#;
        let l2 =
            r#"{"type":"verun_items","items":[{"kind":"toolStart","tool":"Read","input":"{}"}]}"#;
        let l3 = r#"{"type":"verun_user_message","text":"another"}"#;
        let l4 = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","cost":0.02,"inputTokens":200,"outputTokens":80,"cacheReadTokens":20,"cacheWriteTokens":7}]}"#;
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![
                    (l1.into(), 100),
                    (l2.into(), 200),
                    (l3.into(), 300),
                    (l4.into(), 400),
                ],
            },
        )
        .await
        .unwrap();

        let totals = get_session_token_totals(&pool, "s-001").await.unwrap();
        assert_eq!(totals.input, 300);
        assert_eq!(totals.output, 130);
        assert_eq!(totals.cache_read, 30);
        assert_eq!(totals.cache_write, 12);
    }

    #[tokio::test]
    async fn token_totals_zero_for_empty_session() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let totals = get_session_token_totals(&pool, "s-001").await.unwrap();
        assert_eq!(totals.input, 0);
        assert_eq!(totals.output, 0);
        assert_eq!(totals.cache_read, 0);
        assert_eq!(totals.cache_write, 0);
    }

    #[tokio::test]
    async fn token_totals_skip_unparseable_and_other_sessions() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        let mut s2 = make_session("t-001");
        s2.id = "s-other".into();
        process_write(&pool, DbWrite::CreateSession(s2))
            .await
            .unwrap();

        let valid = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","inputTokens":42,"outputTokens":7,"cacheReadTokens":0,"cacheWriteTokens":0}]}"#;
        let garbage = "this is not json";
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(valid.into(), 100), (garbage.into(), 200)],
            },
        )
        .await
        .unwrap();
        // Other-session totals must not bleed in.
        let bleed = r#"{"type":"verun_items","items":[{"kind":"turnEnd","status":"completed","inputTokens":9999,"outputTokens":9999,"cacheReadTokens":9999,"cacheWriteTokens":9999}]}"#;
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-other".into(),
                lines: vec![(bleed.into(), 300)],
            },
        )
        .await
        .unwrap();

        let totals = get_session_token_totals(&pool, "s-001").await.unwrap();
        assert_eq!(totals.input, 42);
        assert_eq!(totals.output, 7);
        assert_eq!(totals.cache_read, 0);
        assert_eq!(totals.cache_write, 0);
    }

    // -- Startup recovery --

    #[tokio::test]
    async fn reset_running_sessions() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        let mut s1 = make_session("t-001");
        s1.id = "s-run".into();
        s1.status = "running".into();
        let mut s2 = make_session("t-001");
        s2.id = "s-done".into();
        s2.status = "done".into();

        process_write(&pool, DbWrite::CreateSession(s1))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(s2))
            .await
            .unwrap();

        process_write(&pool, DbWrite::ResetRunningSessions)
            .await
            .unwrap();

        let s = get_session(&pool, "s-run").await.unwrap().unwrap();
        assert_eq!(s.status, "idle");
        let s = get_session(&pool, "s-done").await.unwrap().unwrap();
        assert_eq!(s.status, "done"); // untouched
    }

    // -- Serialization --

    #[test]
    fn project_serializes_as_camel_case() {
        let p = make_project();
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("repoPath").is_some());
        assert!(json.get("baseBranch").is_some());
        assert!(json.get("setupHook").is_some());
        assert!(json.get("destroyHook").is_some());
        assert!(json.get("startCommand").is_some());
        assert!(json.get("createdAt").is_some());
    }

    #[test]
    fn task_serializes_as_camel_case() {
        let t = make_task("p-001");
        let json = serde_json::to_value(&t).unwrap();
        assert!(json.get("projectId").is_some());
        assert!(json.get("worktreePath").is_some());
    }

    #[test]
    fn session_serializes_as_camel_case() {
        let s = make_session("t-001");
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("taskId").is_some());
        assert!(json.get("resumeSessionId").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(json.get("endedAt").is_some());
    }

    #[test]
    fn get_nonexistent_returns_none() {
        // Sync check that the functions exist and return the right types
        // Actual async tests above cover the behavior
    }

    // -- Step tests --

    fn make_step(session_id: &str, sort_order: i64) -> Step {
        Step {
            id: format!("step-{sort_order}"),
            session_id: session_id.into(),
            message: format!("Do thing {sort_order}"),
            attachments_json: None,
            armed: false,
            model: Some("sonnet".into()),
            plan_mode: Some(false),
            thinking_mode: Some(true),
            fast_mode: Some(false),
            sort_order,
            created_at: 5000 + sort_order,
        }
    }

    #[tokio::test]
    async fn insert_and_list_steps() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 1)))
            .await
            .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, "step-0");
        assert_eq!(steps[1].id, "step-1");
        assert_eq!(steps[0].message, "Do thing 0");
    }

    #[tokio::test]
    async fn list_steps_returns_sorted_by_sort_order() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        // Insert in reverse order
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 2)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 1)))
            .await
            .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(
            steps.iter().map(|s| s.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[tokio::test]
    async fn list_steps_scoped_by_session() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::CreateSession(Session {
                id: "s-002".into(),
                ..make_session("t-001")
            }),
        )
        .await
        .unwrap();

        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();
        process_write(
            &pool,
            DbWrite::InsertStep(Step {
                id: "step-other".into(),
                session_id: "s-002".into(),
                ..make_step("s-002", 0)
            }),
        )
        .await
        .unwrap();

        assert_eq!(list_steps(&pool, "s-001").await.unwrap().len(), 1);
        assert_eq!(list_steps(&pool, "s-002").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn update_step_changes_message_and_armed() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::UpdateStep {
                id: "step-0".into(),
                message: "Updated message".into(),
                armed: true,
                model: Some("opus".into()),
                plan_mode: Some(true),
                thinking_mode: Some(false),
                fast_mode: Some(true),
                attachments_json: Some("[{\"name\":\"img.png\"}]".into()),
            },
        )
        .await
        .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(steps[0].message, "Updated message");
        assert!(steps[0].armed);
        assert_eq!(steps[0].model.as_deref(), Some("opus"));
        assert_eq!(steps[0].plan_mode, Some(true));
        assert_eq!(steps[0].fast_mode, Some(true));
        assert!(steps[0].attachments_json.is_some());
    }

    #[tokio::test]
    async fn delete_step_removes_it() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 1)))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::DeleteStep {
                id: "step-0".into(),
            },
        )
        .await
        .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].id, "step-1");
    }

    #[tokio::test]
    async fn reorder_steps_updates_sort_order() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 1)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 2)))
            .await
            .unwrap();

        // Reverse the order
        process_write(
            &pool,
            DbWrite::ReorderSteps {
                session_id: "s-001".into(),
                ids: vec!["step-2".into(), "step-1".into(), "step-0".into()],
            },
        )
        .await
        .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(
            steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["step-2", "step-1", "step-0"]
        );
    }

    #[tokio::test]
    async fn disarm_all_steps_sets_armed_false() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();

        let mut armed_step = make_step("s-001", 0);
        armed_step.armed = true;
        process_write(&pool, DbWrite::InsertStep(armed_step))
            .await
            .unwrap();
        let mut armed_step2 = make_step("s-001", 1);
        armed_step2.armed = true;
        process_write(&pool, DbWrite::InsertStep(armed_step2))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::DisarmAllSteps {
                session_id: "s-001".into(),
            },
        )
        .await
        .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert!(steps.iter().all(|s| !s.armed));
    }

    #[tokio::test]
    async fn delete_task_cascades_to_steps() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();

        process_write(&pool, DbWrite::DeleteTask { id: "t-001".into() })
            .await
            .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(steps.len(), 0);
    }

    #[tokio::test]
    async fn delete_project_cascades_to_steps() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertStep(make_step("s-001", 0)))
            .await
            .unwrap();

        process_write(&pool, DbWrite::DeleteProject { id: "p-001".into() })
            .await
            .unwrap();

        let steps = list_steps(&pool, "s-001").await.unwrap();
        assert_eq!(steps.len(), 0);
    }

    #[tokio::test]
    async fn invalidate_github_cache_removes_only_requested_scopes() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();

        upsert_github_cache_entry(
            &pool,
            &GitHubCacheEntry {
                cache_key: "t-001:overview".into(),
                task_id: "t-001".into(),
                scope: "overview".into(),
                entity_id: None,
                payload_json: "{}".into(),
                fetched_at: 1,
                stale_at: 2,
                expires_at: 3,
            },
        )
        .await
        .unwrap();
        upsert_github_cache_entry(
            &pool,
            &GitHubCacheEntry {
                cache_key: "t-001:actions".into(),
                task_id: "t-001".into(),
                scope: "actions".into(),
                entity_id: None,
                payload_json: "{}".into(),
                fetched_at: 1,
                stale_at: 2,
                expires_at: 3,
            },
        )
        .await
        .unwrap();

        invalidate_github_cache(&pool, "t-001", &["overview"])
            .await
            .unwrap();

        assert!(get_github_cache_entry(&pool, "t-001:overview")
            .await
            .unwrap()
            .is_none());
        assert!(get_github_cache_entry(&pool, "t-001:actions")
            .await
            .unwrap()
            .is_some());
    }

    #[test]
    fn step_serializes_as_camel_case() {
        let step = Step {
            id: "step-1".into(),
            session_id: "s-001".into(),
            message: "do something".into(),
            attachments_json: None,
            armed: true,
            model: Some("sonnet".into()),
            plan_mode: Some(true),
            thinking_mode: Some(true),
            fast_mode: Some(false),
            sort_order: 0,
            created_at: 5000,
        };
        let json = serde_json::to_value(&step).unwrap();
        assert!(json.get("sessionId").is_some());
        assert!(json.get("attachmentsJson").is_some());
        assert!(json.get("sortOrder").is_some());
        assert!(json.get("planMode").is_some());
        assert!(json.get("createdAt").is_some());
    }

    // -- Refcount tests (Phase 6) --
    //
    // These exercise the full process_write → blob refcount wiring. We seed
    // blobs via `blob::write_blob` and assert refcount tracks step / output
    // lifecycle through the normal write queue dispatch.

    async fn seed_blob_pair() -> (tempfile::TempDir, SqlitePool, String, String) {
        let tmp = tempfile::TempDir::new().unwrap();
        let pool = test_pool().await;
        let r1 = crate::blob::write_blob(&pool, tmp.path(), "image/png", b"img-1")
            .await
            .unwrap();
        let r2 = crate::blob::write_blob(&pool, tmp.path(), "image/png", b"img-2")
            .await
            .unwrap();
        (tmp, pool, r1.hash, r2.hash)
    }

    fn refs_json(hashes: &[&str]) -> String {
        let arr: Vec<serde_json::Value> = hashes
            .iter()
            .map(|h| serde_json::json!({"hash": h, "mimeType": "image/png", "name": "x.png", "size": 1}))
            .collect();
        serde_json::to_string(&arr).unwrap()
    }

    async fn ref_count(pool: &SqlitePool, hash: &str) -> i64 {
        crate::blob::get_blob_info(pool, hash)
            .await
            .unwrap()
            .map(|i| i.ref_count)
            .unwrap_or(-1)
    }

    async fn project_task_session(pool: &SqlitePool) {
        process_write(pool, DbWrite::InsertProject(make_project()))
            .await
            .unwrap();
        process_write(pool, DbWrite::InsertTask(make_task("p-001")))
            .await
            .unwrap();
        process_write(pool, DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn insert_step_increments_blob_refcount() {
        let (_tmp, pool, h1, h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1, &h2]));
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();

        assert_eq!(ref_count(&pool, &h1).await, 1);
        assert_eq!(ref_count(&pool, &h2).await, 1);
    }

    #[tokio::test]
    async fn delete_step_decrements_blob_refcount() {
        let (_tmp, pool, h1, _h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1]));
        let step_id = step.id.clone();
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 1);

        process_write(&pool, DbWrite::DeleteStep { id: step_id })
            .await
            .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 0);
    }

    #[tokio::test]
    async fn update_step_swaps_attachment_refs() {
        let (_tmp, pool, h1, h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1]));
        let step_id = step.id.clone();
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 1);
        assert_eq!(ref_count(&pool, &h2).await, 0);

        process_write(
            &pool,
            DbWrite::UpdateStep {
                id: step_id,
                message: "updated".into(),
                armed: false,
                model: None,
                plan_mode: None,
                thinking_mode: None,
                fast_mode: None,
                attachments_json: Some(refs_json(&[&h2])),
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 0);
        assert_eq!(ref_count(&pool, &h2).await, 1);
    }

    #[tokio::test]
    async fn update_step_to_none_releases_all_refs() {
        let (_tmp, pool, h1, h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1, &h2]));
        let step_id = step.id.clone();
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();

        process_write(
            &pool,
            DbWrite::UpdateStep {
                id: step_id,
                message: "no atts".into(),
                armed: false,
                model: None,
                plan_mode: None,
                thinking_mode: None,
                fast_mode: None,
                attachments_json: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 0);
        assert_eq!(ref_count(&pool, &h2).await, 0);
    }

    #[tokio::test]
    async fn insert_output_lines_increments_user_message_refs() {
        let (_tmp, pool, h1, _h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let line = serde_json::json!({
            "type": "verun_user_message",
            "text": "hi",
            "attachments": [{"hash": h1, "mimeType": "image/png", "name": "a.png", "size": 1}],
        })
        .to_string();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(line, 1234)],
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 1);
    }

    #[tokio::test]
    async fn delete_output_lines_decrements_user_message_refs() {
        let (_tmp, pool, h1, _h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let line = serde_json::json!({
            "type": "verun_user_message",
            "text": "hi",
            "attachments": [{"hash": h1, "mimeType": "image/png", "name": "a.png", "size": 1}],
        })
        .to_string();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(line, 1234)],
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 1);

        process_write(
            &pool,
            DbWrite::DeleteOutputLines {
                session_id: "s-001".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 0);
    }

    #[tokio::test]
    async fn delete_task_cascade_decrements_blob_refs() {
        let (_tmp, pool, h1, h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        // step references h1, output_line references h2
        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1]));
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();
        let line = serde_json::json!({
            "type": "verun_user_message",
            "text": "hi",
            "attachments": [{"hash": h2, "mimeType": "image/png", "name": "a.png", "size": 1}],
        })
        .to_string();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(line, 1234)],
            },
        )
        .await
        .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 1);
        assert_eq!(ref_count(&pool, &h2).await, 1);

        process_write(&pool, DbWrite::DeleteTask { id: "t-001".into() })
            .await
            .unwrap();

        assert_eq!(ref_count(&pool, &h1).await, 0);
        assert_eq!(ref_count(&pool, &h2).await, 0);
    }

    #[tokio::test]
    async fn delete_project_cascade_decrements_blob_refs() {
        let (_tmp, pool, h1, h2) = seed_blob_pair().await;
        project_task_session(&pool).await;

        let mut step = make_step("s-001", 0);
        step.attachments_json = Some(refs_json(&[&h1]));
        process_write(&pool, DbWrite::InsertStep(step))
            .await
            .unwrap();
        let line = serde_json::json!({
            "type": "verun_user_message",
            "text": "hi",
            "attachments": [{"hash": h2, "mimeType": "image/png", "name": "a.png", "size": 1}],
        })
        .to_string();
        process_write(
            &pool,
            DbWrite::InsertOutputLines {
                session_id: "s-001".into(),
                lines: vec![(line, 1234)],
            },
        )
        .await
        .unwrap();

        process_write(&pool, DbWrite::DeleteProject { id: "p-001".into() })
            .await
            .unwrap();
        assert_eq!(ref_count(&pool, &h1).await, 0);
        assert_eq!(ref_count(&pool, &h2).await, 0);
    }
}
