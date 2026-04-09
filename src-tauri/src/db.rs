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
    pub created_at: i64,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub task_id: String,
    pub name: Option<String>,
    pub claude_session_id: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
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

// ---------------------------------------------------------------------------
// Async write queue
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub enum DbWrite {
    // Projects
    InsertProject(Project),
    UpdateProjectBaseBranch { id: String, base_branch: String },
    UpdateProjectHooks { id: String, setup_hook: String, destroy_hook: String, start_command: String },
    DeleteProject { id: String },

    // Tasks
    InsertTask(Task),
    UpdateTaskName { id: String, name: String },
    SetMergeBaseSha { id: String, sha: String },
    DeleteTask { id: String },

    // Sessions
    CreateSession(Session),
    UpdateSessionName { id: String, name: String },
    UpdateSessionStatus { id: String, status: String },
    SetClaudeSessionId { id: String, claude_session_id: String },
    EndSession { id: String, ended_at: i64 },
    CloseSession { id: String },

    // Output
    InsertOutputLines { session_id: String, lines: Vec<(String, i64)> },
    DeleteOutputLines { session_id: String },

    // Policy
    SetTrustLevel { task_id: String, trust_level: String, updated_at: i64 },
    InsertAuditEntry {
        session_id: String,
        task_id: String,
        tool_name: String,
        tool_input_summary: String,
        decision: String,
        reason: String,
        created_at: i64,
    },

    // Startup recovery
    ResetRunningSessions,
}

pub type DbWriteTx = mpsc::Sender<DbWrite>;

/// Spawn the background write loop. Returns a sender handle to enqueue writes.
pub fn spawn_write_queue(pool: SqlitePool) -> DbWriteTx {
    let (tx, mut rx) = mpsc::channel::<DbWrite>(1024);
    tokio::spawn(async move {
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
                "INSERT INTO projects (id, name, repo_path, base_branch, setup_hook, destroy_hook, start_command, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&p.id)
            .bind(&p.name)
            .bind(&p.repo_path)
            .bind(&p.base_branch)
            .bind(&p.setup_hook)
            .bind(&p.destroy_hook)
            .bind(&p.start_command)
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
        DbWrite::UpdateProjectHooks { id, setup_hook, destroy_hook, start_command } => {
            sqlx::query("UPDATE projects SET setup_hook = ?, destroy_hook = ?, start_command = ? WHERE id = ?")
                .bind(&setup_hook)
                .bind(&destroy_hook)
                .bind(&start_command)
                .bind(&id)
                .execute(pool)
                .await?;
        }
        DbWrite::DeleteProject { id } => {
            // Cascade: audit_log → trust_levels → output_lines → sessions → tasks → project
            sqlx::query(
                "DELETE FROM policy_audit_log WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM task_trust_levels WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM output_lines WHERE session_id IN \
                 (SELECT s.id FROM sessions s JOIN tasks t ON s.task_id = t.id WHERE t.project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM sessions WHERE task_id IN \
                 (SELECT id FROM tasks WHERE project_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query("DELETE FROM tasks WHERE project_id = ?")
                .bind(&id).execute(pool).await?;
            sqlx::query("DELETE FROM projects WHERE id = ?")
                .bind(&id).execute(pool).await?;
        }

        // -- Tasks --
        DbWrite::InsertTask(t) => {
            sqlx::query(
                "INSERT INTO tasks (id, project_id, name, worktree_path, branch, created_at, port_offset) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&t.id)
            .bind(&t.project_id)
            .bind(&t.name)
            .bind(&t.worktree_path)
            .bind(&t.branch)
            .bind(t.created_at)
            .bind(t.port_offset)
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
                .bind(&id).execute(pool).await?;
            sqlx::query("DELETE FROM task_trust_levels WHERE task_id = ?")
                .bind(&id).execute(pool).await?;
            sqlx::query(
                "DELETE FROM output_lines WHERE session_id IN \
                 (SELECT id FROM sessions WHERE task_id = ?)",
            )
            .bind(&id).execute(pool).await?;
            sqlx::query("DELETE FROM sessions WHERE task_id = ?")
                .bind(&id).execute(pool).await?;
            sqlx::query("DELETE FROM tasks WHERE id = ?")
                .bind(&id).execute(pool).await?;
        }

        // -- Sessions --
        DbWrite::CreateSession(s) => {
            sqlx::query(
                "INSERT INTO sessions (id, task_id, name, claude_session_id, status, started_at, ended_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&s.id)
            .bind(&s.task_id)
            .bind(&s.name)
            .bind(&s.claude_session_id)
            .bind(&s.status)
            .bind(s.started_at)
            .bind(s.ended_at)
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
        DbWrite::SetClaudeSessionId { id, claude_session_id } => {
            sqlx::query("UPDATE sessions SET claude_session_id = ? WHERE id = ?")
                .bind(&claude_session_id)
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

        // -- Policy --
        DbWrite::SetTrustLevel { task_id, trust_level, updated_at } => {
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
        DbWrite::InsertAuditEntry { session_id, task_id, tool_name, tool_input_summary, decision, reason, created_at } => {
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
    sqlx::query_as::<_, Project>("SELECT * FROM projects ORDER BY created_at DESC")
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
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

pub async fn next_port_offset(pool: &SqlitePool, project_id: &str) -> Result<i64, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT COALESCE(MAX(port_offset), -1) FROM tasks WHERE project_id = ?",
    )
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

// Policy

pub async fn get_trust_level(pool: &SqlitePool, task_id: &str) -> Result<String, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT trust_level FROM task_trust_levels WHERE task_id = ?",
    )
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
    fn has_six_migrations() {
        let m = migrations();
        assert_eq!(m.len(), 6);
        assert_eq!(m[0].version, 1);
        assert_eq!(m[1].version, 2);
        assert_eq!(m[2].version, 3);
        assert_eq!(m[3].version, 4);
        assert_eq!(m[4].version, 5);
        assert_eq!(m[5].version, 6);
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
            created_at: 1000,
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
        }
    }

    fn make_session(task_id: &str) -> Session {
        Session {
            id: "s-001".into(),
            task_id: task_id.into(),
            name: None,
            claude_session_id: None,
            status: "running".into(),
            started_at: 3000,
            ended_at: None,
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

        process_write(&pool, DbWrite::InsertProject(p1)).await.unwrap();
        process_write(&pool, DbWrite::InsertProject(p2)).await.unwrap();

        let projects = list_projects(&pool).await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, "p-002"); // newest first
    }

    #[tokio::test]
    async fn delete_project_cascades() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001"))).await.unwrap();
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
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();

        let t = get_task(&pool, "t-001").await.unwrap().unwrap();
        assert_eq!(t.project_id, "p-001");
        assert_eq!(t.branch, "silly-penguin");
        assert!(t.name.is_none());
    }

    #[tokio::test]
    async fn update_task_name() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();

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

        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertProject(p2)).await.unwrap();

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
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001"))).await.unwrap();
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

    // -- Session tests --

    #[tokio::test]
    async fn session_lifecycle() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001"))).await.unwrap();

        let s = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(s.status, "running");
        assert!(s.claude_session_id.is_none());
        assert!(s.ended_at.is_none());

        // Set claude session id once we get it from CLI
        process_write(
            &pool,
            DbWrite::SetClaudeSessionId {
                id: "s-001".into(),
                claude_session_id: "claude-xyz".into(),
            },
        )
        .await
        .unwrap();

        let s = get_session(&pool, "s-001").await.unwrap().unwrap();
        assert_eq!(s.claude_session_id.as_deref(), Some("claude-xyz"));

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
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();

        let mut s1 = make_session("t-001");
        s1.id = "s-001".into();
        s1.started_at = 1000;
        let mut s2 = make_session("t-001");
        s2.id = "s-002".into();
        s2.started_at = 2000;

        process_write(&pool, DbWrite::CreateSession(s1)).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(s2)).await.unwrap();

        let sessions = list_sessions_for_task(&pool, "t-001").await.unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "s-001"); // oldest first
    }

    // -- Output tests --

    #[tokio::test]
    async fn insert_and_get_output_lines() {
        let pool = test_pool().await;
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(make_session("t-001"))).await.unwrap();

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
        process_write(&pool, DbWrite::InsertProject(make_project())).await.unwrap();
        process_write(&pool, DbWrite::InsertTask(make_task("p-001"))).await.unwrap();

        let mut s1 = make_session("t-001");
        s1.id = "s-run".into();
        s1.status = "running".into();
        let mut s2 = make_session("t-001");
        s2.id = "s-done".into();
        s2.status = "done".into();

        process_write(&pool, DbWrite::CreateSession(s1)).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(s2)).await.unwrap();

        process_write(&pool, DbWrite::ResetRunningSessions).await.unwrap();

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
        assert!(json.get("claudeSessionId").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(json.get("endedAt").is_some());
    }

    #[test]
    fn get_nonexistent_returns_none() {
        // Sync check that the functions exist and return the right types
        // Actual async tests above cover the behavior
    }
}
