use crate::stream;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::process::{Child, Command};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub status: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub pid: Option<u32>,
    pub prompt: String,
    pub created_at: i64,
    pub last_active_at: i64,
}

pub type AgentMap = Arc<DashMap<String, Child>>;

pub fn new_agent_map() -> AgentMap {
    Arc::new(DashMap::new())
}

/// Spawn a new Claude Code process in the given worktree
pub async fn spawn_agent(
    app: AppHandle,
    agents: AgentMap,
    repo_path: String,
    worktree_path: String,
    branch: String,
    prompt: String,
) -> Result<Agent, String> {
    let id = Uuid::new_v4().to_string();
    let name = format!("agent-{}", &branch);
    let now = chrono_now();

    let mut child = Command::new("claude")
        .args(["--print", "--output-format", "stream-json", &prompt])
        .current_dir(&worktree_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    let pid = child.id();

    // Take stdout for streaming
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    // Stream output in background task
    let stream_app = app.clone();
    let stream_id = id.clone();
    tokio::spawn(async move {
        stream::stream_output(stream_app, stream_id, stdout).await;
    });

    // Store child process handle for lifecycle management
    agents.insert(id.clone(), child);

    Ok(Agent {
        id,
        name,
        status: "running".to_string(),
        repo_path,
        worktree_path,
        branch,
        pid,
        prompt,
        created_at: now,
        last_active_at: now,
    })
}

/// Kill a running agent process
pub async fn kill_agent(agents: &AgentMap, agent_id: &str) -> Result<(), String> {
    if let Some(mut entry) = agents.get_mut(agent_id) {
        entry
            .value_mut()
            .kill()
            .await
            .map_err(|e| format!("Failed to kill agent: {}", e))?;
    }
    agents.remove(agent_id);
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
