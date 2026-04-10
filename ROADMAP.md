# Verun Roadmap

Parallel Claude Code session orchestrator for macOS. Open source at [github.com/softwaresavants/verun](https://github.com/softwaresavants/verun).

---

## Shipped

Everything below is already in the current release (v0.2.0).

### Core
- Project management with git repo integration
- Task system with isolated git worktrees and auto-generated branch names
- Resumable Claude Code CLI sessions (multiple per task)
- Real-time streaming output with stdout/stderr buffering
- Integrated terminal with PTY backend and per-task shell sessions

### Chat & AI
- Full chat UI with Claude Agent SDK streaming
- Model selection (Opus, Sonnet, Haiku) scoped per task
- Thinking and fast mode toggles
- Plan mode for reviewing and approving implementation plans
- Tool approval with configurable trust levels (Normal, Supervised, Full Auto)
- Interactive question handling (AskUserQuestion)
- Slash command support forwarded to Claude CLI

### Code & Git
- Git status with inline unified diffs and syntax highlighting
- Expandable diff context (load above/below)
- Word wrap and hide-whitespace toggles (configurable defaults)
- Sticky file headers when scrolling through diffs
- Smart git actions: Commit, Push, Create PR, Merge PR, Review
- Branch commits panel with individual commit diffs
- GitHub PR status, CI checks display, and direct links
- Conflict resolution via rebase
- PR caching and commit count awareness

### UI & Design
- Native macOS app with transparent titlebar
- Customizable accent color themes
- Resizable sidebar with project/task tree
- Status-aware sidebar icons (PR status, task state)
- New project via folder picker dropdown
- Collapsible tool calls (styled like thinking blocks)
- "Open in" button (VS Code, Cursor, Zed, Finder)
- Toast notifications and splash screen
- Links open in system browser

### Infrastructure
- Tauri v2 with Rust backend
- SQLite persistence with async write queue
- Automated GitHub release workflow (macOS ARM)
- Pre-commit hooks with full test suite (110 Rust tests, 18 frontend tests)

---

## Papercuts

Small UX issues noticed in daily use. No schedule — fix when you have a spare hour.

- [X] Loading indicator when creating a task (worktree creation can be slow)
- [X] Branch commits pane is empty after PR merge (commits moved to base branch, nothing to show)
- [X] Persist last selected model per project
- [X] Delete task option to also delete the branch
- [X] Loading state when deleting / archiving a task
- [X] Timestamp on each turn / run
- [ ] Interrupting turn causes a scroll movement
- [X] Option + arrow to move in terminal command isn't working
- [X] Worktrees should be under the project folder not Desktop
- [X] Move default branch to project settings
- [ ] Resolve conflicts button not showing

---

## Next Up — Apr 14 – Apr 27

High-impact features that engineers are asking for most.

### Session & Workflow
- [X] Refresh the state (github...) on app resume
- [ ] Subagent / nested thread visualization
- [ ] Fork task or session (branch a conversation into a new direction)
- [X] Steer & queue interaction modes (send follow-ups while the agent is working)
- [X] Unread / attention-required indicator on tasks in sidebar
- [X] OS notifications for task completion and approval prompts
- [ ] Multi window support
- [-] Setup script: Option/script to auto-copy .env and other files
- [ ] Auto-update
- [X] Session Status on the status tab bar

### Code Tools
- [X] File tree viewer
- [X] Code editor / viewer
- [X] TS support
- [X] Mention files in chat (@ references)
- [ ] Code review comments on diffs
- [ ] Problems section

### CLI Parity
- [ ] Full Claude CLI parity (skills, slash commands, CLAUDE.md/AGENTS.md, memory)
- [X] Tokens and subscription usage display

---

## Later — Apr 28 – May 11

Important but not blocking daily use.

### UX Polish
- [ ] Keybindings (customizable keyboard shortcuts)
- [ ] Micro animations and transitions
- [ ] Scroll affordance when session tabs overflow

### Quality & Accessibility
- [ ] Error recovery with guided messages (replace raw technical strings)
- [ ] Help panel and keyboard shortcut overlay
- [ ] ARIA labels and tab order management
- [ ] Accessibility audit

---

## Future

Bigger bets, not yet scheduled.

- [ ] Multi-provider support (Copilot, OpenCode, Gemini CLI, etc.)
- [ ] Mobile companion app
- [ ] Status page tracking
- [ ] Project icons / favicons
- [ ] Integrations
