# Changelog

## Unreleased

### Changes

- Switched bundled LSP from typescript-language-server to vtsls for project-wide diagnostics support
- Problems panel — collapsible section at the bottom of the Changes/Files pane showing project-wide TypeScript diagnostics via `enableProjectDiagnostics`, grouped by file with resizable height
- Click any problem to jump to the exact line and column in the editor
- Command palette (CMD+Shift+P) with restart TypeScript server, open settings, open archived, and start dev server
- File tree and open file tabs highlight red for files with errors, yellow for warnings
- Folders in the file tree highlight when any descendant file has errors
- Find in session (Cmd+F) — search through chat messages with match highlighting and navigation

## 0.4.2 — 2026-04-11

### Changes

- Clean DMG installer — removed stray .VolumeIcon.icns file, resized window for better icon centering
- Setup hooks now stream live output into an xterm.js terminal tab instead of showing a blind spinner — see exactly what your hook is doing as it runs
- Hook terminal tabs appear first in the terminal panel with status indicators (spinner while running, green check on success, red alert on failure)
- Stop a running setup hook mid-execution with the new Stop button in the setup banner
- Re-run failed or completed setup hooks from the banner or terminal tab
- Manual hook execution via new run_hook/stop_hook IPC commands for both setup and destroy hooks
- PTY exit events now include the process exit code for richer status reporting
- Start/Stop button in the task header to run the start command in a read-only "Dev Server" terminal tab (always first tab)
- Start command terminals detect when the process exits (Ctrl+C, crash) and transition to stopped state — input is blocked after exit
- Auto-start toggle in project settings and add-project dialog (off by default) — when enabled, the start command runs automatically for new tasks
- Adding a project via manual config now auto-opens the new task dialog so you can start working immediately
- Fix deleting a project not clearing the selected task/session when the open task belonged to that project
- Rename tasks from the right-click context menu
- Auto-name tasks on every new message while the name is still blank, not just the first message
- Add project dialog pre-populates hook fields from .verun.json when one exists in the repo

## 0.4.1 — 2026-04-11

### Changes

- Static release filenames — download URLs no longer change between versions
- Cmd+hover underline in code editor — holding Cmd while hovering over a symbol shows a VS Code-style underline and pointer cursor, signaling it's clickable for go-to-definition

## 0.4.0 — 2026-04-10

### Changes

- Auto-update — checks for updates on launch, shows a non-intrusive banner with download progress and one-click restart; also available via Verun > Check for Updates menu item; CI pipeline now generates signed updater artifacts and latest.json for all platforms
- Steps — plan follow-up messages in a step list above the input. Enter adds a paused step while Claude is working, Shift+Enter adds an armed step (auto-sends on idle). Cmd+Enter fires the next step when idle or redirects when running. Steps persist across sessions and app restarts. Drag to reorder, click to arm/disarm.
- Unread indicator on session tabs — accent dot appears when a non-selected session receives new output, cleared on selection
- Fix merge PR showing error toast when main branch is checked out in another worktree
- Archive tasks instead of deleting — stops sessions and closes terminals but keeps the worktree, branch, and DB records; archived tasks live on a separate Archived page accessible from the sidebar footer; spinner shows on the task row while archiving is in progress; CMD+number only counts active tasks
- Per-language file icons — TypeScript, JavaScript, React, Rust, Python, Go, Java, Ruby, PHP, C/C++, Swift, Kotlin, C#, Lua, Shell, HTML, CSS, Sass, Vue, Svelte, JSON, TOML, YAML, Markdown, and more — with official brand colors, shown in file tree, tabs, quick open, and file mentions
- Context menus on file tree and file tabs now work — clicks were being swallowed by Solid's event delegation before the handler could fire
- Tab bar auto-scrolls to the active file tab when opening a file
- Reveal file in tree — opening a file expands its parent directories, scrolls the file tree to it, and briefly highlights the row
- Base branch selector moved from sidebar context menu to project settings page for discoverability
- LSP always installed — moved language server install to postinstall hook so it runs on every `pnpm install` (local and CI), not just during production builds
- Token and cost usage display — per-turn cost + tokens shown next to duration on assistant messages, cumulative session cost in tab pills, and usage chip in the input toolbar with popover showing session stats and subscription reset timer
- Autodetect prompt rewritten — covers .env.example fallback, destroy hook for env file preservation, orchestrator passthrough config, inter-service URL rewriting, and explicit all-service port mapping
- OS notifications — macOS desktop notifications when tasks complete, fail, or need approval; suppressed when the task is already in view; toggle in Settings
- Unread / attention-required indicators on sidebar tasks — amber pulsing dot when a tool approval is pending, accent dot when new output arrives on a background task; cleared on task selection
- Non-blocking setup hooks — worktree creation returns instantly, setup hook runs in background so the chat UI appears immediately
- Message queuing during setup — type and send your first prompt while the hook runs, it auto-sends on completion
- Setup progress banner — slim inline indicator replaces the old full-screen spinner, with error state on failure
- Quick Open (CMD+P) — fuzzy file finder for jumping to files in the worktree, virtualized for large repos
- LSP integration — bundled typescript-language-server for autocomplete, diagnostics, hover, go-to-definition (F12 / CMD+Click), find references (Shift+F12), rename (F2), and format (Shift+Alt+F)
- LSP auto-restart — language server restarts when node_modules changes (e.g. after pnpm install)
- VS Code-style search panel — floating top-right widget with toggle buttons (Aa/W/.*), match counter, expand/collapse replace row
- File tree viewer — gitignore-aware directory browser with lazy loading, virtualized rendering, filesystem watching, and context menus
- Code editor — CodeMirror 6 with One Dark syntax highlighting, code folding, 15+ language modes, context menu with LSP actions
- Right panel tabs — Changes and Files tabs in the collapsible right panel
- Unified tab bar — sessions and editor file tabs share one tab bar in the main area; clicking a session shows chat, clicking a file shows the editor
- Per-task editor tabs — each task has its own set of open files; switching tasks preserves editor state
- Preview tabs — single-click opens a transient tab (italic) that gets replaced; double-click, editing, or saving pins it
- MRU tab switching — Ctrl+Tab goes to the last used tab, not the next in order
- Editor content caching — switching between tabs is instant with no loading flicker
- Editor tab management — open/close/reopen tabs, unsaved changes confirmation, tab context menu (Close, Close Others, Close All, Copy Path), CMD+W close, CMD+Shift+T reopen
- File tree context menu — open, copy path, reveal in Finder, refresh, collapse/expand
- CMD+E to toggle between Changes and Files panel
- Fix `.verun` folder location — worktrees now created inside the project directory, not the parent
- Project lifecycle hooks — setup hook runs after worktree creation, destroy hook before deletion, start command auto-runs in terminal
- Per-task port allocation — 10 unique ports (VERUN_PORT_0–9) and VERUN_REPO_PATH injected into all processes
- Auto-detect with Claude — analyzes project structure, detects env files, monorepo ports, and generates hooks
- `.verun.json` config file — shareable project config for hooks, auto-loaded when adding a project
- Settings page redesign — sidebar nav with General + per-project sections for hook configuration
- Project creation dialog — configure hooks on add, with auto-detect option
- Import/Export buttons — sync hooks between DB and `.verun.json` for team sharing
- Auto-expanding code textareas for hook editors with shell-like styling
- Keyboard shortcuts in settings — CMD+S to save, CMD+Enter in fields, CMD+Number to switch sections
- Hooks auto-applied from `.verun.json` when Claude session completes
- Fix Option+Arrow producing garbled characters instead of word navigation in terminal
- Turn duration — shows how long each turn took next to the copy button on hover

## 0.3.0 — 2026-04-08

### Changes

- Fix scroll jump when interrupting a turn
- Resolve user's login shell PATH at startup so bundled .app can find claude, git, etc.
- Cross-platform support for Windows, Linux, and macOS
- Platform-specific tauri config with macOS overlay titlebar override
- Keyboard shortcuts use Ctrl on Windows/Linux, Cmd on macOS
- Platform-adaptive clipboard, file manager, and shell commands
- Cross-platform terminal fonts and xterm options
- Conditional drag regions for macOS overlay titlebar
- Fix window drag using data-tauri-drag-region attribute
- Fix double-click maximize bouncing
- Multi-platform release builds: macOS ARM/Intel DMG, Windows .exe, Linux AppImage

## 0.2.1 — 2026-04-08

### Changes

- macOS code signing and notarization for GitHub releases

## 0.2.0 — 2026-04-08

### Changes

- Integrated terminal with PTY backend and per-task shell sessions
- Branch commits panel — view and diff individual commits
- Git actions overhaul with PR caching and commit count awareness
- Thinking and fast mode toggles, per-task input state
- Model selection scoped per task instead of per session
- Fix release workflow changelog extraction

## 0.1.1 — 2026-04-08

### Changes

- Automated GitHub release workflow — builds macOS ARM on push when VERSION changes
- `/bump-version` command to update version across all project files
- Settings: configurable defaults for word wrap and hide whitespace in diffs
- Sticky file headers when scrolling through expanded diffs
- Smart git action buttons — hide Push, Create PR, Merge PR, Review based on actual state
- Filter out directories from file changes list
- Conflict resolution uses rebase instead of merge

## 0.1.0 — 2026-04-07

Initial release of Verun — parallel Claude Code session orchestrator for macOS.

### Core
- Project management with git repo integration
- Task system with isolated git worktrees and auto-generated branch names
- Resumable Claude Code CLI sessions with multiple sessions per task
- Real-time streaming output with stdout/stderr buffering

### Chat & AI
- Full chat UI with Claude Agent SDK streaming
- Model selection (Opus, Sonnet, Haiku) per session or global
- Slash command support forwarded to Claude CLI
- Plan mode for reviewing and approving implementation plans
- Tool approval system with configurable trust levels (Normal, Supervised, Full Auto)
- Interactive question handling (AskUserQuestion)
- Thinking block display with collapsible sections

### Code Changes
- Git status with inline unified diffs and syntax highlighting
- Expandable diff context (load above/below)
- Word wrap and hide-whitespace toggles with configurable defaults
- Sticky file headers when scrolling through diffs
- Smart git actions: Commit, Push, Create PR, Merge PR, Review
- GitHub PR status, CI checks display, and direct links
- Conflict resolution via rebase

### UI
- Native macOS app with transparent titlebar
- Customizable accent color themes
- Resizable sidebar with project/task tree
- Terminal rendering via xterm.js
- Splash screen to prevent unstyled content flash
- Toast notifications
- Keyboard shortcuts for common actions
- Links open in system browser

### Infrastructure
- Tauri v2 with Rust backend
- SQLite persistence with async write queue
- Pre-commit hooks with full test suite (110 Rust tests, 18 frontend tests)
- Clippy-clean, type-checked frontend
