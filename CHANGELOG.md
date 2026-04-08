# Changelog

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
