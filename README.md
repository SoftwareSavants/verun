# Verun

Verun is a macOS app for running multiple Claude Code sessions in parallel, each in its own isolated git workspace.

---

## Why

I was using an existing Mac app for orchestrating Claude Code in parallel.
Over time, a few things became frustrating enough to warrant building something better:

- **Performance** — switching between sessions was slow and laggy
- **Port management** — each session ran on its own port, but the app had no
  visibility or control over it
- **No persistence** — clicking on an image in a session tab would reset the
  entire session state
- **No code analysis** — no way to inspect what Claude had actually changed
  without leaving the app
- **General UX friction** — small things that added up over a full day of use

Verun is an attempt to fix all of that.

---

## What it does

- **Project-based workflow** — add a repo, create tasks, each gets its own git worktree
- **Multiple sessions per task** — run several Claude Code conversations in the same worktree
- **Resumable sessions** — sessions survive app restarts via `claude --resume`
- **Chat UI** — full conversation view with thinking blocks, tool calls, and syntax highlighting
- **Code changes** — inline diffs with syntax highlighting, expandable context, word wrap
- **Smart git actions** — commit, push, create PR, merge, review — context-aware buttons
- **Plan mode** — review and approve implementation plans before Claude starts coding
- **Tool approval** — configurable trust levels (Normal, Supervised, Full Auto)
- **Persistent history** — output stored locally in SQLite, browsable after sessions end
- **No GitHub required** — works entirely local, no tokens, no permissions
- **Funny branch names** — each task gets an auto-generated name like `sleepy-capybara-472`

---

## Concepts

| Concept | What it is |
|---|---|
| **Project** | A git repo you've added to Verun |
| **Task** | A unit of work within a project — owns a worktree and branch |
| **Session** | A Claude Code CLI session within a task's worktree (resumable) |

```
Project (repo) → Tasks (worktrees) → Sessions (Claude conversations)
```

---

## Stack

| Layer | Choice |
|---|---|
| App shell | Tauri v2 |
| Language (backend) | Rust + tokio |
| Language (frontend) | Solid.js + TypeScript |
| Styling | UnoCSS |
| Terminal | xterm.js |
| State | Solid stores + signals |
| Persistence | SQLite (sqlx + tauri-plugin-sql) |
| Package manager | pnpm |
| Workspace isolation | Git worktrees |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Verun (Tauri)                  │
│                                                  │
│  ┌─────────────┐        ┌─────────────────────┐  │
│  │  Solid.js   │  IPC   │    Rust Backend      │  │
│  │  Frontend   │◄──────►│                      │  │
│  │             │        │  task.rs    (spawn)  │  │
│  │  Sidebar    │ events │  worktree.rs (git)   │  │
│  │  TaskPanel  │◄───────│  stream.rs  (buffer) │  │
│  │  Terminal   │        │  db.rs      (sqlite) │  │
│  └─────────────┘        │  ipc.rs     (cmds)   │  │
│                          └──────────┬──────────┘  │
└─────────────────────────────────────┼─────────────┘
                                      │
              ┌───────────────────────┼───────────────┐
              │                       │               │
        git worktree 1          git worktree 2    git worktree N
        (silly-penguin-42)      (fuzzy-otter-7)   (grumpy-quokka-99)
              │                       │               │
        Claude Code             Claude Code      Claude Code
        session(s)              session(s)       session(s)
```

---

## Setup

### Prerequisites

- macOS (Apple Silicon or Intel)
- [Rust](https://rustup.rs) (stable)
- Node.js 18+
- pnpm
- Xcode Command Line Tools

### Install

```bash
git clone https://github.com/SoftwareSavants/verun.git
cd verun
bash scripts/setup.sh
```

`setup.sh` will install Rust targets, cargo-watch, and all frontend dependencies.

### Run

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

---

## Development

```bash
make dev        # start dev server
make check      # run all checks (tsc + cargo check + clippy + tests)
make test       # run Rust tests only
make lint       # run clippy only
```

A task is considered done only when `make check` passes with zero errors or warnings.

---

## Contributing

If you want to contribute, the most useful thing right now is building out the frontend — specifically the stores, IPC wrappers, and UI components.

**Before opening a PR:**
- `make check` must pass with zero errors and zero warnings
- Rust: follow the existing module structure, no logic in `main.rs`
- Frontend: no React patterns in Solid (`useEffect`, `useState` etc.), no stored derived state
- All Tauri commands must have typed wrappers in `src/lib/ipc.ts`

---

## License

MIT
