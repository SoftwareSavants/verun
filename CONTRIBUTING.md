# Contributing

Verun is open source and we welcome contributions - bug reports, feature ideas, docs improvements, and code.

## Ways to contribute

- **Report bugs** - [open an issue](https://github.com/SoftwareSavants/verun/issues/new) with steps to reproduce
- **Suggest features** - start a [discussion](https://github.com/SoftwareSavants/verun/discussions/new) or open an issue
- **Submit a PR** - fix a bug, improve docs, or pick something from the [roadmap](ROADMAP.md)
- **Improve docs** - typos, unclear instructions, missing context

## Getting started

```bash
git clone https://github.com/SoftwareSavants/verun.git
cd verun
bash scripts/setup.sh
make dev
```

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- Node.js 18+
- pnpm
- Platform-specific:
  - **macOS** - Xcode Command Line Tools
  - **Windows** - Visual Studio Build Tools with C++ workload
  - **Linux** - `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`

## Development commands

| Command | What it does |
|---------|-------------|
| `make dev` | Start dev server (uses separate bundle ID and database from release builds) |
| `make check` | Run all checks: TypeScript, cargo check, clippy, tests |
| `make test` | Rust tests only |
| `make lint` | Clippy only |
| `pnpm check` | TypeScript type check only |

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `make check` - it must pass with zero errors and zero warnings
4. Open a PR with a clear description of what changed and why

Keep PRs focused. One bug fix or feature per PR is easier to review than a grab bag.

## Code guidelines

- All file I/O, git operations, and process management happen in Rust, never in JavaScript
- Every Tauri command needs a typed wrapper in `src/lib/ipc.ts`
- No polling from the frontend - use Tauri events (emit/listen)
- No React patterns in Solid (`useEffect`, `useState`) - use signals and stores
- No derived state in stores - compute from signals
- No logic in `main.rs` - entry point only
- Use `<For>` not `<Index>` for list rendering

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
          agent                   agent            agent
        session(s)              session(s)       session(s)
```

## Questions?

Open a [discussion](https://github.com/SoftwareSavants/verun/discussions/new) or check existing threads - we're happy to help.
