# Phase 4: UI Components — Full Implementation

## Goal
Build the complete UI: project/task management, polished terminal, sidebar interactions, merge flow, and responsive layout.

## Prerequisites
- Phase 3 complete (stores wired to backend)

## Files to Modify

### 1. New: `src/components/NewTaskDialog.tsx`
- Modal dialog for creating a new task within a project
- No fields needed �� task is created with auto-generated funny branch name
- On submit: call `createTask(projectId)`, close dialog, select the new task, auto-start a session
- Show the generated branch name after creation
- Keyboard: Enter to submit, Escape to close

### 2. New: `src/components/AddProjectDialog.tsx`
- Modal dialog for adding a repo to Verun
- Fields:
  - **Repository path**: file picker using `@tauri-apps/plugin-dialog` open()
- On submit: call `addProject(repoPath)`, close dialog, select the new project
- Validation: path must be a valid git repo (backend validates via `get_repo_root`)
- Keyboard: Enter to submit, Escape to close

### 3. `src/components/Terminal.tsx` — Polish
- Fix the output tracking: use `createEffect` with `on()` to track array length changes properly
- Add ANSI color support (Claude Code outputs colored text) — xterm.js handles this natively, just ensure we're not stripping escape codes
- Add search: Ctrl+F opens xterm.js search addon
- Add copy: selection auto-copies to clipboard
- Handle large output: virtualize if > 50K lines (xterm.js handles this internally)
- Add "scroll to bottom" button when user scrolls up
- Load historical output from SQLite when viewing a past session

### 4. `src/components/Sidebar.tsx` — Project & Task Navigation
- Two-level navigation: projects → tasks
- Click project to expand/collapse its task list
- Click + on project header to create new task
- Click + at top level to add new project
- Right-click context menu on task: Stop Session, Delete Task, Open in Finder
- Right-click context menu on project: Delete Project, Open in Finder
- Status badges on tasks (derived from latest session status)
- Status count footer: "3 running, 1 done, 1 error"

### 5. `src/components/TaskPanel.tsx` (replaces AgentPanel.tsx)
- Session tabs along the top — one tab per session in the task
- "New Session" button to start another Claude session in the same worktree
- Per-session: show elapsed time (running) or total time (done)
- Show branch name and ahead/behind status
- Show task name (or "Unnamed" until Claude derives it)
- Resume button for idle sessions with a claude_session_id
- Stop button for running sessions
- "Open in Terminal" button (opens worktree path in macOS Terminal.app)

### 6. `src/components/MergeBar.tsx` — Merge Flow
- Diff viewer: syntax-highlighted diff (use a lightweight diff viewer, or render in xterm with git diff --color)
- Target branch dropdown (list branches from `getRepoInfo`)
- Show merge conflict warning if detected
- After merge: show success toast, option to delete task/worktree
- Loading state during merge

### 7. `src/components/Layout.tsx` — Responsive
- Resizable sidebar (drag handle)
- Persist sidebar width to localStorage
- Keyboard navigation: Cmd+1-9 to switch tasks, Cmd+N for new task
- Empty state when no projects exist (onboarding: "Add a repo to get started")
- Empty state when project has no tasks ("Create a task to start working")

### 8. `src/App.tsx` — Wire Dialogs
- Add NewTaskDialog and AddProjectDialog with show/hide state
- Wire keyboard shortcuts
- Load projects on mount

## UnoCSS Additions
- Add animations for status badge transitions
- Add scrollbar styling (thin, dark)
- Add focus ring styles for accessibility

## Acceptance Criteria
- [ ] Can add a project via repo picker
- [ ] Can create a task (gets auto branch name, starts first session)
- [ ] Can start additional sessions within a task
- [ ] Can resume a previous session
- [ ] Terminal shows colored Claude Code output
- [ ] Can search within terminal output
- [ ] Right-click context menu works on sidebar items
- [ ] Merge flow shows diff and allows target branch selection
- [ ] Sidebar is resizable
- [ ] Keyboard shortcuts work (Cmd+N, Cmd+1-9)
- [ ] Empty states show appropriate onboarding messages
