# Contributing to Verun

Thanks for your interest in contributing. The most useful areas right now are frontend stores, IPC wrappers, and UI components.

## Getting Started

```bash
git clone https://github.com/SoftwareSavants/verun.git
cd verun
bash scripts/setup.sh   # installs Rust targets, cargo-watch, and frontend deps
pnpm tauri dev           # run in dev mode
```

### Prerequisites

- macOS (Apple Silicon or Intel)
- [Rust](https://rustup.rs) (stable)
- Node.js 18+
- pnpm
- Xcode Command Line Tools

## Development Commands

```bash
make dev        # start dev server
make check      # run all checks (tsc + cargo check + clippy + tests)
make test       # run Rust tests only
make lint       # run clippy only
```

## Rules

- `make check` must pass with zero errors and zero warnings before opening a PR
- No logic in `main.rs` — all Rust code lives in the module files
- No React patterns in Solid (`useEffect`, `useState`, etc.) — use signals and stores
- No stored derived state — compute from signals
- Every Tauri command must have a typed wrapper in `src/lib/ipc.ts`
- File I/O, git ops, and process management happen in Rust, never in JS

## Architecture

```
src-tauri/src/         Rust backend
  lib.rs               plugin registration, state setup, startup recovery
  task.rs              task + session process lifecycle (spawn, kill, resume)
  worktree.rs          git worktree CRUD + validation + branch status
  db.rs                SQLite schema, queries, async write queue (sqlx)
  stream.rs            stdout/stderr buffering, DB persistence, backpressure
  ipc.rs               all #[tauri::command] definitions
  main.rs              entry point only

src/                   Solid.js frontend
  components/          UI components
  store/               Solid stores (projects, tasks, sessions)
  lib/                 typed Tauri invoke wrappers
  types/               shared TypeScript types
```

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
