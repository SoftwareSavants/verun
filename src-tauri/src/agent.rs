use crate::stream;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::process::{Child, Command};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_agent_map_is_empty() {
        let map = new_agent_map();
        assert!(map.is_empty());
    }

    fn make_agent() -> Agent {
        Agent {
            id: "abc-123".into(),
            name: "agent-feature".into(),
            status: "running".into(),
            repo_path: "/tmp/repo".into(),
            worktree_path: "/tmp/repo-wt".into(),
            branch: "feature".into(),
            pid: Some(1234),
            prompt: "do stuff".into(),
            created_at: 1000,
            last_active_at: 2000,
        }
    }

    #[test]
    fn agent_serialization_roundtrip() {
        let agent = make_agent();
        let json = serde_json::to_string(&agent).unwrap();
        let back: Agent = serde_json::from_str(&json).unwrap();

        assert_eq!(back.id, "abc-123");
        assert_eq!(back.name, "agent-feature");
        assert_eq!(back.status, "running");
        assert_eq!(back.pid, Some(1234));
        assert_eq!(back.created_at, 1000);
        assert_eq!(back.last_active_at, 2000);
    }

    #[test]
    fn agent_serializes_as_camel_case() {
        let agent = make_agent();
        let json = serde_json::to_value(&agent).unwrap();

        // Verify camelCase keys match the frontend TypeScript types
        assert!(json.get("repoPath").is_some());
        assert!(json.get("worktreePath").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("lastActiveAt").is_some());
        // snake_case keys should NOT exist
        assert!(json.get("repo_path").is_none());
        assert!(json.get("worktree_path").is_none());
    }

    #[test]
    fn agent_serialization_with_no_pid() {
        let agent = Agent { pid: None, ..make_agent() };
        let json = serde_json::to_string(&agent).unwrap();

        assert!(json.contains("\"pid\":null"));
        let back: Agent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pid, None);
    }

    #[tokio::test]
    async fn kill_nonexistent_agent_is_ok() {
        let map = new_agent_map();
        let result = kill_agent(&map, "does-not-exist").await;
        assert!(result.is_ok());
    }

    #[test]
    fn chrono_now_returns_reasonable_timestamp() {
        let ts = chrono_now();
        // Should be after 2024-01-01 in millis
        assert!(ts > 1_704_067_200_000);
        // Should be before 2100-01-01 in millis
        assert!(ts < 4_102_444_800_000);
    }

    #[test]
    fn agent_name_format() {
        let name = format!("agent-{}", "my-feature");
        assert_eq!(name, "agent-my-feature");
    }
}
