# Changelog

## Unreleased

- Fix setup script opening a terminal in the wrong task when the user navigates away before the hook starts - terminal panel now only auto-shows if the task is still selected
- Fix clicking a notification not selecting the source task - visibility change was clearing the nav map before the click handler could consume it
- Fix single-line text selection invisible in code editor - active line highlight now suppresses when text is selected so drawSelection's selection layer is visible
- Rewrote bash policy engine to use AST-based shell parsing (yash-syntax) instead of substring matching - handles compound commands, subshells, combined flags, and wrapper programs (env, sudo, bash -c)
- Normal mode now blocks destructive git ops: branch delete, worktree remove/prune, stash drop/clear, tag delete, remote remove, reflog expire, gc --prune, filter-branch, update-ref -d, push --force-with-lease
- Normal mode now blocks gh repo/release delete and detects dangerous commands inside shell re-invocations
- `git worktree prune/remove` and `rm` targeting `.verun` directories are now hard-blocked regardless of trust level - Verun manages worktree lifecycle, not Claude
- Policy engine now strips `git -C <path>` flags to detect cross-repo worktree attacks
- Fix archiving a task from the GitActions replacement button not closing the task panel - deselection now happens inside `archiveTask` so all callers get it
- Fix slow pasting of long text in session composer - disable spellcheck/autocorrect overhead, use Range API for large pastes (>10KB) while keeping `execCommand` + native undo for normal-sized pastes
- Fix slow pasting of long text in shell terminals - use `term.paste()` for bracketed paste support and rAF-batch `pty-output` writes to prevent render storms
- Cmd+F / Ctrl+F search in shell terminals - highlights matches, Enter/Shift+Enter to navigate, Escape to dismiss
- Demo mode: set `VITE_DEMO_MODE=true` to populate the app with dummy projects, tasks, sessions, and a realistic chat conversation for screenshots
- Fix message role corruption when switching between tasks - clear stale output data before reloading and use reactive Switch/Match for block type rendering so reconcile merges can't produce wrong role display
- Fix "delete branch with merge" failing because `gh pr merge --delete-branch` tries to checkout main, which conflicts with the main worktree - now deletes the remote branch separately after merge

## 0.6.0 — 2026-04-14

- Plan approval prompt no longer appears falsely when navigating back to a task with plan mode toggled on but no plan generated
- CMD+P now correctly focuses an already-open file tab even when the session view is active
- Git action messages (rebase, PR creation) now use the project's configured base branch instead of letting Claude default to main
- Git actions show "Archive" as the primary action when a PR is merged, replacing the empty button area
- Scroll-to-bottom button appears in the bottom-right corner of the session when scrolled up
- Hide copy and fork buttons on the currently streaming assistant message - completed turns still show their buttons
- Fix messages rendering with the wrong role (user as agent, agent as user) when switching between sessions/tasks with similar output lengths - ChatView block rebuild now tracks session ID, not just item count
- Plan review overlay now stays within the session pane instead of overflowing behind the sidebar and right panel
- Clicking a project header no longer collapses other empty projects — removed stale "selected project" gating that hid the "+ New task" hint on non-selected empty projects
- Clicking a macOS notification now navigates directly to the relevant task and session - migrated from `mac-notification-sys` to `tauri-plugin-notifications` (Choochmeque), which uses `UNUserNotificationCenter` via Swift FFI for native click callbacks via `onNotificationClicked`; JS-side Map tracks notification IDs to task/session pairs for navigation on click; session selection uses a `pendingSessionNav` signal consumed after session loading completes, preventing a race where the effect defaulted to the first session
- Notification permission toast "Enable" button now properly persists the enabled preference and guards `onDismiss` from racing with the enable callback
- Task and session unread indicators now only appear when a session finishes (status → idle/error), not after every streamed chunk or tool call
- Update notification converted from a top bar to a dismissible bottom-right toast; dismissing during a download hides the toast without cancelling the download, and the restart prompt re-appears automatically once the download completes
- Normal trust level now auto-allows non-destructive `git push` — only `git push --force`, `-f`, and `--delete` still require approval
- Fork a session from a past assistant message: hover any assistant reply to fork in this task (rewinds the chat, keeps current code), or fork to a new task with the worktree restored to the code as it was at that message (true counterfactual) or seeded from the parent's current code
- Per-turn worktree snapshots taken at every assistant turn end via git plumbing (commit-tree against a temporary index), anchored under `refs/verun/snapshots/` so they survive `git gc`
- Replaced vtsls with tsgo (`@typescript/native-preview`) as the bundled language server. Per-task LSP RSS drops from ~3 GB to ~70-300 MB on a real monorepo. Source-file diagnostics now flow through a pull→push translation shim in `src/lib/lsp.ts` because tsgo only supports `textDocument/diagnostic` (pull) for source files; the Problems panel store gets a parallel input channel for the synthesized notifications.
- Project-wide Problems panel population via debounced `tsgo --noEmit` shellout. New `tsgo_check` Rust module walks every `tsconfig.json` in the worktree (skipping `node_modules`, hidden dirs, and build output like `dist`/`.next`/`.turbo`), spawns `tsgo --noEmit --pretty false -p <config>` against each with concurrency bounded to 4, and aggregates the deduped results into a single Tauri event. Triggered once on LSP start and re-fired 3s after `file-tree-changed` events on `.ts/.tsx/.js/.jsx` files. Files currently open in an editor stay owned by the LSP shim — the project-wide check skips them so it can't overwrite a more responsive in-flight result. Known limitation: tsgo does not yet support tsserver language-service plugins, so projects using Next.js's `"plugins": [{"name": "next"}]` (or Apollo, styled-components, etc.) will see spurious errors for types those plugins synthesize in-memory. Running `pnpm build` once materializes Next.js's `.next/types/` files and resolves most of its false positives until tsgo ships plugin support.
- Dev builds now use a separate bundle identifier (`com.softwaresavants.verun.dev`) and product name ("Verun Dev"), so dev and released apps have isolated SQLite databases and app data dirs — no more "migration N was previously applied but is missing" panics when running a released build after a newer dev session. Run dev with `pnpm tauri dev --config src-tauri/tauri.dev.conf.json` (or `make dev`).
- Diffs now open exclusively as full-size tabs in the main editor panel — clicking a file in the Changes pane opens a side-by-side diff (backed by `@codemirror/merge`) with syntax highlighting, search, and folding, instead of expanding an inline diff in the sidebar. Double-click pins the tab. Works for both working-tree changes and files inside any branch commit; toggleable inline view; tabs persist across reloads. The old inline diff renderer (custom hunk view, expand-context buttons, word-wrap and hide-whitespace toggles) has been removed.

## 0.5.0 — 2026-04-13

### Changes

- Add project dialog now always applies the user's edits to hooks, fixing a bug where clearing pre-populated fields from .verun.json had no effect
- Auto-detect section and "Or configure manually" label are hidden when .verun.json already provides hooks
- Persist `claude_session_id` eagerly from the `system.init` event at stream start instead of only after process exit - prevents session context loss on crashes, aborts, or abnormal exits
- Markdown images now render in chat, plan review, file preview, and file mention popups - local image paths are resolved to Tauri asset:// URLs via `convertFileSrc`
- File links in markdown are now clickable - relative paths open in Verun's file viewer instead of the browser, especially useful in plan review where links were previously inert

## 0.4.4 — 2026-04-12

### Changes

- Right-clicking a text selection in the editor now preserves the selection if the click lands inside it, so "Copy" from the context menu works instead of collapsing the cursor
- Editor context menu actions (Cut/Copy/Paste/Select All) now refocus the editor after dismissal so the selection stays visually active and keyboard shortcuts keep working
- File tree "Copy Absolute Path" now reads the worktree path synchronously from the store, fixing a silent clipboard failure caused by losing user-activation across an await
- Update banner now reflects checking / up-to-date / error states so "Check for Updates…" gives visible feedback instead of silently doing nothing when already on the latest version
- User message image attachments now render as small thumbnails above the chat bubble instead of inside it
- Click any image attachment thumbnail (in chat history or in the composer preview row) to open it full-screen, with one-click Copy to clipboard and Download to disk
- Image attachments are kept as raw `Uint8Array` bytes in the frontend (rendered through blob URLs instead of base64 `data:` URLs); the new copy and save commands use Tauri's raw-binary IPC instead of shipping a base64 string
- File editor background now matches the session chat background (`--surface-0`), and the surface palette is exposed as CSS variables so a future light theme can swap them at runtime without rebuilding
- Right pane (Changes/Files) background now matches the left sidebar (`--surface-1`) instead of blending into the editor
- Task top bar redesigned: smaller title, editor button collapsed to an icon-only control with a picker caret, git actions promoted from inside the Changes pane so they're always reachable, and the terminal toggle now uses an actual terminal icon with an active-state tint
- Top-bar controls share a `toolbar-btn` / `toolbar-chrome` UnoCSS shortcut and use a 1px `white/8` ring instead of borders, so future controls plug into the same chrome
- Tab bar redesigned: pill-shaped session/file tabs replaced with flat slabs that share a baseline with the editor panel, plus button collapsed to an icon and pinned to the start of the row, "+ New" label removed, scrollbar hidden, and the active tab gets a rounded `surface-0` body framed by an inset `white/8` outline that breaks into the editor panel below
- Editor/chat panel below the tab bar now has its own rounded `surface-0` chrome with `white/8` borders on three sides, framing the active tab as a continuous "tab pane"
- Session tabs render the official Claude mark from simple-icons (`#D97757`); unread non-running sessions get a slow accent pulse instead of a dot
- Breadcrumb bar in the file viewer no longer paints its own grey background — it now sits on the editor's `surface-0`
- Left sidebar redesigned: redundant "PROJECTS" header removed, project rows turned into uppercase section labels with a per-project colored chip (deterministic 18-color palette hashed from project id), task tiles got a single inset accent strip on selection (replacing the previous border + tinted bg + radius hacks), the archive button absolute-positioned so the title row uses the full width, and the footer collapsed from two rows of icon+label into a compact icon-only strip
- Hover transitions stripped from dense list elements (tabs, sidebar rows, file tree) — feedback is now instant instead of fading over 150ms
- Shared `ContextMenu` component (and `ContextMenuItem` type) replaces five hand-rolled context menu blocks across Sidebar, TaskPanel (file tabs), CodeEditor, FileTree, and ProblemsPanel; supports `icon`, `shortcut`, `danger`, `disabled`, and `separator` items, all sharing the new `surface-2` + `white/8` ring chrome
- Problems pane redesigned: lucide severity icons (`XCircle`/`AlertTriangle`/`Info`) replace ASCII chars, error/warning counts in file headers are now color-tinted, hover surfaces unified to `surface-2`, severity icons aligned with the file icon column, and the context menu uses the shared component
- File tree: active (currently-open) file gets the same inset accent strip as the selected sidebar task, selected and active rows share `surface-2` instead of stacking two different greys, folder icons toned down from accent green to `text-text-dim`, and the indent step tightened from 16px to 12px
- Top-bar git divider/section now hides when there's nothing to ship (no PR, no commits, no dirty files) — no more orphaned divider pair
- Top-bar control gap bumped from `gap-1` to `gap-2` so the editor / Start / Terminal cluster has breathing room
- Changes pane redesigned: header rows merged into a single h-9 strip with stats on the left and view toggles on the right, borders unified to `white/8`, open file row now uses `surface-2` plus an inset accent strip (matching the file tree's open file and the sidebar's selected task), selected commit and "Uncommitted changes" tile use the same accent-strip pattern instead of the heavy `bg-accent-muted`, file rows now follow VS Code's source-control style (file type icon on the left, status letter `M`/`A`/`D`/`R`/`U` on the right with the status color, no font-mono path), `transition-colors` removed from rows, and the uncommitted-changes circle no longer flashes amber
- Shell PATH capture upgraded from `-lc` to `-lic` so `.zshrc` (where nvm/fnm/asdf/mise live) is sourced — claude, the language server, git, and gh now see the user's nvm-default node version instead of an outdated system one
- New `env_path` module with a background watcher that reloads PATH when the integrated terminal goes idle after a user-committed command (tmux-style: tracks the last PTY output byte and waits for 500ms of silence after a `\n`/`\r` from the user). Window focus also triggers a debounced reload (≥30s) to catch installs done in an external terminal. Both auto-paths funnel through the same `reload_env_path` IPC command, so a manual escape hatch is one wire away

## 0.4.3 — 2026-04-12

### Changes

- Right sidepane (Changes/Files) now defaults to a narrower width and is drag-resizable like the left sidebar, with width persisted across launches
- Merged editor hover into a single tooltip — diagnostic message on top, type info below — instead of stacking the LSP type popup on top of the error popup
- "Ask agent to fix" button in the diagnostic hover — prefills the message input with a templated request referencing the current file, switches to the session tab, and focuses the input; sending is left manual
- LSP server start failures, `window/showMessage` errors, and unexpected vtsls process exits now surface as 10s dismissible toasts instead of being silent
- Reload open file tabs from disk when Verun regains focus; toast for dirty tabs that diverged externally, and prompt to overwrite or discard at save time
- Instant hover feedback on list rows and tiles — removed the 150ms fade
- Escape key closes any open context menu, dropdown, or popover
- Fix CMD+Number task selection order to match the sidebar when multiple projects are open (iterate projects then tasks within each, instead of flat insertion order)
- Draft message, attachments, mode switches (plan/thinking/fast), and last selected task now persist across app restarts
- Switched bundled LSP from typescript-language-server to vtsls for project-wide diagnostics support
- Problems panel — collapsible section at the bottom of the Changes/Files pane showing project-wide TypeScript diagnostics via `enableProjectDiagnostics`, grouped by file with resizable height
- Click any problem to jump to the exact line and column in the editor
- Command palette (CMD+Shift+P) with restart TypeScript server, open settings, open archived, and start dev server
- File tree and open file tabs highlight red for files with errors, yellow for warnings
- Folders in the file tree highlight when any descendant file has errors
- Find in session (Cmd+F) — search through chat messages with match highlighting and navigation
- Fix project-wide diagnostics not loading — transport-level handling of vtsls `workspace/configuration` requests so `enableProjectDiagnostics` takes effect during initialization, not after
- Fix diagnostics batch crash when first problems arrive for a task
- Problems panel skips gitignored files — uses `git check-ignore` to respect `.gitignore`, `.git/info/exclude`, and global ignore patterns
- @mentioned files render as inline badges in the input and sent messages — hover to preview with syntax highlighting, click to open in the editor
- Media viewer — images, video, and audio files open natively from the file tree with proper rendering instead of failing as binary
- Markdown preview — `.md` files render as styled WYSIWYG with a preview/edit toggle to switch between rendered output and the code editor
- SVG viewer — `.svg` files render visually with a preview/edit toggle for the XML source
- Hover previews on @mentioned files now support media (images, video, audio), rendered markdown, and SVG visual previews
- Cursor position, selection, and scroll position are preserved when switching between file tabs
- Undo/redo history persists across tab switches — Cmd+Z works on the full edit history after switching back
- Breadcrumb path bar at the top of the editor — click any segment to see sibling files/folders and jump to them
- Open tabs, active file, and MRU stack persist to localStorage per task — survives app restart
- Editor auto-focuses when switching tabs so the cursor is visible and keyboard input works immediately
- Fix closing a dirty tab without saving showing stale edits when reopened
- Multi-window support — pop out any task into its own window via double-click, right-click "Open in New Window", or Cmd+Shift+N to create a new task in a dedicated window (setup hooks in task windows coming later)

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
