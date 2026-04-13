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
- [X] Interrupting turn causes a scroll movement
- [X] Option + arrow to move in terminal command isn't working
- [X] Worktrees should be under the project folder not Desktop
- [X] Move default branch to project settings
- [-] Resolve conflicts button not showing
- [X] Keep cursor placement when navigating between files
- [X] Persist undo/redo actions in files
- [X] Show path on the top of open file
- [X] Type overlay showing on top of error, merge and restyle both overlays and editor errors
- [X] Persist current message in task
- [X] Find in session
- [X] @mentioned files ship in input and sent messages
- [X] Media viewer & markdown preview (WYSIWYG)
- [X] Right-clicking selected code in the editor deselects it, making "Copy" from the context menu impossible without keyboard shortcut
- [X] "Copy Absolute Path" in the file tree context menu is broken
- [X] Reload open(ed) files cach on app lifecycle change
- [X] Speed up the hover over files/list tiles everywhere
- [X] esc to close all context menus
- [X] CMD+Number not same order as ui
- [X] Sessions history

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
- [X] Multi window support
- [X] Setup script: Option/script to auto-copy .env and other files
- [X] Auto-update
- [X] Session Status on the status tab bar

### Code Tools
- [X] File tree viewer
- [X] Code editor / viewer
- [X] TS support
- [X] Mention files in chat (@ references)
- [ ] Code review comments on diffs
- [X] Problems section

### CLI Parity
- [ ] Full Claude CLI parity (skills, slash commands, CLAUDE.md/AGENTS.md, memory)
- [X] Tokens and subscription usage display

---

## Later — Apr 28 – May 11

Important but not blocking daily use.

### UX Polish
- [ ] Better plan mode
- [ ] Micro animations and transitions
- [ ] Keybindings (customizable keyboard shortcuts)
- [ ] Scroll affordance when session tabs overflow
- [ ] "Open in…" context menu submenu listing all configured editors instead of hardcoded "Open in VS Code"
- [ ] "Reveal in Finder" should open the parent folder with the file highlighted, not open the file itself
- [ ] Show file errors in warnings in the scrollbar
- [ ] "Hide whitespace changes" toggle in the Changes pane has no effect
- [ ] Image attachments on past user messages disappear after restart — only the attachment names are persisted in `output_lines`, the bytes are dropped, so thumbnails go missing on rehydrate. Persist bytes in a per-session attachments dir and rehydrate on load.

### Quality & Accessibility
- [ ] Error recovery with guided messages (replace raw technical strings)
- [ ] Help panel and keyboard shortcut overlay
- [ ] ARIA labels and tab order management
- [ ] Accessibility audit
- [ ] Voice mode

---

## Future

Bigger bets, not yet scheduled.

- [ ] Multi-provider support (Copilot, OpenCode, Gemini CLI, etc.)
- [ ] Mobile companion app
- [ ] Status page tracking
- [ ] Project icons / favicons
- [ ] Integrations
