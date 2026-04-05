# Phase 3: Frontend State & IPC Integration

## Goal
Wire the Solid.js stores and hooks to the Rust backend so the UI reflects real project/task/session state.

## Data Model (matches Rust backend)

```
projects (1) → tasks (many) → sessions (many) → output_lines (many)
```

## Prerequisites
- Phase 2 complete (Rust backend fully functional, 20 IPC commands available)

## Files to Modify

### 1. `src/types/index.ts` — Shared Types
- Replace Agent type with Project, Task, Session, OutputLine types matching Rust structs
- Add RepoInfo type (root, currentBranch, branches)
- All types use camelCase (matching Rust serde output)

### 2. `src/lib/ipc.ts` — IPC Wrappers
- Typed wrappers for all 20 backend commands:
  - Projects: `addProject`, `listProjects`, `deleteProject`
  - Tasks: `createTask`, `listTasks`, `getTask`, `deleteTask`
  - Sessions: `startSession`, `resumeSession`, `stopSession`, `listSessions`, `getSession`, `getOutputLines`
  - Git: `getDiff`, `mergeBranch`, `getBranchStatus`, `getRepoInfo`
  - Utility: `openInFinder`
- Consistent error handling on all calls

### 3. `src/store/projects.ts` — Project Store (new, replaces agents.ts)
- On app mount, call `listProjects()` to hydrate from SQLite
- `addProject(repoPath)`: calls IPC, adds to store
- `deleteProject(id)`: calls IPC, removes from store
- Selected project ID signal

### 4. `src/store/tasks.ts` — Task Store (new)
- When selected project changes, call `listTasks(projectId)` to load tasks
- `createTask(projectId)`: calls IPC, adds to store (task comes back with funny branch name)
- `deleteTask(id)`: calls IPC, removes from store
- Selected task ID signal

### 5. `src/store/sessions.ts` — Session Store (update)
- When selected task changes, call `listSessions(taskId)` to load sessions
- Listen to `session-status` Tauri event to update session status in real-time
- Listen to `session-output` Tauri event to append new lines to active session
- `startSession(taskId)`: calls IPC, adds to store
- `resumeSession(sessionId)`: calls IPC, updates store
- `stopSession(sessionId)`: calls IPC, updates store
- `loadOutputLines(sessionId)`: loads historical output from SQLite on demand
- Line cap: keep only last 50K lines in memory, older lines stay in SQLite

### 6. New: `src/store/ui.ts` — UI State
- `selectedProjectId: string | null`
- `selectedTaskId: string | null`
- `selectedSessionId: string | null`
- `sidebarWidth: number` (resizable sidebar)
- `showNewTaskDialog: boolean`
- `toasts: Toast[]` for notifications
- `theme: 'dark'`

### 7. `src/hooks/useWorktree.ts` — Worktree Hook
- Add `getRepoInfo(path)` for branch list in UI
- Add `getBranchStatus(taskId)` to show ahead/behind in task header

## Testing Strategy
- Mock Tauri `invoke` and `listen` in unit tests
- Test store reactivity: simulate events, verify state updates
- Test edge cases: session dies mid-stream, rapid start/stop

## Acceptance Criteria
- [ ] Opening the app shows previously added projects from SQLite
- [ ] Selecting a project shows its tasks
- [ ] Selecting a task shows its sessions
- [ ] Selecting a session loads its output history
- [ ] Real-time output appears as session runs (no polling)
- [ ] Status badges update when session state changes
- [ ] Start/stop/resume from UI works and updates all stores
- [ ] No memory leaks from event listeners (proper cleanup)
