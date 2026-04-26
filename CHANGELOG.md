# Changelog

## Unreleased

- Fix "Task setup failed: Too many open files" on new-task creation — raise `RLIMIT_NOFILE` at startup and only fetch sessions/git/watcher for newly-added tasks in the sidebar effect instead of re-fanning out across every existing task on each insert
- Fix messages from a previously-viewed task briefly appearing in another task's session when switching between tasks quickly across projects: the async task-select effect now writes session state scoped to the task it started for, instead of reading the currently-selected task after the await
- ChatView now remounts per-session (keyed on sessionId) so switching sessions can't surface stale blocks from a previous session's in-memory cache
- Cap initial chat hydration at the latest 250 NDJSON lines and lazy-load older history when the chat scrolls within 200px of the top; long-running sessions now render in tens of ms instead of seconds, and the scroll position is anchored across each prepend so reading older messages doesn't jump. Backed by a cursor-based `get_output_lines(session_id, limit, before_id)` query
- Persist session usage aggregates (`total_cost`, input/output/cache tokens) on the session row and maintain them at transcript write time, so the 250-line chat cap no longer needs any replay-time or scan-time usage reconstruction
- Remove duplicate `body?: string` field from `PrInfo` that was failing `tsc --noEmit`
- Fix release CI: macOS Intel now builds on `macos-15-intel` (the plugin's Swift bundle doesn't cross-compile from the arm `macos-26` runner); Linux and Windows re-enable the `notify-rust` fallback in `tauri-plugin-notifications` since they have no native branch
- Bootstrap dialog icons now ship as pre-fetched brand assets (Iconify's `logos:` colored set, with `simple-icons` shape fallbacks tinted to each brand's marketing hex, and project-hosted assets for Elysia/oRPC/Starlight/Ultracite/Oxlint/OpenTUI/Fumadocs which don't exist in either set) — added Better-Auth, MCP, Neon, and Fumadocs brand marks, swapped the Cloudflare wordmark for the icon-only variant and MCP wordmark for the icon-only variant, dropped the `simple-icons` npm dep; fetch script now handles PNG as well as SVG so `brandFromImage` renders `fumadocs.png` via `<img>`; refresh via `node scripts/fetch-brand-icons.mjs`. Monochrome marks whose fills/strokes are all pure white or all pure black (Expo, Express, Fastify, Lefthook, Planetscale, Next.js, Starlight, Ultracite) are auto-rewritten to `currentColor` so they pick up the host element's theme-aware text color instead of rendering white-on-white or black-on-black; multi-color brand palettes are left untouched
- Empty-state layout: when no projects exist, the left sidebar is hidden and the "Add Project" + "Bootstrap new" actions live side-by-side in the main area (no more duplicate CTAs)
- Bootstrap dialog parent-folder picker: typing a name that doesn't match any existing folder shows an inline `+ Create "<name>"` row at the bottom of the suggestion dropdown - one click (or Tab/Enter) creates the directory under the current parent and applies the path. The dropdown lost its native browser bullets, gained per-row folder icons, and the highlighted entry now scrolls into view as you arrow through the list
- Bootstrap dialog brand icons: replaced the Next.js mark with the official Vercel "N" (no surrounding circle) so it survives `currentColor` rendering; `prisma`, `mcp`, and `orpc` now also force `currentColor` so their dark mono marks inherit the host's text color instead of rendering black-on-black on dark surfaces. Added a `mono ` prefix to `scripts/fetch-brand-icons.mjs` for forcing the recolor regardless of the source's actual color, and the rewriter now injects `fill="currentColor"` on the root `<svg>` when missing so paths without an explicit fill don't fall back to black
- Bootstrap dialog: scaffold no longer fails with `Cannot combine --yes with core stack configuration flags` - dropped both `--yes` (defaults-only, rejects config flags) and `--yolo` (silently defaults every unanswered question) so the user's form selections drive the run AND any question we don't pre-answer still surfaces as a real prompt. The CLI now runs through a portable-pty so Clack/inquirer cursor sequences render correctly, and the dialog's log pane is an inline xterm.js terminal: keystrokes (arrow keys, Enter, Ctrl+C, etc.) are forwarded to the child via `bts_scaffold_input`; window resizes flow through `bts_scaffold_resize`. The Retry button on a failed scaffold lost its rocket icon
- Bootstrap a new project from Better-T-Stack without leaving Verun: the sidebar's `+` button now offers "Add existing project..." or "Bootstrap a new project...", which opens a visual builder to pick your frontend, backend, database, ORM, auth, runtime, addons, examples, and package manager, see the equivalent CLI command update live (one-click copy), and scaffold straight into a parent folder of your choice. Sensible defaults are pre-filled (TanStack Router + Hono + Bun + tRPC + SQLite + Drizzle + Better-Auth + Turborepo) and each option shows an official brand icon with a short description. Incompatible combinations are outlined in red with a personalized reason ("SQLite doesn't need Docker", "Neon requires PostgreSQL", "Convex includes its own database", "Clerk doesn't support Astro", "Cloudflare D1 requires Workers + Cloudflare deploy", "Fullstack backend requires runtime none", "tRPC doesn't support Nuxt") - one click on the card applies the auto-fix-up that flips the dependent fields, no confirmation step or hunting for what to change. Reasons only appear when the conflict involves a prior category the user has already committed to; conflicts that only touch fields below the clicked card are silently auto-fixed instead of warning about choices the user hasn't made yet. Compatible picks auto-pair for you (mongodb picks mongoose, workers runtime picks cloudflare deploy, etc.). Validation is verified against the live Better-T-Stack CLI across 83 representative configurations so disabled cards match exactly what the CLI would reject. `⌘↵` submits; scaffold progress streams live with elapsed time; cancel kills the process and cleans up the partial directory; on failure the last 40 log lines stay visible with a Retry button. Your last config is remembered across sessions once a scaffold succeeds, and completed projects hand off to the existing Add Project dialog with `.verun.json` hooks pre-filled
- Fix armed steps with attachments silently dropping the attachment when the session became idle: the drain path used `JSON.parse` on `attachmentsJson` instead of `deserializeAttachments`, so images arrived with no `data` and the agent received text only
- Replace base64-in-JSONL attachments with a content-addressed blob store: bytes live under `<app_data>/blobs/<aa>/<sha256>.bin`, refs (hash + mime + name + size) ride the wire, identical pastes deduplicate, and refcount-based GC reclaims unreferenced blobs
- New Settings → Storage: configurable retention TTL and disk cap, "Run cleanup now" button, and breakdown modal showing referenced vs unreferenced bytes
- Background GC sweeps unreferenced and over-cap blobs at startup; legacy base64 attachments migrate to the blob store on first launch (idempotent via app_meta sentinel)

## 0.9.0 - 2026-04-23

### Codex (OpenAI) support lands

- First-class Codex sessions with live plan mode, structured approvals, and token usage parity with Claude
- Codex plans stream into the same Plan Review overlay (approve / request changes) and persist to `.verun/plans/` so reopening the session restores them
- Questions from Codex (`requestUserInput`) now render in the same Ask-a-Question UI Claude uses, with a pick list and optional description, instead of being auto-denied
- Patch, exec, file-change, command-execution, and permission prompts are routed through the same approval UI as Claude (allow / deny)
- Turn diffs render as a collapsible diff block that updates live as Codex edits files
- Interrupts keep the underlying process alive across aborts, so the next send reuses it instead of respawning
- Per-turn token breakdown (input / output / cache-read) now shows on the usage badge instead of reading zero
- Fixes: file-change badges show the correct Add / Update / Delete label; assistant replies no longer double-render at end of turn; aborts no longer leave the session wedged on "busy"; plan mode no longer renders nothing; aborts before the turn has started no longer flip the UI to idle while the real turn keeps running

### GitHub Actions tab

- New Actions tab in the right sidebar shows live Actions runs for the current branch: per-workflow grouping, expandable jobs, queued / running / success / failure / cancelled / skipped status icons, and 10s polling while any run is active
- One-click "Fix in this session" or "Fix in new session" sends the agent a structured failure summary (failing step + annotated errors with file:line:col) and the `gh run view --log-failed` command it can run for full logs
- Re-run and cancel workflows from the UI; the toolbar CI chip now opens the tab instead of a dropdown
- Expanded job logs render as a flat timestamp-prefixed list that auto-scrolls to the first error; the "N err" counter is itself the scroll-to-first-error trigger. Toolbar adds line wrap, copy, and fullscreen

### Light mode polish

- Code editor, diff editor, search panel, rename widget, and hover tooltips now follow the active theme in light mode instead of baking in One Dark colors (active line, gutter, selection, tooltips, syntax highlighting)
- Diff editor's collapsed "X unchanged lines" pill flips with the theme
- Hook textareas (Settings and Add Project), Cmd+P file picker, `>` command palette, and breadcrumb dropdown now match the active theme palette

### Model picker (Cmd+T)

- Cmd+T on a selected task opens a centered picker to start a new session with a chosen agent and model (arrow keys + Enter, type to filter)
- Models within each provider are ordered by most-recently-used across all sessions, capped at 4 with a "Show N more" expander; the active model is pinned to the top with a "Current" badge
- "Fix in new session" in the Actions tab uses the same picker so you pick the model before the fix prompt is sent

### Editor & navigation

- Find References (Shift+F12 / context menu) now opens a VS Code-style peek overlay anchored at the cursor - references grouped by file, keyboard-navigate with Arrow / Home / End / Enter, Escape to close
- Opening a file in a gitignored folder (`node_modules`, `dist`, `.next`, etc.) no longer auto-reveals it in the file tree - auto-open flows (Find References, Go to Definition, tab switching, global search) stay focused on source files; manual reveal still works
- File tree treats symlinked directories as directories so they expand on click (broken symlinks stay non-expandable)

### Terminals in detached windows

- Opening a task in a detached window no longer loses its running terminals: a per-PTY 256KB ring buffer replays scrollback into xterm so TUIs like vim and Claude Code redraw correctly
- Terminal panel open/closed state persists per task, so detached windows inherit the same visibility
- Closing a detached window re-syncs terminals in the main window, so PTYs spawned or closed in the other window reflect correctly

### Sessions & tabs

- `+` menu now surfaces closed sessions under a "Recent" section - click one to restore it as a tab with full transcript replay (#100)
- `+` button sticks to the left edge while the tab bar scrolls horizontally (#100)
- Cmd+Enter while the agent is running (steer) now reliably sends your new message after the abort completes, instead of silently being dropped

### Performance

- Task switching stays responsive across large workspaces: diagnostics and source-control lists are virtualized, chat block rebuilds are cached, and full-list scans in the file tree, tabs, and sidebar are avoided

### Smaller changes

- Hook and start-command inputs autocomplete `$VERUN_*` env vars - typing `$` surfaces `$VERUN_REPO_PATH` and `$VERUN_PORT_0..9` with descriptions
- Import/Export `.verun.json` now lets you pick the location: the main repo or any task's worktree
- Trust level changes apply mid-run: editing the policy during an in-flight turn takes effect on the next tool-approval check
- "Add Project" from the empty TaskPanel now opens the Add Project dialog (hooks + start command) like Sidebar and Cmd+O, instead of jumping straight to New Task
- Notifications: clicking a banner navigates to the source task/session; the Notification Center clears when the app regains focus; dev builds no longer emit notifications (they were appearing as Terminal.app and swallowing click data)
- Fix "No coding agent CLIs found" toast firing at startup on macOS when agents are installed via nvm / homebrew / `~/.local/bin` - PATH reload now completes before agent detection runs

## 0.8.1 — 2026-04-20

### Changes

- Sidebar task switching feels instant: output lines are cached per session after the first load so switching away and back no longer re-fetches and re-parses the full NDJSON transcript; steps now load in parallel with the chat view instead of blocking it; file tree skips the worktree walk when the root is already cached
- Task naming (Haiku) now runs with `--strict-mcp-config` so large MCP server setups don't bloat context and cause failures
- Fix Windows build: gate `libc::kill` (SIGTERM) behind `#[cfg(unix)]` - Windows falls through to SIGKILL

## 0.8.0 — 2026-04-20

- Make Verun feel like home: a new Appearance settings tab with light, dark, and system mode; theme presets plus a fully custom palette (HSV picker for accent, surface, and foreground); bundled UI and code fonts (Inter, JetBrains Mono, Fira Code, Cascadia Code) on top of any system font; independent UI and code font sizes; Compact / Normal / Comfortable density that scales the whole UI; terminal cursor blink; and reduced motion. The default accent is a mode-tuned teal, and text on accent backgrounds auto-flips between black and white based on perceived luminance so primary buttons stay readable on any color you pick.
- Tool policy selector: renamed levels to "Ask every time" / "Auto-approve safe" / "Full auto" with clearer example subtitles; popover gets a section header, check icon on the selected row, and safety-ordered layout; chip label now reads `auto-safe` / `ask` / `full auto` instead of `Normal` / `Supervised` / `Auto`
- Usage popover redesigned: prominent cost header, grouped rate-limit cards (active overage highlighted in red), aligned token grid with split cached-read/cached-write rows, and M/B token formatting past 1M (e.g. `24.7M` instead of `24657.1k`)
- Shared `formatCost` / `formatTokens` helpers extracted to `src/lib/format.ts` and reused across `ChatView` + `MessageInput`
- Fix new session opening twice in the source window: `createSession` now dedups against the cross-window `session-created` broadcast (regression from #143)
- Branch names replaced from animal-based to programming-humor themed; stack detection merges noun pools for Rust, Go, Python, JS/TS, and Java (monorepo-aware)
- Fix archive/delete killing running sessions on other tasks - the kill loop now scopes to session ids belonging to the target task instead of iterating every active process (#169)
- Plan/Think/Fast toggles and plan-review banner now scoped per session instead of per task — entering plan mode in one session no longer leaks into siblings (#155)
- Plan/Think/Fast toggles no longer disabled while the agent is running, so mode changes can take effect on queued steps and steers
- Composer model selector no longer disabled while the agent is running; the new selection applies to subsequent sends (manual, armed auto-send, or queued step)
- Next Steps: click a step to edit inline (textarea + per-step mode toggles + model selector); removed the separate pencil icon and the edit-via-composer round-trip
- Next Steps: armed state shown as an accent left-border; fire/arm/delete actions revealed on row hover to reduce visual noise
- Next Steps: arm toggle now uses action-button semantics — armed step shows Pause (click to pause), disarmed shows Play (click to play)
- Next Steps: fire button sits as the leftmost icon of the right-hand hover cluster (no longer prefixing the message) and is revealed only on hover
- Next Steps: armed indicator is now an inset box-shadow instead of a left border, so armed rows keep the same horizontal alignment as disarmed ones
- Next Steps: row contents vertically centered in view mode; buttons in edit mode no longer blur-save the textarea (WebKit fix)
- ModelSelector: added `fixedPosition` option so the popover escapes overflow-clipping containers (used by inline step editing)
- Composer: when the agent is running, the Enter button now uses a `ListPlus` icon to match its actual behaviour (add next step) instead of the send arrow
- Next Steps: first idle step hides the arm/play button (redundant with the send button) and keeps its icons visible without hover; arm button no longer uses accent colour in the armed state
- Next Steps: remove button uses an `X` icon instead of a trash bin, reflecting "dismiss from queue" semantics rather than permanent delete
- Next Steps: "Next Steps" header sticks to the top of the list when scrolling so it remains visible as additional steps scroll past
- Opening the New Task dialog after adding a project now works from every entry point (empty-state button no longer skips it)
- Sidebar task tiles show unread/attention state as a pulsing left-edge strip (amber for attention, blue for unread) instead of a trailing dot
- Cmd+1…9 now focuses the existing window when the target task is already open in a separate window (matching sidebar click behavior); sidebar tiles display the shortcut, which swaps to the archive button on hover (#142)
- Detached task windows now hydrate the projects + agents stores on mount, so the new-session menu lists installed agents and the Start button picks up the project's start command (#166)
- Archiving a task closes its detached window instantly: the sidebar updates optimistically, `task-removed` fires before the destroy hook runs, and the destroy hook + last-commit-message capture finish in the background (#138)
- `open_task_window` now unminimizes and shows the window before focusing, so Cmd+1…9 (and sidebar clicks) reliably bring detached windows forward on macOS even when minimized (#142)
- Cross-window task state stays in sync: new sessions and closed sessions started in one window now broadcast `session-created` / `session-removed` so other windows update without a reload, plus a visibility-change backstop refreshes sessions for every loaded task (#143)
- Fix newly created task occasionally disappearing from sidebar after setup - the `task-created` event now carries the source window label so the originating window skips its own reload, avoiding a race with the async DB write queue (#135)
- Graceful shutdown for aborted claude sessions: close stdin, wait 5s, SIGTERM, wait 5s, then SIGKILL - prevents losing the last assistant message on `--resume` when the CLI is mid-write of its session JSONL
- Strip `CLAUDECODE` from the spawned CLI's env and set `CLAUDE_CODE_ENTRYPOINT=verun` so nested-detection and telemetry are correct
- Stream parser skips non-JSON stdout lines (e.g. `[SandboxDebug]`) instead of surfacing them as raw output
- Stream loop now parses each NDJSON line once instead of up to three times
- New `interrupt_session` IPC: cancel the current turn over stdin without killing the process
- New `get_session_context_usage` IPC: ask the running CLI for current context-window usage
- Claude sessions now reuse a single persistent CLI process across all turns in a session (matches claude-agent-sdk-python): eliminates the 2-3s CLI boot cost on every message and fixes the armed-step race where a queued send would collide with the dying CLI's final JSONL write
- Fix loading indicator sticking on after turn end: persistent-agent stream loop now emits `session-status: idle` from `turn_end` (the monitor's post-exit idle emission never fires for processes that stay alive across turns)
- Abort on Claude sessions is now a single `control_request interrupt` write to stdin - the process stays alive for the next message, so there's no graceful-shutdown delay and no "Stopping..." spinner
- New `prewarm_session` IPC + `TaskPanel` hook: opening a Claude session spawns the CLI in the background so the first message is instant. No-op for non-persistent agents (Codex, Gemini, Cursor, OpenCode)
- `close_session` / `clear_session` / app-quit now shut down any live persistent CLI before DB writes or exit, so switching tasks or quitting doesn't leak orphan processes
- New `Agent` trait methods (`persists_across_turns`, `abort_strategy`, `encode_stream_user_message`, `encode_stream_interrupt`): call sites stay agent-agnostic, any future agent opts into persistent sessions by flipping one flag
- Plan viewer "Request changes..." input now forwards the typed feedback as the tool-deny message so Claude sees it as the refusal reason and continues the same turn; the plan UI dismisses immediately instead of sticking around waiting for a second message
- Fix persistent-session mode/model race: fast-path `set_permission_mode` / `set_model` now waits for the CLI's `control_response` ACK before writing the user message, so plan mode (and model switches) take effect before Claude reads the prompt - previously the CLI could process the message in the old mode
- Composer stays visible alongside the persisted "Plan ready" banner, and is dismissed automatically when the user sends a fresh message via the main composer - previously a stale plan file from a prior session could hide the composer and block follow-ups
- Fix API/auth errors on Claude sessions rendering as plain text: persistent-agent `turn_end` now propagates the provider error through `session-status`, restoring the red inline banner with Retry / Retry in new session
- Provider errors (auth, overload, prompt-too-long) now render as a single persistent block inside the transcript instead of duplicating across an assistant bubble + system bubble + bottom banner. The block stays visible across follow-up turns, carries Retry / Retry in new session, and exposes the raw CLI JSON behind a "Show details" toggle (copyable)
- Workspace file search (Cmd+Shift+F): new right-panel "Search" tab that searches file contents across the active task's worktree - embedded ripgrep (grep-regex + grep-searcher) with parallel walk, 150ms debounce, per-keystroke cancellation, batched streaming results, case/whole-word/regex toggles, and include/exclude globs; respects `.gitignore` and caps at 1000 matches / 500 files
- Workspace search: Cmd+Shift+F seeds the query from the current editor selection (first line, trimmed) and auto-runs the search
- Workspace search: opening a markdown or SVG result now lands in edit mode so the matched line is visible immediately
- Right panel tabs redesigned as icon-only buttons (Files / Search / Source Control) matching Cursor / VS Code
- Discover Claude skills by reading `SKILL.md` frontmatter from `~/.claude/skills/`, `~/.claude/plugins/cache/**/skills/`, and the project's `.claude/skills/` directly, instead of scraping `claude skills list` output. Fixes empty `/` palette after the CLI changed its human-readable bullet format, and surfaces project-scoped skills when a project root is supplied
- Also scan `.claude/commands/*.md` (project, global, and plugin) so user-authored slash commands like `bump-version` appear in the `/` palette
- Pushed skill discovery onto the `Agent` trait; each agent (Claude, Codex, Gemini, Cursor, OpenCode) owns its own `discover_skills` impl (default empty). `list_agent_skills` IPC now takes `agentKind` + `scanRoot`, so the `/` palette shows the correct set per session's agent
- Two-tier skill cache on the frontend: coarse `(agent, projectRoot)` for instant palette open, background refresh keyed by `(taskId, agent)` when the composer prime fires, so the palette always reflects the task's actual worktree without showing a spinner

## 0.7.3 — 2026-04-17

- Creating a new session now focuses it even when a file tab is open
- Codex: don't persist `thread_id` until the first turn completes, so cancelling a fresh session before it replies doesn't break the next message with "no rollout found"
- Parse Codex `file_change` and `file_read` events as tool blocks

## 0.7.2 — 2026-04-17

### Changes

- Move db init into async spawn to prevent startup crash on macOS
- Chat search position no longer jumps to last match when new agent messages arrive
- File browser now shows .env and other gitignored files
- Quick open now boosts project-scoped recent files, including ignored files like `.env` when recently opened, without indexing build output or `node_modules`
- Store `last_pushed_sha` on tasks (migration 18) so unpushed commit count no longer depends on the remote tracking branch existing - fixes Archive button showing as Push after merging a PR with deleted remote branch

## 0.7.1 — 2026-04-17

- Claude Opus 4.7 model option with minimum CLI version gate (v2.1.111+); shows update dialog on older versions
- Agent detection now exposes CLI version to frontend via `cliVersion` field
- Reduce session startup delay: parallelize pre-spawn DB queries, fix DB pool race condition at app launch, defer title generation so the main session gets a 3s head start, show "Initializing session..." during Claude CLI init, move PATH capture to a background thread

## 0.7.0 - 2026-04-15

### Changes

- Session input textarea now shrinks back to default height after sending a message
- Persist last open session per task across navigation and restarts via localStorage

- Gemini CLI agent: `gemini --output-format stream-json --yolo`, plan mode, model selection, resume, attachments; stream parser handles `message`, `tool_use`, `tool_result`, and `result` event types
- New session menu agent order matches new task dropdown (default agent first, then alphabetical); accepts `defaultAgent` prop from TaskPanel
- Provider error messages shown inline in chat with Retry / Retry in new session buttons; retries preserve model, plan/thinking/fast modes
- Worktree path shown after task name in header - click to copy to clipboard with info toast

- Model search bar in ModelSelector and NewSessionMenu submenus for agents with >10 models - filters by label/id, auto-focuses, clears on close

- Per-session model selection: model is now stored on the session (not the task), `updateSessionModel` IPC command added, `/model` command and model selector both update the session's model
- Model selector layout: description rendered below model name, scrollable dropdown with max-height, wider overlay
- Claude model list updated to full IDs matching Claude Code: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- Codex model list updated to match Codex CLI: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.2`
- Cursor static fallback model list corrected: added `auto`, removed fabricated model IDs
- OpenCode model list no longer shows provider name as description hint

- Fix setup script opening a terminal in the wrong task when the user navigates away before the hook starts - terminal panel now only auto-shows if the task is still selected
- Fix clicking a notification not selecting the source task - visibility change was clearing the nav map before the click handler could consume it
- Fix step edit highlight persisting when switching tasks - clear editing state on session change
- Fix clicking arrow button while editing a step adding a duplicate instead of saving the edit - edit controls now render regardless of session running state
- Fix primary git action icon not updating when switching tasks - use Dynamic component for reactive icon rendering
- Show provider errors inline in chat with the actual error message and Retry / Retry in new session buttons - error message is extracted from the Claude CLI result event and propagated through SessionStatusEvent
- Fix single-line text selection invisible in code editor - active line highlight now suppresses when text is selected so drawSelection's selection layer is visible
- Rewrote bash policy engine to use AST-based shell parsing (yash-syntax) instead of substring matching - handles compound commands, subshells, combined flags, and wrapper programs (env, sudo, bash -c)
- Normal mode now blocks destructive git ops: branch delete, worktree remove/prune, stash drop/clear, tag delete, remote remove, reflog expire, gc --prune, filter-branch, update-ref -d, push --force-with-lease
- Normal mode now blocks gh repo/release delete and detects dangerous commands inside shell re-invocations
- `git worktree prune/remove` and `rm` targeting `.verun` directories are now hard-blocked regardless of trust level - Verun manages worktree lifecycle, not Claude
- Policy engine now strips `git -C <path>` flags to detect cross-repo worktree attacks
- Fix archiving a task from the GitActions replacement button not closing the task panel - deselection now happens inside `archiveTask` so all callers get it
- Fix slow pasting of long text in session composer - disable spellcheck/autocorrect overhead, use Range API for large pastes (>10KB) while keeping `execCommand` + native undo for normal-sized pastes
- Fix slow pasting of long text in shell terminals - use `term.paste()` for bracketed paste support and rAF-batch `pty-output` writes to prevent render storms
- Cmd+F / Ctrl+F search in shell terminals - highlights matches, Enter/Shift+Enter to navigate, Escape to dismiss
- Demo mode: set `VITE_DEMO_MODE=true` to populate the app with dummy projects, tasks, sessions, and a realistic chat conversation for screenshots
- Fix message role corruption when switching between tasks - clear stale output data before reloading and use reactive Switch/Match for block type rendering so reconcile merges can't produce wrong role display
- Fix "delete branch with merge" failing because `gh pr merge --delete-branch` tries to checkout main, which conflicts with the main worktree - now deletes the remote branch separately after merge
- New session "+" button opens a cascading menu: pick an agent, then optionally pick a model from its submenu — session stores `agent_type` and `model` (migration 15), overriding the task's default when set; `send_message` prefers session-level agent type over task-level
- Dynamic per-agent model lists: Cursor uses `agent --list-models`, OpenCode uses `opencode models`, fetched at agent detection time and cached; model selector shows the session's agent models when the session has a per-session agent override
- Multi-agent foundation: new `AgentKind` enum (Claude, Codex, Cursor) with CLI abstraction, `agent_type` column on tasks (migration 13), agent-aware session spawning, `check_agent` and `list_available_agents` IPC commands, per-agent icons and display names in the UI, and capability flags (streaming, resume, plan mode, model selection, effort, skills, attachments, fork) so the frontend can adapt to each agent's feature set
- OpenCode agent backend: `opencode run --format json` with plan mode (`--agent plan`), model selection (`--model provider/model`), and session resume (`--session <id>`)
- Agent picker dropdown in New Task dialog: shows all detected agents with install hints for non-installed ones, sorted by project default first; persists per-project default agent in DB (migration 14)
- Agent type moved from tasks to sessions - each session owns its agent, tasks are agent-agnostic (migration 16 backfills existing sessions from their task's agent type, defaulting to Claude)
- Pre-parsed output items (`verun_items`) persisted in Rust so frontend reload skips agent-specific re-parsing
- Fix forked sessions missing `agent_type` and `model` columns in DB insert
- Cursor word-by-word streaming via `--stream-partial-output` flag
- Cursor tool calls (`tool_call` events) and thinking deltas now displayed in chat
- Token usage extraction for all providers: Cursor (camelCase `usage` in `result`), OpenCode (`part.tokens` + `part.cost` in `step_finish`), Codex (`usage` in `turn.completed`)
- OpenCode event parsing: `text`, `tool_use`, `step_start`/`step_finish` events with session ID capture for resume
- Removed all agent-specific NDJSON parsing from frontend - Rust `verun_items` is the single source of truth
- Cache token tracking (read/write) for all providers that report it: Claude, Cursor, Codex, OpenCode - shown inline in turn tooltips and session usage popover
- OpenCode now shows `tokens.total` (cumulative context) instead of the fixed-overhead `input` field
- Decoupled agent abstractions: `extract_resume_id` on Agent trait replaces hardcoded 3-way branch in stream.rs, snapshot/fork JSONL ops gated on `uses_claude_jsonl()`, fork preserves parent session's agent type instead of hardcoding Claude
- Renamed `claude_session_id` to `resume_session_id` across DB (migration 17), Rust, and TypeScript
- Renamed `ClaudeSkill`/`list_claude_skills` to `AgentSkill`/`list_agent_skills`, removed dead `check_claude` command
- Centralized agent icons into `src/lib/agents.ts`, removing duplicate icon maps from 4 components
- "Question from Claude" label now shows the session's actual agent name
- Plan/Think/Fast toggles hidden when the session's agent doesn't support those capabilities
- `checkCli` on startup checks all agents, not just Claude

## 0.6.0 — 2026-04-14

- Plan approval prompt no longer appears falsely when navigating back to a task with plan mode toggled on but no plan generated
- CMD+P now correctly focuses an already-open file tab even when the session view is active
- Git action messages (rebase, PR creation) now use the project's configured base branch instead of letting Claude default to main
- Git actions show "Archive" as the primary action when a PR is merged, replacing the empty button area
- Scroll-to-bottom button appears in the bottom-right corner of the session when scrolled up
- Hide copy and fork buttons on the currently streaming assistant message - completed turns still show their buttons
- Fix messages rendering with the wrong role (user as agent, agent as user) when switching between sessions/tasks with similar output lengths - ChatView block rebuild now tracks session ID, not just item count
- Plan review overlay now stays within the session pane instead of overflowing behind the sidebar and right panel
- Clicking a project header no longer collapses other empty projects — removed stale "selected project" gating that hid the "+ New task" hint on non-selected empty projects
- Clicking a macOS notification now navigates directly to the relevant task and session - migrated from `mac-notification-sys` to `tauri-plugin-notifications` (Choochmeque), which uses `UNUserNotificationCenter` via Swift FFI for native click callbacks via `onNotificationClicked`; JS-side Map tracks notification IDs to task/session pairs for navigation on click; session selection uses a `pendingSessionNav` signal consumed after session loading completes, preventing a race where the effect defaulted to the first session
- Notification permission toast "Enable" button now properly persists the enabled preference and guards `onDismiss` from racing with the enable callback
- Task and session unread indicators now only appear when a session finishes (status → idle/error), not after every streamed chunk or tool call
- Update notification converted from a top bar to a dismissible bottom-right toast; dismissing during a download hides the toast without cancelling the download, and the restart prompt re-appears automatically once the download completes
- Normal trust level now auto-allows non-destructive `git push` — only `git push --force`, `-f`, and `--delete` still require approval
- Fork a session from a past assistant message: hover any assistant reply to fork in this task (rewinds the chat, keeps current code), or fork to a new task with the worktree restored to the code as it was at that message (true counterfactual) or seeded from the parent's current code
- Per-turn worktree snapshots taken at every assistant turn end via git plumbing (commit-tree against a temporary index), anchored under `refs/verun/snapshots/` so they survive `git gc`
- Replaced vtsls with tsgo (`@typescript/native-preview`) as the bundled language server. Per-task LSP RSS drops from ~3 GB to ~70-300 MB on a real monorepo. Source-file diagnostics now flow through a pull→push translation shim in `src/lib/lsp.ts` because tsgo only supports `textDocument/diagnostic` (pull) for source files; the Problems panel store gets a parallel input channel for the synthesized notifications.
- Project-wide Problems panel population via debounced `tsgo --noEmit` shellout. New `tsgo_check` Rust module walks every `tsconfig.json` in the worktree (skipping `node_modules`, hidden dirs, and build output like `dist`/`.next`/`.turbo`), spawns `tsgo --noEmit --pretty false -p <config>` against each with concurrency bounded to 4, and aggregates the deduped results into a single Tauri event. Triggered once on LSP start and re-fired 3s after `file-tree-changed` events on `.ts/.tsx/.js/.jsx` files. Files currently open in an editor stay owned by the LSP shim — the project-wide check skips them so it can't overwrite a more responsive in-flight result. Known limitation: tsgo does not yet support tsserver language-service plugins, so projects using Next.js's `"plugins": [{"name": "next"}]` (or Apollo, styled-components, etc.) will see spurious errors for types those plugins synthesize in-memory. Running `pnpm build` once materializes Next.js's `.next/types/` files and resolves most of its false positives until tsgo ships plugin support.
- Dev builds now use a separate bundle identifier (`com.softwaresavants.verun.dev`) and product name ("Verun Dev"), so dev and released apps have isolated SQLite databases and app data dirs — no more "migration N was previously applied but is missing" panics when running a released build after a newer dev session. Run dev with `pnpm tauri dev --config src-tauri/tauri.dev.conf.json` (or `make dev`).
- Diffs now open exclusively as full-size tabs in the main editor panel — clicking a file in the Changes pane opens a side-by-side diff (backed by `@codemirror/merge`) with syntax highlighting, search, and folding, instead of expanding an inline diff in the sidebar. Double-click pins the tab. Works for both working-tree changes and files inside any branch commit; toggleable inline view; tabs persist across reloads. The old inline diff renderer (custom hunk view, expand-context buttons, word-wrap and hide-whitespace toggles) has been removed.

## 0.5.0 — 2026-04-13

### Changes

- Add project dialog now always applies the user's edits to hooks, fixing a bug where clearing pre-populated fields from .verun.json had no effect
- Auto-detect section and "Or configure manually" label are hidden when .verun.json already provides hooks
- Persist `claude_session_id` eagerly from the `system.init` event at stream start instead of only after process exit - prevents session context loss on crashes, aborts, or abnormal exits
- Markdown images now render in chat, plan review, file preview, and file mention popups - local image paths are resolved to Tauri asset:// URLs via `convertFileSrc`
- File links in markdown are now clickable - relative paths open in Verun's file viewer instead of the browser, especially useful in plan review where links were previously inert

## 0.4.4 — 2026-04-12

### Changes

- Right-clicking a text selection in the editor now preserves the selection if the click lands inside it, so "Copy" from the context menu works instead of collapsing the cursor
- Editor context menu actions (Cut/Copy/Paste/Select All) now refocus the editor after dismissal so the selection stays visually active and keyboard shortcuts keep working
- File tree "Copy Absolute Path" now reads the worktree path synchronously from the store, fixing a silent clipboard failure caused by losing user-activation across an await
- Update banner now reflects checking / up-to-date / error states so "Check for Updates…" gives visible feedback instead of silently doing nothing when already on the latest version
- User message image attachments now render as small thumbnails above the chat bubble instead of inside it
- Click any image attachment thumbnail (in chat history or in the composer preview row) to open it full-screen, with one-click Copy to clipboard and Download to disk
- Image attachments are kept as raw `Uint8Array` bytes in the frontend (rendered through blob URLs instead of base64 `data:` URLs); the new copy and save commands use Tauri's raw-binary IPC instead of shipping a base64 string
- File editor background now matches the session chat background (`--surface-0`), and the surface palette is exposed as CSS variables so a future light theme can swap them at runtime without rebuilding
- Right pane (Changes/Files) background now matches the left sidebar (`--surface-1`) instead of blending into the editor
- Task top bar redesigned: smaller title, editor button collapsed to an icon-only control with a picker caret, git actions promoted from inside the Changes pane so they're always reachable, and the terminal toggle now uses an actual terminal icon with an active-state tint
- Top-bar controls share a `toolbar-btn` / `toolbar-chrome` UnoCSS shortcut and use a 1px `white/8` ring instead of borders, so future controls plug into the same chrome
- Tab bar redesigned: pill-shaped session/file tabs replaced with flat slabs that share a baseline with the editor panel, plus button collapsed to an icon and pinned to the start of the row, "+ New" label removed, scrollbar hidden, and the active tab gets a rounded `surface-0` body framed by an inset `white/8` outline that breaks into the editor panel below
- Editor/chat panel below the tab bar now has its own rounded `surface-0` chrome with `white/8` borders on three sides, framing the active tab as a continuous "tab pane"
- Session tabs render the official Claude mark from simple-icons (`#D97757`); unread non-running sessions get a slow accent pulse instead of a dot
- Breadcrumb bar in the file viewer no longer paints its own grey background — it now sits on the editor's `surface-0`
- Left sidebar redesigned: redundant "PROJECTS" header removed, project rows turned into uppercase section labels with a per-project colored chip (deterministic 18-color palette hashed from project id), task tiles got a single inset accent strip on selection (replacing the previous border + tinted bg + radius hacks), the archive button absolute-positioned so the title row uses the full width, and the footer collapsed from two rows of icon+label into a compact icon-only strip
- Hover transitions stripped from dense list elements (tabs, sidebar rows, file tree) — feedback is now instant instead of fading over 150ms
- Shared `ContextMenu` component (and `ContextMenuItem` type) replaces five hand-rolled context menu blocks across Sidebar, TaskPanel (file tabs), CodeEditor, FileTree, and ProblemsPanel; supports `icon`, `shortcut`, `danger`, `disabled`, and `separator` items, all sharing the new `surface-2` + `white/8` ring chrome
- Problems pane redesigned: lucide severity icons (`XCircle`/`AlertTriangle`/`Info`) replace ASCII chars, error/warning counts in file headers are now color-tinted, hover surfaces unified to `surface-2`, severity icons aligned with the file icon column, and the context menu uses the shared component
- File tree: active (currently-open) file gets the same inset accent strip as the selected sidebar task, selected and active rows share `surface-2` instead of stacking two different greys, folder icons toned down from accent green to `text-text-dim`, and the indent step tightened from 16px to 12px
- Top-bar git divider/section now hides when there's nothing to ship (no PR, no commits, no dirty files) — no more orphaned divider pair
- Top-bar control gap bumped from `gap-1` to `gap-2` so the editor / Start / Terminal cluster has breathing room
- Changes pane redesigned: header rows merged into a single h-9 strip with stats on the left and view toggles on the right, borders unified to `white/8`, open file row now uses `surface-2` plus an inset accent strip (matching the file tree's open file and the sidebar's selected task), selected commit and "Uncommitted changes" tile use the same accent-strip pattern instead of the heavy `bg-accent-muted`, file rows now follow VS Code's source-control style (file type icon on the left, status letter `M`/`A`/`D`/`R`/`U` on the right with the status color, no font-mono path), `transition-colors` removed from rows, and the uncommitted-changes circle no longer flashes amber
- Shell PATH capture upgraded from `-lc` to `-lic` so `.zshrc` (where nvm/fnm/asdf/mise live) is sourced — claude, the language server, git, and gh now see the user's nvm-default node version instead of an outdated system one
- New `env_path` module with a background watcher that reloads PATH when the integrated terminal goes idle after a user-committed command (tmux-style: tracks the last PTY output byte and waits for 500ms of silence after a `\n`/`\r` from the user). Window focus also triggers a debounced reload (≥30s) to catch installs done in an external terminal. Both auto-paths funnel through the same `reload_env_path` IPC command, so a manual escape hatch is one wire away

## 0.4.3 — 2026-04-12

### Changes

- Right sidepane (Changes/Files) now defaults to a narrower width and is drag-resizable like the left sidebar, with width persisted across launches
- Merged editor hover into a single tooltip — diagnostic message on top, type info below — instead of stacking the LSP type popup on top of the error popup
- "Ask agent to fix" button in the diagnostic hover — prefills the message input with a templated request referencing the current file, switches to the session tab, and focuses the input; sending is left manual
- LSP server start failures, `window/showMessage` errors, and unexpected vtsls process exits now surface as 10s dismissible toasts instead of being silent
- Reload open file tabs from disk when Verun regains focus; toast for dirty tabs that diverged externally, and prompt to overwrite or discard at save time
- Instant hover feedback on list rows and tiles — removed the 150ms fade
- Escape key closes any open context menu, dropdown, or popover
- Fix CMD+Number task selection order to match the sidebar when multiple projects are open (iterate projects then tasks within each, instead of flat insertion order)
- Draft message, attachments, mode switches (plan/thinking/fast), and last selected task now persist across app restarts
- Switched bundled LSP from typescript-language-server to vtsls for project-wide diagnostics support
- Problems panel — collapsible section at the bottom of the Changes/Files pane showing project-wide TypeScript diagnostics via `enableProjectDiagnostics`, grouped by file with resizable height
- Click any problem to jump to the exact line and column in the editor
- Command palette (CMD+Shift+P) with restart TypeScript server, open settings, open archived, and start dev server
- File tree and open file tabs highlight red for files with errors, yellow for warnings
- Folders in the file tree highlight when any descendant file has errors
- Find in session (Cmd+F) — search through chat messages with match highlighting and navigation
- Fix project-wide diagnostics not loading — transport-level handling of vtsls `workspace/configuration` requests so `enableProjectDiagnostics` takes effect during initialization, not after
- Fix diagnostics batch crash when first problems arrive for a task
- Problems panel skips gitignored files — uses `git check-ignore` to respect `.gitignore`, `.git/info/exclude`, and global ignore patterns
- @mentioned files render as inline badges in the input and sent messages — hover to preview with syntax highlighting, click to open in the editor
- Media viewer — images, video, and audio files open natively from the file tree with proper rendering instead of failing as binary
- Markdown preview — `.md` files render as styled WYSIWYG with a preview/edit toggle to switch between rendered output and the code editor
- SVG viewer — `.svg` files render visually with a preview/edit toggle for the XML source
- Hover previews on @mentioned files now support media (images, video, audio), rendered markdown, and SVG visual previews
- Cursor position, selection, and scroll position are preserved when switching between file tabs
- Undo/redo history persists across tab switches — Cmd+Z works on the full edit history after switching back
- Breadcrumb path bar at the top of the editor — click any segment to see sibling files/folders and jump to them
- Open tabs, active file, and MRU stack persist to localStorage per task — survives app restart
- Editor auto-focuses when switching tabs so the cursor is visible and keyboard input works immediately
- Fix closing a dirty tab without saving showing stale edits when reopened
- Multi-window support — pop out any task into its own window via double-click, right-click "Open in New Window", or Cmd+Shift+N to create a new task in a dedicated window (setup hooks in task windows coming later)

## 0.4.2 — 2026-04-11

### Changes

- Clean DMG installer — removed stray .VolumeIcon.icns file, resized window for better icon centering
- Setup hooks now stream live output into an xterm.js terminal tab instead of showing a blind spinner — see exactly what your hook is doing as it runs
- Hook terminal tabs appear first in the terminal panel with status indicators (spinner while running, green check on success, red alert on failure)
- Stop a running setup hook mid-execution with the new Stop button in the setup banner
- Re-run failed or completed setup hooks from the banner or terminal tab
- Manual hook execution via new run_hook/stop_hook IPC commands for both setup and destroy hooks
- PTY exit events now include the process exit code for richer status reporting
- Start/Stop button in the task header to run the start command in a read-only "Dev Server" terminal tab (always first tab)
- Start command terminals detect when the process exits (Ctrl+C, crash) and transition to stopped state — input is blocked after exit
- Auto-start toggle in project settings and add-project dialog (off by default) — when enabled, the start command runs automatically for new tasks
- Adding a project via manual config now auto-opens the new task dialog so you can start working immediately
- Fix deleting a project not clearing the selected task/session when the open task belonged to that project
- Rename tasks from the right-click context menu
- Auto-name tasks on every new message while the name is still blank, not just the first message
- Add project dialog pre-populates hook fields from .verun.json when one exists in the repo

## 0.4.1 — 2026-04-11

### Changes

- Static release filenames — download URLs no longer change between versions
- Cmd+hover underline in code editor — holding Cmd while hovering over a symbol shows a VS Code-style underline and pointer cursor, signaling it's clickable for go-to-definition

## 0.4.0 — 2026-04-10

### Changes

- Auto-update — checks for updates on launch, shows a non-intrusive banner with download progress and one-click restart; also available via Verun > Check for Updates menu item; CI pipeline now generates signed updater artifacts and latest.json for all platforms
- Steps — plan follow-up messages in a step list above the input. Enter adds a paused step while Claude is working, Shift+Enter adds an armed step (auto-sends on idle). Cmd+Enter fires the next step when idle or redirects when running. Steps persist across sessions and app restarts. Drag to reorder, click to arm/disarm.
- Unread indicator on session tabs — accent dot appears when a non-selected session receives new output, cleared on selection
- Fix merge PR showing error toast when main branch is checked out in another worktree
- Archive tasks instead of deleting — stops sessions and closes terminals but keeps the worktree, branch, and DB records; archived tasks live on a separate Archived page accessible from the sidebar footer; spinner shows on the task row while archiving is in progress; CMD+number only counts active tasks
- Per-language file icons — TypeScript, JavaScript, React, Rust, Python, Go, Java, Ruby, PHP, C/C++, Swift, Kotlin, C#, Lua, Shell, HTML, CSS, Sass, Vue, Svelte, JSON, TOML, YAML, Markdown, and more — with official brand colors, shown in file tree, tabs, quick open, and file mentions
- Context menus on file tree and file tabs now work — clicks were being swallowed by Solid's event delegation before the handler could fire
- Tab bar auto-scrolls to the active file tab when opening a file
- Reveal file in tree — opening a file expands its parent directories, scrolls the file tree to it, and briefly highlights the row
- Base branch selector moved from sidebar context menu to project settings page for discoverability
- LSP always installed — moved language server install to postinstall hook so it runs on every `pnpm install` (local and CI), not just during production builds
- Token and cost usage display — per-turn cost + tokens shown next to duration on assistant messages, cumulative session cost in tab pills, and usage chip in the input toolbar with popover showing session stats and subscription reset timer
- Autodetect prompt rewritten — covers .env.example fallback, destroy hook for env file preservation, orchestrator passthrough config, inter-service URL rewriting, and explicit all-service port mapping
- OS notifications — macOS desktop notifications when tasks complete, fail, or need approval; suppressed when the task is already in view; toggle in Settings
- Unread / attention-required indicators on sidebar tasks — amber pulsing dot when a tool approval is pending, accent dot when new output arrives on a background task; cleared on task selection
- Non-blocking setup hooks — worktree creation returns instantly, setup hook runs in background so the chat UI appears immediately
- Message queuing during setup — type and send your first prompt while the hook runs, it auto-sends on completion
- Setup progress banner — slim inline indicator replaces the old full-screen spinner, with error state on failure
- Quick Open (CMD+P) — fuzzy file finder for jumping to files in the worktree, virtualized for large repos
- LSP integration — bundled typescript-language-server for autocomplete, diagnostics, hover, go-to-definition (F12 / CMD+Click), find references (Shift+F12), rename (F2), and format (Shift+Alt+F)
- LSP auto-restart — language server restarts when node_modules changes (e.g. after pnpm install)
- VS Code-style search panel — floating top-right widget with toggle buttons (Aa/W/.*), match counter, expand/collapse replace row
- File tree viewer — gitignore-aware directory browser with lazy loading, virtualized rendering, filesystem watching, and context menus
- Code editor — CodeMirror 6 with One Dark syntax highlighting, code folding, 15+ language modes, context menu with LSP actions
- Right panel tabs — Changes and Files tabs in the collapsible right panel
- Unified tab bar — sessions and editor file tabs share one tab bar in the main area; clicking a session shows chat, clicking a file shows the editor
- Per-task editor tabs — each task has its own set of open files; switching tasks preserves editor state
- Preview tabs — single-click opens a transient tab (italic) that gets replaced; double-click, editing, or saving pins it
- MRU tab switching — Ctrl+Tab goes to the last used tab, not the next in order
- Editor content caching — switching between tabs is instant with no loading flicker
- Editor tab management — open/close/reopen tabs, unsaved changes confirmation, tab context menu (Close, Close Others, Close All, Copy Path), CMD+W close, CMD+Shift+T reopen
- File tree context menu — open, copy path, reveal in Finder, refresh, collapse/expand
- CMD+E to toggle between Changes and Files panel
- Fix `.verun` folder location — worktrees now created inside the project directory, not the parent
- Project lifecycle hooks — setup hook runs after worktree creation, destroy hook before deletion, start command auto-runs in terminal
- Per-task port allocation — 10 unique ports (VERUN_PORT_0–9) and VERUN_REPO_PATH injected into all processes
- Auto-detect with Claude — analyzes project structure, detects env files, monorepo ports, and generates hooks
- `.verun.json` config file — shareable project config for hooks, auto-loaded when adding a project
- Settings page redesign — sidebar nav with General + per-project sections for hook configuration
- Project creation dialog — configure hooks on add, with auto-detect option
- Import/Export buttons — sync hooks between DB and `.verun.json` for team sharing
- Auto-expanding code textareas for hook editors with shell-like styling
- Keyboard shortcuts in settings — CMD+S to save, CMD+Enter in fields, CMD+Number to switch sections
- Hooks auto-applied from `.verun.json` when Claude session completes
- Fix Option+Arrow producing garbled characters instead of word navigation in terminal
- Turn duration — shows how long each turn took next to the copy button on hover

## 0.3.0 — 2026-04-08

### Changes

- Fix scroll jump when interrupting a turn
- Resolve user's login shell PATH at startup so bundled .app can find claude, git, etc.
- Cross-platform support for Windows, Linux, and macOS
- Platform-specific tauri config with macOS overlay titlebar override
- Keyboard shortcuts use Ctrl on Windows/Linux, Cmd on macOS
- Platform-adaptive clipboard, file manager, and shell commands
- Cross-platform terminal fonts and xterm options
- Conditional drag regions for macOS overlay titlebar
- Fix window drag using data-tauri-drag-region attribute
- Fix double-click maximize bouncing
- Multi-platform release builds: macOS ARM/Intel DMG, Windows .exe, Linux AppImage

## 0.2.1 — 2026-04-08

### Changes

- macOS code signing and notarization for GitHub releases

## 0.2.0 — 2026-04-08

### Changes

- Integrated terminal with PTY backend and per-task shell sessions
- Branch commits panel — view and diff individual commits
- Git actions overhaul with PR caching and commit count awareness
- Thinking and fast mode toggles, per-task input state
- Model selection scoped per task instead of per session
- Fix release workflow changelog extraction

## 0.1.1 — 2026-04-08

### Changes

- Automated GitHub release workflow — builds macOS ARM on push when VERSION changes
- `/bump-version` command to update version across all project files
- Settings: configurable defaults for word wrap and hide whitespace in diffs
- Sticky file headers when scrolling through expanded diffs
- Smart git action buttons — hide Push, Create PR, Merge PR, Review based on actual state
- Filter out directories from file changes list
- Conflict resolution uses rebase instead of merge

## 0.1.0 — 2026-04-07

Initial release of Verun — parallel Claude Code session orchestrator for macOS.

### Core
- Project management with git repo integration
- Task system with isolated git worktrees and auto-generated branch names
- Resumable Claude Code CLI sessions with multiple sessions per task
- Real-time streaming output with stdout/stderr buffering

### Chat & AI
- Full chat UI with Claude Agent SDK streaming
- Model selection (Opus, Sonnet, Haiku) per session or global
- Slash command support forwarded to Claude CLI
- Plan mode for reviewing and approving implementation plans
- Tool approval system with configurable trust levels (Normal, Supervised, Full Auto)
- Interactive question handling (AskUserQuestion)
- Thinking block display with collapsible sections

### Code Changes
- Git status with inline unified diffs and syntax highlighting
- Expandable diff context (load above/below)
- Word wrap and hide-whitespace toggles with configurable defaults
- Sticky file headers when scrolling through diffs
- Smart git actions: Commit, Push, Create PR, Merge PR, Review
- GitHub PR status, CI checks display, and direct links
- Conflict resolution via rebase

### UI
- Native macOS app with transparent titlebar
- Customizable accent color themes
- Resizable sidebar with project/task tree
- Terminal rendering via xterm.js
- Splash screen to prevent unstyled content flash
- Toast notifications
- Keyboard shortcuts for common actions
- Links open in system browser

### Infrastructure
- Tauri v2 with Rust backend
- SQLite persistence with async write queue
- Pre-commit hooks with full test suite (110 Rust tests, 18 frontend tests)
- Clippy-clean, type-checked frontend
