# Verun

The open-source workspace for parallel coding agents.

Spin up multiple AI coding agents - each in its own isolated git worktree - and manage them from a single native app with a full editor, terminal, and git workflow built in. No account, no subscription, no data leaving your machine.

![Verun screenshot](screenshot.png)

## Run agents in parallel

Every task gets its own git worktree, branch, and set of ports - agents can't interfere with each other. Lifecycle hooks copy `.env` files, install dependencies, and start dev servers automatically so each agent starts ready to work. Define your setup once in a `.verun.json` and the whole team gets the same config.

## Multi-agent support

Pluggable agent backend with first-class support for Claude Code and Codex (plan mode, structured approvals, streaming, resume). Cursor and other agents coming soon.

## Stay in control without babysitting

- **Steps** - queue follow-up prompts while an agent is working; arm them to auto-send on idle, or fire manually
- **Fork from any message** - hover any past reply to rewind the conversation in place, or branch into a new task with the worktree restored to the code as it was at that exact turn. Verun takes a git snapshot at every turn, so you can undo an entire direction - not just a line of code
- **Tool approval** - configurable trust levels per task: supervised, normal, or full auto
- **UI / Terminal toggle for Claude** - flip any Claude session into a real PTY running `claude --resume` to use the unmodified TUI, while history, fork, and search keep working because Verun tails the on-disk transcript. The mode is sticky per session with an app-wide default in Settings
- **Notifications** - desktop alerts when an agent finishes, fails, or needs approval so you can context-switch away

## Full workspace, not just a launcher

- **Code editor** - CodeMirror 6 with syntax highlighting, code folding, and 15+ languages
- **TypeScript intellisense** - bundled tsgo with autocomplete, diagnostics, hover, go-to-definition, find references, and rename
- **Problems panel** - project-wide type checking with click-to-navigate and one-click "ask agent to fix"
- **Side-by-side diffs** - syntax-highlighted diffs for working-tree changes and individual commits
- **Git workflow** - commit, push, create PR, merge, and inspect branch-scoped GitHub Actions/PR state without leaving the app; remote refresh is cached and only invalidated when relevant GitHub state changes
- **Integrated terminal** - drop into any task's worktree with a built-in shell
- **File tree & Quick Open** - browse files, fuzzy-find with CMD+P, preview media and markdown inline
- **Workspace search** - Cmd+Shift+F content search across the task's worktree with case/whole-word/regex toggles and include/exclude globs, powered by embedded ripgrep
- **Multi-window** - pop any task into its own window for side-by-side work across monitors
- **Bootstrap from Better-T-Stack** - create a new project inside Verun via an in-app [Better-T-Stack](https://better-t-stack.dev) builder: big icon-and-description cards per option, a left category rail, a `~`-anchored folder picker with keyboard completion, live command preview, and `⌘↵` to scaffold. Verun runs the CLI (no install required), writes a sensible `.verun.json`, and hands off to the Add Project dialog

## Open source & local

Verun runs entirely on your machine. Sessions talk directly to the CLI - nothing is proxied, nothing phones home, nothing requires an account. Your code stays in your git worktrees, your history stays in a local SQLite database, and the source code is yours to audit, modify, and share under the AGPL-3.0.

## Download

| Platform | Link |
|----------|------|
| macOS (Apple Silicon) | [Download .dmg](https://github.com/SoftwareSavants/verun/releases/latest/download/Verun_aarch64.dmg) |
| macOS (Intel) | [Download .dmg](https://github.com/SoftwareSavants/verun/releases/latest/download/Verun_x64.dmg) |
| Windows | [Download .exe](https://github.com/SoftwareSavants/verun/releases/latest/download/Verun_x64-setup.exe) |
| Linux | [Download .AppImage](https://github.com/SoftwareSavants/verun/releases/latest/download/Verun_amd64.AppImage) |

The app auto-updates after the first install. Or browse all versions on the [Releases](https://github.com/SoftwareSavants/verun/releases) page.

### Build from source

```bash
git clone https://github.com/SoftwareSavants/verun.git
cd verun
bash scripts/setup.sh
pnpm tauri build
```

Requires [Rust](https://rustup.rs), Node.js 18+, pnpm, and Xcode Command Line Tools (macOS).

## How it works

```
Project (repo) → Tasks (worktrees) → Sessions (agent conversations)
```

Add a repo, create tasks - each gets an isolated worktree with an auto-generated branch name like `sleepy-capybara-472`. Run multiple agent sessions per task and switch between them freely.

## Stack

Tauri v2 (Rust + tokio) / Solid.js + TypeScript / UnoCSS / xterm.js / SQLite

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE)
