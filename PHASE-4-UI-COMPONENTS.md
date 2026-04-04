# Phase 4: UI Components — Full Implementation

## Goal
Build the complete UI: new agent dialog, polished terminal, sidebar interactions, merge flow, and responsive layout.

## Prerequisites
- Phase 3 complete (stores wired to backend)

## Files to Modify

### 1. New: `src/components/NewAgentDialog.tsx`
- Modal dialog for creating a new agent
- Fields:
  - **Repository path**: file picker using `@tauri-apps/plugin-dialog` open()
  - **Branch name**: text input with validation (no spaces, valid git branch chars)
  - **Prompt**: multiline textarea for the Claude Code prompt
  - **Name** (optional): defaults to `agent-{branch}`
- On submit: call `spawnAgent()`, close dialog, select the new agent
- Validation: repo must be a git repo, branch name must be unique among active agents
- Keyboard: Enter to submit, Escape to close

### 2. `src/components/Terminal.tsx` — Polish
- Fix the output tracking: use `createEffect` with `on()` to track array length changes properly
- Add ANSI color support (Claude Code outputs colored text) — xterm.js handles this natively, just ensure we're not stripping escape codes
- Add search: Ctrl+F opens xterm.js search addon
- Add copy: selection auto-copies to clipboard
- Handle large output: virtualize if > 50K lines (xterm.js handles this internally)
- Add "scroll to bottom" button when user scrolls up
- Add "Clear" button in AgentPanel header

### 3. `src/components/Sidebar.tsx` — Interactions
- Right-click context menu on agent: Kill, Restart, Pause/Resume, Delete, Open in Finder
- Drag to reorder agents (optional, nice-to-have)
- Filter/search bar at top
- Status count footer: "3 running, 1 done, 1 error"
- Animate status badge color transitions
- Double-click agent name to rename

### 4. `src/components/AgentPanel.tsx` — Info Header
- Show elapsed time (running) or total time (done)
- Show branch ahead/behind status
- Show prompt (collapsible)
- Add pause/resume button
- Add "Open in Terminal" button (opens worktree path in macOS Terminal.app)

### 5. `src/components/MergeBar.tsx` — Merge Flow
- Diff viewer: syntax-highlighted diff (use a lightweight diff viewer, or render in xterm with git diff --color)
- Target branch dropdown (not just "main" — let user pick)
- Show merge conflict warning if detected
- After merge: show success toast, option to delete agent/worktree
- Loading state during merge

### 6. `src/components/Layout.tsx` — Responsive
- Resizable sidebar (drag handle)
- Persist sidebar width to localStorage
- Keyboard navigation: Cmd+1-9 to switch agents, Cmd+N for new agent
- Empty state when no agents exist (onboarding message)

### 7. `src/App.tsx` — Wire New Dialog
- Add NewAgentDialog with show/hide state
- Wire `onNewAgent` to open the dialog
- Add global keyboard shortcuts

## UnoCSS Additions
- Add animations for status badge transitions
- Add scrollbar styling (thin, dark)
- Add focus ring styles for accessibility

## Acceptance Criteria
- [ ] Can create a new agent via dialog with repo picker
- [ ] Terminal shows colored Claude Code output
- [ ] Can search within terminal output
- [ ] Right-click context menu works on sidebar agents
- [ ] Merge flow shows diff and allows target branch selection
- [ ] Sidebar is resizable
- [ ] Keyboard shortcuts work (Cmd+N, Cmd+1-9)
- [ ] Empty state shows when no agents exist
