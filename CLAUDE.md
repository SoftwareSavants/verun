# Verun

Parallel Claude Code agent orchestrator for macOS.

## Stack

- Tauri v2 (Rust backend + WebView)
- Solid.js + TypeScript (frontend)
- UnoCSS (styling)
- xterm.js (terminal rendering)
- SQLite via tauri-plugin-sql (persistence)
- pnpm (package manager)

## Project Structure

src-tauri/src/ — all Rust backend code
src/           — all Solid.js frontend code
src/types/     — shared TypeScript types
src/store/     — Solid stores (agents, sessions)
src/lib/       — typed Tauri invoke wrappers
src/components/— UI components

## Key Rules

- Never do file I/O, git ops, or process management in JS — always in Rust
- Never poll from frontend — use Tauri events (emit/listen)
- Never await SQLite writes on the UI thread — fire and forget
- All agent output must be buffered in Rust before emitting to frontend
- Use `<For>` not `<Index>` for all list rendering in Solid
- Lazy-mount Terminal components — only init xterm.js on first view
- Every Tauri command must have a typed wrapper in src/lib/ipc.ts

## Commands

pnpm tauri dev          # run dev
pnpm tauri build        # production build
pnpm check              # typecheck frontend
cargo check             # check Rust
cargo test              # run Rust tests
cargo clippy            # lint Rust
make check              # full project health check
make dev                # start dev server

## Rust Crate Layout

agent.rs    — process lifecycle (spawn, kill, restart)
worktree.rs — git worktree CRUD
db.rs       — SQLite schema and queries
stream.rs   — output buffering and event emission
ipc.rs      — all #[tauri::command] definitions
main.rs     — plugin registration only, no logic here

## Never

- Never put logic in main.rs
- Never use React patterns in Solid (useEffect, useState)
- Never store derived state — compute from signals
- Never block the tokio runtime with sync I/O — use spawn_blocking

## Project Phases

- **Phase 1** (DONE): Project scaffolding, configs, types, module stubs
- **Phase 2**: Rust backend full implementation (see PHASE-2-RUST-BACKEND.md)
- **Phase 3**: Frontend state & IPC integration (see PHASE-3-FRONTEND-STATE.md)
- **Phase 4**: UI components full implementation (see PHASE-4-UI-COMPONENTS.md)
- **Phase 5**: Polish, error handling & release (see PHASE-5-POLISH-RELEASE.md)

## Definition of Done

A task is only complete when:

1. `make check` passes with zero errors
2. Rust clippy has zero warnings
3. No TypeScript errors
4. The feature works end-to-end in `pnpm tauri dev`
