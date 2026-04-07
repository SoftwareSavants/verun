# Verun Roadmap

## Tool Interactions

- [X] Tool approval
- [X] Agent questions
- [X] Auto accepting safe tool calls/commands

## GitHub Integration

- [X] GitHub integration
- [X] Changes viewer
- [ ] Code review comments

## UX & Interactions

- [ ] Remove the outline from the other option's input when answering agent
- [ ] Clicking on links navigates to them
- [ ] Persists the last selected model per project
- [ ] Creatign a new task should always start from freshly pulled based branch (e.g. main)
- [X] Interrupt not working
- [ ] Keep state of tasks when switching between them
- [ ] Need an unread/attention required indicator on tasks in sidebar
- [ ] Mention files
- [ ] Keybindings
- [ ] Micro animations

## Session Modes

- [ ] Support plan, fast, thinking mode toggles
- [ ] Steer & queue interaction modes

## Subagents

- [ ] Subagent / nested thread visualization

## Design

- [X] Overall design pass
    - [X] Sidebar has a horizontal scroll issue
    - [X] Sidebar item icons should change depending on status instead of always being a colored circle (e.g. PR icon with color for PR status)
    - [X] New project should be a dropdown instead of modal, with just an "open folder" option
    - [X] Tool calls are too noticeable — should be collapsed like thinking
    - [X] Remove path under task name; replace with an "open in" button (default: VS Code, dropdown: Cursor, Zed, Finder) that shows before the right sidebar toggle
- Error recovery (still P2): Error messages in toasts are still technical strings. No guided recovery for git failures.
- Help & docs (still P2): No formal help panel or keyboard shortcut overlay. Empty states help first-run, but returning users have no reference.
- Sidebar task creation: No loading indicator when quickCreateTask runs (worktree creation can be slow).
- Session tab overflow: No visual scroll affordance when many sessions overflow the tab bar.
- Accessibility: No ARIA labels, no explicit tab order management.

## Settings

- [ ] Wrap lines in code changes by default
- [ ] Hide whitespace by default

## Code Tools

- [ ] File tree
- [ ] Code editor/viewer
- [ ] Code linting/server

## Usage & Billing

- [ ] Tokens and subscription usage

## Claude CLI Parity

- [ ] Full Claude CLI parity (skills, slash commands, CLAUDE.md/AGENTS.md, memory)
- [ ] OS notifications for task completion & approval prompts

## Provider Flexibility

- [ ] Multi-provider support (Copilot, OpenCode, Gemini, etc.)

## Future

- [ ] Mobile app
- [ ] Status pages tracking
- [ ] Project icons/favicons
