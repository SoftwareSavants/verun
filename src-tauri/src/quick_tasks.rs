//! Quick tasks: run an agent in any folder (home, a non-git dir, several repos'
//! parent) without adding a project first. They are existing-directory tasks
//! under one reserved project, so they get no setup, no worktree and no cleanup.
use crate::db::{self, DbWriteTx, Project};
use sqlx::SqlitePool;

pub const QUICK_PROJECT_ID: &str = "quick-tasks";

pub fn quick_project(home: &str, now: i64) -> Project {
    Project {
        id: QUICK_PROJECT_ID.into(),
        name: "Quick tasks".into(),
        repo_path: home.into(),
        base_branch: String::new(),
        setup_hook: String::new(),
        destroy_hook: String::new(),
        start_command: String::new(),
        auto_start: false,
        created_at: now,
        default_agent_type: crate::agent::AgentKind::Claude.as_str().to_string(),
    }
}

/// The reserved project, created on first use.
pub async fn ensure(pool: &SqlitePool, db_tx: &DbWriteTx) -> Result<Project, String> {
    if let Some(existing) = db::get_project(pool, QUICK_PROJECT_ID).await? {
        return Ok(existing);
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let project = quick_project(&home, crate::task::epoch_ms());
    db_tx
        .send(db::DbWrite::InsertProject(project.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quick_project_is_rooted_at_home_with_nothing_to_run() {
        let p = quick_project("/Users/me", 5);
        assert_eq!(p.id, QUICK_PROJECT_ID);
        assert_eq!(p.repo_path, "/Users/me");
        assert!(p.setup_hook.is_empty() && p.destroy_hook.is_empty() && p.start_command.is_empty());
        assert_eq!(p.default_agent_type, "claude");
    }
}
