# Verun

> ⚠️ **Early stage — not ready for use.** Active development. Expect breaking changes, missing features, and rough edges.

Verun is a macOS app for running multiple Claude Code agents in parallel, each in its own isolated git workspace. Better UX than what exists today.

---

## Why

I was using an existing Mac app for orchestrating Claude Code agents in parallel.
Over time, a few things became frustrating enough to warrant building something better:

- **Performance** — switching between agent sessions was slow and laggy
- **Port management** — each session ran on its own port, but the agent had no
  visibility or control over it. You had to run the app manually, find the port,
  and pass the URL to the agent yourself
- **No persistence** — clicking on an image in a session tab would reset the
  entire session state
- **No code analysis** — no way to inspect what the agent had actually changed
  without leaving the app
- **General UX friction** — small things that added up over a full day of use

Verun is an attempt to fix all of that.

---

## What it does

- **Spawn multiple Claude Code agents** — each in its own git worktree, fully isolated
- **Live terminal per agent** — see exactly what each agent is doing in real time
- **Persistent sessions** — output survives app restarts, stored locally in SQLite
- **No GitHub required** — works entirely local, no tokens, no permissions
- **One-click merge flow** — review diff and merge when an agent finishes
- **Status sidebar** — always-visible list of all agents with live status badges

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
| Persistence | SQLite via tauri-plugin-sql |
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
│  │             │        │  agent.rs   (spawn)  │  │
│  │  Sidebar    │ events │  worktree.rs (git)   │  │
│  │  AgentPanel │◄───────│  stream.rs  (buffer) │  │
│  │  Terminal   │        │  db.rs      (sqlite) │  │
│  └─────────────┘        │  ipc.rs     (cmds)   │  │
│                          └──────────┬──────────┘  │
└─────────────────────────────────────┼─────────────┘
                                      │
              ┌───────────────────────┼───────────────┐
              │                       │               │
        git worktree 1          git worktree 2    git worktree N
        (agent-1 branch)        (agent-2 branch)  (agent-N branch)
              │                       │               │
        Claude Code             Claude Code      Claude Code
         process                 process          process
```

**Output streaming pipeline:**
```
Claude Code stdout/stderr
        ↓
  stream.rs — buffer ~16 lines or 50ms
        ↓
  tauri::emit("agent-output", { agent_id, lines })
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
│       ├── main.rs          # Entry point, plugin registration
│       ├── agent.rs         # Process lifecycle (spawn/kill/restart)
│       ├── worktree.rs      # Git worktree CRUD
│       ├── db.rs            # SQLite schema + queries
│       ├── stream.rs        # Output buffering + event emission
│       └── ipc.rs           # All #[tauri::command] definitions
└── src/
    ├── types/index.ts       # Shared types (Agent, Session, Worktree)
    ├── store/
    │   ├── agents.ts        # Solid store — agent list + status
    │   └── sessions.ts      # Solid store — session history
    ├── lib/ipc.ts           # Typed wrappers around Tauri invoke()
    └── components/
        ├── Sidebar.tsx      # Agent list, status badges
        ├── AgentPanel.tsx   # Per-agent view
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
- [ ] Git worktree create/delete/list
- [ ] Spawn and kill Claude Code processes
- [ ] Stream agent output to xterm.js terminal
- [ ] Persist sessions to SQLite
- [ ] Basic sidebar with agent status badges

### v0.2 — UX
- [ ] One-click agent spawn (repo picker → auto branch → auto worktree)
- [ ] Agent restart
- [ ] Session history browser
- [ ] Status: idle / running / paused / done / error

### v0.3 — Merge flow
- [ ] Built-in diff view when agent finishes
- [ ] One-click merge to target branch
- [ ] Worktree cleanup after merge

### v0.4 — Polish
- [ ] Multiple repo support
- [ ] Agent naming and tagging
- [ ] Keyboard shortcuts for everything
- [ ] Onboarding flow

---

## Contributing

Verun is early. If you want to contribute, the most useful thing right now is building out the Rust backend — specifically `worktree.rs`, `agent.rs`, and `stream.rs`.

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
