# Phase 2: Rust Backend — Full Implementation

## Goal
Complete all Rust backend modules with full functionality: SQLite persistence, agent lifecycle, worktree management, and streaming.

## Prerequisites
- Phase 1 complete (project scaffolded, all stubs compile)

## Files to Modify

### 1. `src-tauri/src/db.rs` — SQLite Queries
- Add CRUD functions for agents table: `insert_agent`, `update_agent_status`, `get_agent`, `list_agents`, `delete_agent`
- Add session functions: `create_session`, `end_session`, `get_session_for_agent`
- Add output line functions: `insert_output_lines` (batch), `get_output_lines_for_session`
- All functions take a `tauri_plugin_sql::DbPool` or equivalent handle
- Use async write queue pattern: dedicate a `tokio::mpsc` channel for writes so they never block agent threads
- Write operations are fire-and-forget from the caller's perspective

### 2. `src-tauri/src/agent.rs` — Process Lifecycle
- On `spawn_agent`: persist agent to SQLite, create session row, begin streaming
- On `kill_agent`: send SIGTERM, wait 5s, SIGKILL if needed, update status in DB
- Add `restart_agent`: read agent config from DB, kill existing, respawn with same prompt
- Add `pause_agent` / `resume_agent` using SIGSTOP/SIGCONT
- Track agent state transitions: idle → running → done/error, running → paused → running
- Update `last_active_at` on every output event (debounced, ~1s)
- Store `DashMap<String, AgentHandle>` where `AgentHandle` holds Child + metadata

### 3. `src-tauri/src/stream.rs` — Output Buffering
- Current implementation is functional — enhance with:
  - Persist output lines to SQLite (via the async write queue, not inline)
  - Handle stderr separately: prefix with `[stderr]` marker
  - Detect Claude Code exit codes and map to appropriate AgentStatus
  - Add backpressure: if frontend is not consuming events, cap buffer at 10K lines

### 4. `src-tauri/src/worktree.rs` — Git Operations
- Current implementation uses `std::process::Command` — wrap all calls in `tokio::task::spawn_blocking`
- Add `get_repo_root(path)` helper to find the actual .git root
- Add validation: check git is installed, repo exists, branch name is valid
- `merge_branch`: after merge, automatically clean up the worktree
- Add `get_branch_status(worktree_path)` — ahead/behind count vs main

### 5. `src-tauri/src/ipc.rs` — Wire Everything
- `restart_agent`: implement using DB lookup + respawn
- `list_agents`: query SQLite, merge with DashMap for live PID/status
- `get_session`: return full session with output lines from SQLite
- `delete_worktree`: look up repo_path from agent record in DB
- `merge_branch`: look up source branch and repo_path from DB
- Add new commands:
  - `pause_agent(agent_id)` / `resume_agent(agent_id)`
  - `get_agent(agent_id) -> Agent`
  - `delete_agent(agent_id)` — kills if running, removes worktree, deletes from DB
  - `get_repo_info(path) -> RepoInfo` — branches, current branch, remote URL

### 6. `src-tauri/src/lib.rs` — Plugin Registration
- Register any new commands added to ipc.rs
- Set up the async write queue as managed state
- Add app setup hook to restore running agents from DB on app launch (set to 'idle' since processes didn't survive restart)

## Testing Strategy
- Unit test each db function with an in-memory SQLite
- Integration test agent spawn/kill with a mock "echo" command instead of claude
- Test worktree operations against a temp git repo

## Performance Targets
- Agent spawn to first output event: < 500ms
- SQLite write queue throughput: > 1000 lines/sec
- Agent kill to confirmed dead: < 6s (5s grace + 1s SIGKILL)

## Acceptance Criteria
- [ ] Can spawn an agent, see output stream, kill it, and see "idle" status
- [ ] Agent data persists across app restarts (minus live processes)
- [ ] Worktree is created on spawn, cleaned up on delete
- [ ] Output history is retrievable from SQLite after agent completes
- [ ] No warnings in `cargo check`
