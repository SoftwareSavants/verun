# Verun

Parallel Claude Code session orchestrator for macOS.

## Communication Style

- Extremely concise replies. A few sentences max. No preamble, no restating, no over-explaining. User is highly technical.

## Data Model

projects (1) → tasks (many) → sessions (many) → output_lines (many)

- Project = a git repo added to Verun
- Task = a unit of work, owns a worktree + auto-generated funny branch name
- Session = a Claude Code CLI session (resumable via --resume), multiple per task

## Stack

- Tauri v2 (Rust backend + WebView)
- Solid.js + TypeScript (frontend)
- UnoCSS (styling)
- xterm.js (terminal rendering)
- SQLite via sqlx + tauri-plugin-sql (persistence)
- pnpm (package manager)

## Project Structure

src-tauri/src/ — all Rust backend code
src/           — all Solid.js frontend code
src/types/     — shared TypeScript types
src/store/     — Solid stores (projects, tasks, sessions)
src/lib/       — typed Tauri invoke wrappers
src/components/— UI components

## Key Rules

- Never do file I/O, git ops, or process management in JS — always in Rust
- Never poll from frontend — use Tauri events (emit/listen)
- Never await SQLite writes on the UI thread — fire and forget
- All session output must be buffered in Rust before emitting to frontend
- Use `<For>` not `<Index>` for all list rendering in Solid
- Lazy-mount Terminal components — only init xterm.js on first view
- Every Tauri command must have a typed wrapper in src/lib/ipc.ts

## Commands

pnpm tauri dev --config src-tauri/tauri.dev.conf.json   # run dev (separate bundle id + app data dir from release)
pnpm tauri build        # production build
pnpm check              # typecheck frontend
cargo check             # check Rust
cargo test              # run Rust tests
cargo clippy            # lint Rust
make check              # full project health check
make dev                # start dev server

## Rust Crate Layout

lib.rs      — plugin registration, state setup, startup recovery
task.rs     — task + session process lifecycle (spawn, kill, resume)
worktree.rs — git worktree CRUD + validation + branch status
db.rs       — SQLite schema, queries, async write queue (sqlx)
stream.rs   — stdout/stderr buffering, DB persistence, backpressure
ipc.rs      — all 20 #[tauri::command] definitions
main.rs     — entry point only, no logic

## UnoCSS (not Tailwind)

This project uses UnoCSS with preset-wind3. Key differences:
- Container outlines: use `ring-1 ring-<color>` (e.g. `ring-1 ring-white/8`, `ring-1 ring-accent/40`)
- Directional borders: `border-t-1 border-t-solid border-t-<color>`
- Tailwind shorthands like `border-2` do NOT work — use the explicit form
- `border border-<color>` only works on form elements (buttons, inputs) — for divs use `ring`

## Never

- Never put logic in main.rs
- Never use React patterns in Solid (useEffect, useState)
- Never store derived state — compute from signals
- Never block the tokio runtime with sync I/O — use spawn_blocking

## Documentation Maintenance

After making changes, update the following as needed:

### CHANGELOG.md
- Add a bullet under the `## Unreleased` section describing what changed
- If no `## Unreleased` section exists, create one at the top (above the latest versioned section)
- Do NOT bump the version number or create a new versioned section — only add to Unreleased
- Keep bullets concise: one line, start with what changed, not "Added" or "Fixed"

### ROADMAP.md
- Check off items (`[X]`) that are now complete
- Move newly shipped features into the Shipped section if appropriate
- Do not add new roadmap items unless asked

### README.md
- Update the Features list if a user-facing capability was added or significantly changed
- Do not rewrite sections that are still accurate

## Definition of Done

A task is only complete when:

1. `make check` passes with zero errors
2. Rust clippy has zero warnings
3. No TypeScript errors
4. The feature works end-to-end in `pnpm tauri dev`
5. Changes are committed
6. CHANGELOG.md, ROADMAP.md, and README.md updated if applicable
