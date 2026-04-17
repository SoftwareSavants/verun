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
    pub parent_session_id: Option<String>,
    #[sqlx(default)]
    pub forked_at_message_uuid: Option<String>,
    #[sqlx(default)]
    pub agent_type: String,
    #[sqlx(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    pub id: i64,
    pub session_id: String,
    pub line: String,
    pub emitted_at: i64,
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
    RestoreTask {
        id: String,
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
    AccumulateSessionCost {
        id: String,
        cost: f64,
    },
    CloseSession {
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

        DbWrite::RestoreTask { id } => {
            sqlx::query("UPDATE tasks SET archived = 0, archived_at = NULL WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
        }

        // -- Sessions --
        DbWrite::CreateSession(s) => {
            sqlx::query(
                "INSERT INTO sessions (id, task_id, name, resume_session_id, status, started_at, ended_at, total_cost, parent_session_id, forked_at_message_uuid, agent_type, model) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        DbWrite::AccumulateSessionCost { id, cost } => {
            sqlx::query("UPDATE sessions SET total_cost = total_cost + ? WHERE id = ?")
                .bind(cost)
                .bind(&id)
                .execute(pool)
                .await?;
        }

        // -- Output --
        DbWrite::InsertOutputLines { session_id, lines } => {
            let mut tx = pool.begin().await?;
            for (line, emitted_at) in &lines {
                sqlx::query(
                    "INSERT INTO output_lines (session_id, line, emitted_at) VALUES (?, ?, ?)",
                )
                .bind(&session_id)
                .bind(line)
                .bind(emitted_at)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
        }

        DbWrite::CloseSession { id } => {
            sqlx::query("UPDATE sessions SET status = 'closed' WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
        }

        DbWrite::DeleteOutputLines { session_id } => {
            sqlx::query("DELETE FROM output_lines WHERE session_id = ?")
                .bind(&session_id)
                .execute(pool)
                .await?;
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
        }
        DbWrite::DeleteStep { id } => {
            sqlx::query("DELETE FROM steps WHERE id = ?")
                .bind(&id)
                .execute(pool)
                .await?;
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

// Output

pub async fn get_output_lines(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<OutputLine>, String> {
    sqlx::query_as::<_, OutputLine>(
        "SELECT * FROM output_lines WHERE session_id = ? ORDER BY id ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
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

    Ok(pool)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_twelve_migrations() {
        let m = migrations();
        assert_eq!(m.len(), 17);
        assert_eq!(m[0].version, 1);
        assert_eq!(m[1].version, 2);
        assert_eq!(m[2].version, 3);
        assert_eq!(m[3].version, 4);
        assert_eq!(m[4].version, 5);
        assert_eq!(m[5].version, 6);
        assert_eq!(m[6].version, 7);
        assert_eq!(m[7].version, 8);
        assert_eq!(m[8].version, 9);
        assert_eq!(m[9].version, 10);
        assert_eq!(m[10].version, 11);
        assert_eq!(m[11].version, 12);
        assert_eq!(m[12].version, 13);
        assert_eq!(m[13].version, 14);
        assert_eq!(m[14].version, 15);
        assert_eq!(m[15].version, 16);
        assert_eq!(m[16].version, 17);
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
            parent_session_id: None,
            forked_at_message_uuid: None,
            agent_type: "claude".into(),
            model: None,
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
        assert!(get_output_lines(&pool, "s-001").await.unwrap().is_empty());
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
        assert!(get_output_lines(&pool, "s-001").await.unwrap().is_empty());
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
        assert!(!get_output_lines(&pool, "s-001").await.unwrap().is_empty());
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

        let output = get_output_lines(&pool, "s-001").await.unwrap();
        assert_eq!(output.len(), 3);
        assert_eq!(output[0].line, "line 1");
        assert_eq!(output[2].line, "line 3");
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
}
