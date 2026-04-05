# Phase 2: Rust Backend — Full Implementation

## Goal
Complete all Rust backend modules: SQLite persistence, task/session lifecycle, worktree management, and streaming.

## Data Model

```
projects (1) → tasks (many) → sessions (many) → output_lines (many)
```

- **Project** — a repo added to Verun. Stores repo path, display name.
- **Task** — a unit of work within a project. Owns a worktree and a funny auto-generated branch name. Name is nullable, derived from Claude after the first message.
- **Session** — a Claude Code CLI session within a task's worktree. Maps 1:1 to `claude --resume <session_id>`. Has its own name (first session shares the task name). Multiple sessions per task.
- **Output lines** — every line of stdout/stderr from a session, persisted for replay.

## Prerequisites
- Phase 1 complete (project scaffolded, all stubs compile)

## Files to Modify

### 1. `src-tauri/src/db.rs` — SQLite Queries (DONE)
- [x] Schema: projects, tasks, sessions, output_lines tables with indexes
- [x] Row types: `Project`, `Task`, `Session`, `OutputLine` with `FromRow` + serde camelCase
- [x] Async write queue via `tokio::mpsc` channel — fire-and-forget from callers
- [x] Write operations: insert/update/delete for all entities, cascade deletes, `ResetRunningSessions`
- [x] Read functions: `get_project`, `list_projects`, `get_task`, `list_tasks_for_project`, `get_session`, `list_sessions_for_task`, `get_output_lines`
- [x] Pool constructor: `connect(app_data_dir)` using sqlx directly
- [x] 17 tests passing (in-memory SQLite)

### 2. `src-tauri/src/task.rs` — Task + Process Lifecycle (DONE)
- [x] Renamed agent.rs → task.rs, updated mod declarations
- [x] `SessionMap`: `Arc<DashMap<String, SessionHandle>>` with Child + metadata
- [x] `create_task(project_id, repo_path)`: worktree + funny branch name + persist
- [x] `delete_task(task_id)`: kill sessions + remove worktree + cascade DB delete
- [x] `start_session(task_id, worktree_path)`: spawn interactive `claude` CLI
- [x] `resume_session(...)`: spawn `claude --resume <id>`
- [x] `stop_session(session_id)`: SIGTERM → 5s grace → SIGKILL
- [x] Monitor task: streams output → waits for exit → maps exit code → updates DB
- [x] Funny branch name generator (24 adjectives × 24 animals × 1000 numbers)
- [x] 5 tests passing

### 3. `src-tauri/src/stream.rs` — Output Buffering (DONE)
- [x] Batching: 16 lines / 50ms flush (unchanged)
- [x] Persists output lines to SQLite via async write queue
- [x] Handles stderr separately: prefixed with `[stderr]`
- [x] Concurrent stdout/stderr reading via `tokio::select!`
- [x] Exit code mapping: `map_exit_status(Option<i32>)` → done/error
- [x] Backpressure: caps DB persistence at 10K lines (frontend still receives all)
- [x] 11 tests passing

### 4. `src-tauri/src/worktree.rs` — Git Operations (DONE)
- [x] Callers wrap in `spawn_blocking` (ipc.rs and task.rs)
- [x] `get_repo_root(path)` — resolves any path to .git root
- [x] `validate_git_installed()` and `validate_branch_name(name)`
- [x] `create_worktree` validates repo exists + branch name before creating
- [x] `merge_branch`: auto-cleans up source worktree after merge
- [x] `get_branch_status(worktree_path)` — ahead/behind vs main/master/upstream
- [x] 12 tests passing

### 5. `src-tauri/src/ipc.rs` — Wire Everything (DONE)
- [x] Project commands: `add_project`, `list_projects`, `delete_project`
- [x] Task commands: `create_task`, `list_tasks`, `get_task`, `delete_task`
- [x] Session commands: `start_session`, `resume_session`, `stop_session`, `list_sessions`, `get_session`, `get_output_lines`
- [x] Git commands: `get_diff`, `merge_branch`, `get_branch_status`, `get_repo_info`
- [x] Utility: `open_in_finder`
- [x] 20 commands total, 1 test

### 6. `src-tauri/src/lib.rs` — Plugin Registration (DONE)
- [x] All 20 commands registered
- [x] sqlx pool + DbWriteTx + SessionMap as managed Tauri state
- [x] Async setup hook: connect DB, spawn write queue, reset stale sessions
- [x] mod agent → mod task

## Testing Strategy
- [x] Unit test each db function with in-memory SQLite (17 tests)
- [ ] Integration test task/session spawn/kill with a mock "echo" command instead of claude
- [x] Test worktree operations against a temp git repo (12 tests)

## Performance Targets
- Task creation to first session output: < 500ms
- SQLite write queue throughput: > 1000 lines/sec
- Session kill to confirmed dead: < 6s (5s grace + 1s SIGKILL)

## Acceptance Criteria
- [x] Can add a project, create a task (gets worktree + funny branch), start a session, see output, stop it
- [x] Can resume a session across app restarts via `claude --resume`
- [x] Multiple sessions per task work independently
- [x] Task/session data persists across app restarts
- [x] Worktree created on task creation, cleaned up on task deletion
- [x] Output history retrievable from SQLite after session ends
- [x] No errors in `cargo check` (unused warnings expected until frontend wires commands)
- [x] Zero clippy warnings (excluding unused items)
- [x] 50 tests passing across all modules
