# Phase 3: Frontend State & IPC Integration

## Goal
Wire the Solid.js stores and hooks to the Rust backend so the UI reflects real agent state.

## Prerequisites
- Phase 2 complete (Rust backend fully functional)

## Files to Modify

### 1. `src/store/agents.ts` — Agent Store
- On app mount, call `listAgents()` IPC to hydrate store from SQLite
- Listen to `agent-status` Tauri event to update agent status in real-time
- Add `removeAgent(id)` action that calls `delete_agent` IPC and removes from store
- Add `pauseAgent(id)` / `resumeAgent(id)` actions
- Ensure all mutations go through `setAgents` with proper reconciliation (use `produce` from solid-js/store)

### 2. `src/store/sessions.ts` — Session Store
- On agent select, call `getSession(agentId)` to load historical output
- Listen to `agent-output` Tauri event to append new lines
- Implement line cap: keep only last 50K lines in memory, older lines stay in SQLite
- Add `clearSession(agentId)` to free memory when switching away from an agent

### 3. `src/hooks/useAgent.ts` — Agent Hook
- Already listens to events — extend with:
  - Hydration on mount (load from backend)
  - Error handling: show toast/notification on spawn failure
  - Batch status updates if multiple agents change at once
- Add `pause` and `resume` methods

### 4. `src/hooks/useWorktree.ts` — Worktree Hook
- Add `getRepoInfo(path)` to get branch list for UI dropdowns
- Add `getBranchStatus(worktreePath)` to show ahead/behind in AgentPanel header

### 5. `src/lib/ipc.ts` — IPC Wrappers
- Add new commands matching Phase 2 additions:
  - `pauseAgent`, `resumeAgent`, `getAgent`, `deleteAgent`, `getRepoInfo`
- Add error types and consistent error handling (all IPC calls should catch and surface errors)

### 6. New: `src/store/ui.ts` — UI State
- Create store for UI-only state:
  - `sidebarWidth: number` (resizable sidebar)
  - `showNewAgentDialog: boolean`
  - `toasts: Toast[]` for notifications
  - `theme: 'dark'` (future: light mode)

## Testing Strategy
- Mock Tauri `invoke` and `listen` in unit tests
- Test store reactivity: simulate events, verify state updates
- Test edge cases: agent dies mid-stream, rapid spawn/kill

## Acceptance Criteria
- [ ] Opening the app shows previously created agents from SQLite
- [ ] Selecting an agent loads its output history
- [ ] Real-time output appears as agent runs (no polling)
- [ ] Status badges update in sidebar when agent state changes
- [ ] Kill/restart from UI works and updates all stores
- [ ] No memory leaks from event listeners (proper cleanup)
