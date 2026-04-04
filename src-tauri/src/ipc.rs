use crate::agent::{self, Agent, AgentMap};
use crate::worktree;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn spawn_agent(
    app: AppHandle,
    agents: State<'_, AgentMap>,
    repo_path: String,
    branch: String,
    prompt: String,
) -> Result<Agent, String> {
    // Create worktree for the agent
    let worktree_path = tokio::task::spawn_blocking({
        let repo_path = repo_path.clone();
        let branch = branch.clone();
        move || worktree::create_worktree(&repo_path, &branch)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Spawn the agent process
    agent::spawn_agent(
        app,
        agents.inner().clone(),
        repo_path,
        worktree_path,
        branch,
        prompt,
    )
    .await
}

#[tauri::command]
pub async fn kill_agent(agents: State<'_, AgentMap>, agent_id: String) -> Result<(), String> {
    agent::kill_agent(agents.inner(), &agent_id).await
}

#[tauri::command]
pub async fn restart_agent(
    _app: AppHandle,
    _agents: State<'_, AgentMap>,
    _agent_id: String,
) -> Result<(), String> {
    // TODO: Phase 2 — reload agent config from DB and respawn
    Err("restart_agent not yet implemented".to_string())
}

#[tauri::command]
pub async fn list_agents() -> Result<Vec<Agent>, String> {
    // TODO: Phase 2 — query SQLite for all agents
    Ok(vec![])
}

#[tauri::command]
pub async fn create_worktree(repo_path: String, branch: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || worktree::create_worktree(&repo_path, &branch))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn delete_worktree(worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // We need the repo path to delete — derive from worktree parent
        // TODO: Phase 2 — get repo_path from DB
        worktree::delete_worktree(".", &worktree_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || worktree::list_worktrees(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_session(_agent_id: String) -> Result<(), String> {
    // TODO: Phase 2 — query session from SQLite
    Ok(())
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open Finder: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_diff(worktree_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || worktree::get_diff(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn merge_branch(_worktree_path: String, target_branch: String) -> Result<(), String> {
    // TODO: Phase 2 — derive repo_path and source_branch from DB
    tokio::task::spawn_blocking(move || {
        worktree::merge_branch(".", "source", &target_branch)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
