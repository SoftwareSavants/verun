# Verun

> **Early stage — not ready for use.** Active development. Expect breaking changes, missing features, and rough edges.

Verun is a macOS app for running multiple Claude Code sessions in parallel, each in its own isolated git workspace. Better UX than what exists today.

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
- **Live terminal per session** — see exactly what Claude is doing in real time
- **Persistent history** — output stored locally in SQLite, browsable after sessions end
- **No GitHub required** — works entirely local, no tokens, no permissions
- **One-click merge flow** — review diff and merge when a task is complete
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

**Output streaming pipeline:**
```
Claude Code stdout/stderr
        ↓
  stream.rs — buffer ~16 lines or 50ms, persist to SQLite
        ↓
  tauri::emit("session-output", { sessionId, lines })
        ↓
  Terminal.tsx — requestAnimationFrame batching
        ↓
  xterm.js write()
```

Never polls. Always pushes via Tauri events.

---

## Project structure

```
verun/
├── src-tauri/
│   └── src/
│       ├── main.rs          # Entry point only
│       ├── lib.rs           # Plugin registration, state setup
│       ├── task.rs          # Task + session lifecycle (spawn/kill/resume)
│       ├── worktree.rs      # Git worktree CRUD + validation
│       ├── db.rs            # SQLite schema, queries, async write queue
│       ├── stream.rs        # Output buffering + event emission
│       └── ipc.rs           # All #[tauri::command] definitions
└── src/
    ├── types/index.ts       # Shared types (Project, Task, Session)
    ├── store/
    │   ├── projects.ts      # Solid store — project list
    │   ├── tasks.ts         # Solid store — tasks per project
    │   └── sessions.ts      # Solid store — session history + output
    ├── lib/ipc.ts           # Typed wrappers around Tauri invoke()
    └── components/
        ├── Sidebar.tsx      # Project/task list, status badges
        ├── TaskPanel.tsx    # Per-task view with session tabs
        ├── Terminal.tsx     # xterm.js wrapper
        ├── MergeBar.tsx     # Post-completion merge flow
        └── Layout.tsx       # Root layout
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
git clone https://github.com/yourusername/verun.git
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

### Zed

Project-level Zed config is in `.zed/settings.json` and `.zed/tasks.json`. Open the project root in Zed and everything should work — rust-analyzer, clippy on save, inlay hints, and all tasks available via `Cmd+Shift+R`.

---

## Roadmap

### v0.1 — Foundation
- [ ] Add projects (repos) and create tasks with auto worktrees
- [ ] Start/stop/resume Claude Code sessions
- [ ] Stream session output to xterm.js terminal
- [ ] Persist sessions and output to SQLite
- [ ] Basic sidebar with project/task/session navigation

### v0.2 — UX
- [ ] Multiple sessions per task
- [ ] Session history browser with output replay
- [ ] Task name derived from Claude after first message
- [ ] Status: running / idle / done / error

### v0.3 — Merge flow
- [ ] Built-in diff view per task
- [ ] One-click merge to target branch
- [ ] Worktree cleanup after merge

### v0.4 — Polish
- [ ] Project-level settings
- [ ] Keyboard shortcuts for everything
- [ ] Onboarding flow
- [ ] macOS notifications on session completion

---

## Contributing

Verun is early. If you want to contribute, the most useful thing right now is building out the frontend — specifically the stores, IPC wrappers, and UI components.

**Before opening a PR:**
- `make check` must pass with zero errors and zero warnings
- Rust: follow the existing module structure, no logic in `main.rs`
- Frontend: no React patterns in Solid (`useEffect`, `useState` etc.), no stored derived state
- All Tauri commands must have typed wrappers in `src/lib/ipc.ts`

**To get started:**

```bash
git checkout -b your-feature
# build the thing
make check
git push origin your-feature
# open a PR
```

No formal issue template yet. Just open one and describe what you're doing.

---

## License

MIT
