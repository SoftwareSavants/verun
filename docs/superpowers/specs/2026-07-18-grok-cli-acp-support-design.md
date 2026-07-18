# Grok CLI support via ACP

**Date:** 2026-07-18
**Status:** Design approved, pending spec review

## Goal

Add xAI's **Grok CLI** (`grok`, v0.2.103) as a first-class agent in Verun with
**full UI parity**: streamed reasoning + assistant text, tool-call cards with
diffs and command output, interactive permission approvals, resume, and
usage/cost reporting.

## Background: what Grok CLI is

`grok` is an agentic coding CLI shaped like Claude Code / Codex. It exposes an
interactive TUI plus non-interactive modes. Two non-interactive surfaces exist:

1. `grok -p "<prompt>" --output-format streaming-json` — a one-shot headless
   stream. Emits only `{"type":"thought"|"text"|"end"}`. **Tool calls are
   invisible** in this mode (verified: Grok read a file and wrote another,
   emitting zero tool events). Rejected — no parity.

2. `grok agent stdio` — a persistent, bidirectional **ACP (Agent Client
   Protocol, `protocolVersion: 1`)** session over newline-delimited JSON-RPC
   2.0 with x.ai extensions. Surfaces reasoning, assistant text, tool calls,
   diffs, plans, usage, and interactive permission requests. **This is the
   integration surface.**

### ACP protocol shape (captured live)

- `initialize {protocolVersion:1, clientCapabilities}` → `{agentCapabilities:
  {loadSession:true, ...}, authMethods, _meta:{modelState:{availableModels:
  [grok-4.5 with reasoningEfforts high|medium|low]}}}`
- `session/new {cwd, mcpServers}` → `{sessionId, models}`
- `session/load {sessionId, cwd, mcpServers}` → resume (`loadSession:true`
  advertised)
- `session/prompt {sessionId, prompt:[{type:"text", text}]}` → runs a turn,
  resolves `{stopReason:"end_turn", _meta:{sessionId, usage/cost}}`
- Streamed `session/update` notifications:
  - `agent_thought_chunk` `{content:{type:"text",text}}` → thinking deltas
  - `agent_message_chunk` `{content:{type:"text",text}}` → assistant text deltas
  - `tool_call` `{toolCallId, title, rawInput, _meta:{"x.ai/tool":{name, kind,
    label, read_only}}}` → new tool card
  - `tool_call_update` `{toolCallId, status:"in_progress"|"completed"|"failed",
    content:[{type:"content"|"diff", ...}], rawOutput, locations}` → tool
    progress, output, and **diffs** (`{type:"diff", path, oldText, newText}`)
  - `plan`, `available_commands_update`, `session_summary_generated`,
    `pending_interaction`, `interaction_resolved` (advisory)
  - `turn_completed` `{stop_reason, usage:{inputTokens, outputTokens,
    cachedReadTokens, reasoningTokens, costUsdTicks, modelUsage}}`
- Server→client request `session/request_permission {sessionId, toolCall,
  options:[{optionId, name, kind}]}` where `kind ∈ {allow_always, allow_once,
  reject_once}` → client replies `{outcome:{outcome:"selected", optionId}}`.
  Maps directly onto Verun's existing approval UI.
- Cancel: `session/cancel {sessionId}`.

### Key integration decisions

- **Do not advertise client `fs` capability** in `initialize`. Grok then does
  its own file I/O directly (verified working). Avoids implementing
  `fs/read_text_file` / `fs/write_text_file` handlers.
- Grok is **persistent across turns** (`persists_across_turns = true`), one
  process per Verun session — architecturally a twin of the Codex app-server
  path, not the stateless Cursor/Gemini path.
- Resume id = `sessionId`, only stable after a turn completes →
  `defers_resume_id_until_turn_end = true`.

## How Verun integrates agents today (the seam)

Every agent detail lives behind the `Agent` trait (`src-tauri/src/agent/`).
Two streaming paths exist, selected by `agent.uses_app_server()`:

- **Loop A — line-oriented `stream-json`** (`stream.rs::stream_and_capture`):
  Claude, Cursor, Gemini, OpenCode. Assumes the Anthropic-SDK envelope.
- **Loop B — JSON-RPC over stdio** (`stream.rs::stream_and_capture_rpc`,
  `task.rs::spawn_codex_app_server_session`): Codex only.

**Loop B's transport is already generic.** `agent/codex_rpc.rs`
(`classify_line`, `route_message`, `spawn_reader`, `call`, `write_frame`,
`next_request_id`, `PendingRpcResponses`, `CodexRpcEvent`) is a pure
newline-delimited JSON-RPC 2.0 transport — nothing Codex-specific but the
names. What *is* Codex-specific: the handshake sequence, the
notification→entry decode, approval classification, and the `encode_rpc_*`
trait encoders.

## Design

Grok reuses Loop B. Per the approved direction, we **generalize the
Codex-shaped RPC path into a protocol-agnostic driver** that both Codex and
Grok/ACP flow through, rather than cloning it. The already-generic transport
makes this low-to-moderate risk; the existing exhaustive Codex encoder/decoder
tests are the regression safety net.

### 1. Transport module: `codex_rpc.rs` → `rpc.rs`

Rename `agent/codex_rpc.rs` to `agent/rpc.rs` and its `CodexRpcEvent` →
`RpcEvent` (and generic-ize the hardcoded "Codex app-server" strings in
error/EOF messages). Pure rename + string edits; no behavior change. Both
protocols use it verbatim.

`is_recoverable_thread_resume_error` stays as a Codex helper (ACP resume
recovery, if any, is a separate concern — see §7).

### 2. Protocol seam on the `Agent` trait

Introduce a capability flag and a decode/encode surface so the driver never
switches on agent identity:

- Replace/augment `uses_app_server()` with a protocol selector. Concretely:
  keep `uses_app_server()` semantics but rename the concept to
  `uses_rpc()` (returns true for Codex **and** Grok), plus an
  `rpc_protocol()` accessor if the driver needs to branch on sequence details.
  (Exact shape decided in the plan; the constraint is: no `if kind == Codex`
  outside `agent/`.)
- **Handshake / turn sequence** expressed as trait methods the generic driver
  calls. Codex keeps `encode_rpc_initialize` / `encode_rpc_thread_start` /
  `encode_rpc_thread_resume` / `encode_rpc_turn_start` / `encode_rpc_turn_interrupt`.
  Grok adds ACP equivalents: `initialize` (no fs capability), `session/new`,
  `session/load`, `session/prompt`, `session/cancel`. These are exposed through
  a small protocol-step abstraction so `spawn_rpc_session` (see §3) is written
  once. The cleanest concrete form: a `RpcProtocol` sub-trait with
  `connect(...) -> frames`, `start_turn(...) -> frame`,
  `interrupt(...) -> frame`, returning the driver's next step; Codex and Grok
  each implement it. (Final trait boundary chosen during writing-plans after
  reading the full `spawn_codex_app_server_session` body.)
- **Notification decode** becomes a trait method:
  `decode_rpc_notification(&self, method, params, &mut RpcTurnState) ->
  Vec<RpcEffect>` where `RpcEffect` is the small set of things the stream loop
  already does (append assistant text, append thinking, upsert tool call,
  update tool call w/ diff, set plan, record usage, mark turn end). Codex's
  existing `process_codex_rpc_notification` logic moves behind its impl; Grok
  implements the ACP `session/update` mapping. The stream loop calls this and
  applies effects — no method-name switching in `stream.rs`.
- **Approval classification + response** become trait methods:
  `classify_rpc_approval(&self, method, params) -> Option<RpcApprovalRequest>`
  and `encode_rpc_approval_response(&self, server_request_id, decision)`.
  Codex maps its `applyPatchApproval` / `item/*/requestApproval` /
  `item/permissions/requestApproval`; Grok maps `session/request_permission`
  with `{allow_always, allow_once, reject_once}` → Verun's decision enum.
  The existing Codex-specific `CodexRpc*Decision` enums are unified into one
  driver-level `RpcDecision` (Approve / ApproveForSession / Deny / Abort) that
  each impl translates to its wire form.

### 3. Generic session driver

- `task.rs::spawn_codex_app_server_session` → `spawn_rpc_session`, generic over
  the trait. It: spawns `agent.cli_binary()` with `agent.build_session_args()`
  (Grok: `["agent","stdio"]`; cwd set via `Command::current_dir`, not argv),
  wires `rpc::spawn_reader`, runs the protocol's connect sequence to obtain the
  session/thread id, persists it (deferred), then drives turns.
- `stream.rs::stream_and_capture_rpc` and `process_codex_rpc_notification`
  become protocol-agnostic: pump `RpcEvent`s, dispatch notifications through
  `decode_rpc_notification`, route `ServerRequest`s through
  `classify_rpc_approval` → `PendingApprovals` → `encode_rpc_approval_response`.
- Cancel: `abort_message` for RPC agents calls the protocol's interrupt/cancel
  encoder. Grok → `session/cancel`; Codex → `turn/interrupt` (unchanged).
- Usage/cost extraction generalized from Codex's `extract_codex_token_usage`
  into a trait-provided or effect-carried value; Grok reads `turn_completed.usage`.

### 4. `grok.rs` — the Grok agent impl

New `src-tauri/src/agent/grok.rs`, unit struct `Grok`:

- Identity: `cli_binary() = "grok"`, `display_name() = "Grok"`,
  install/docs hints, `version_args() = ["--version"]`.
- `input_mode()` = the RPC variant; `build_session_args()` = `["agent","stdio"]`.
- `uses_rpc() = true`, `persists_across_turns() = true`,
  `abort_strategy() = Interrupt`.
- `supports_resume() = true`, `defers_resume_id_until_turn_end() = true`,
  `supports_effort() = true` (high/medium/low), `supports_attachments()` =
  false for v1 (ACP `promptCapabilities.image = false`),
  `supports_plan_mode() = false` (deferred, §7), `supports_skills() = false`,
  `supports_fork() = false`.
- `available_models()` = `[grok-4.5]` (only model on this login; internal id
  `grok-4.5-build`). No dynamic `model_list_args` for v1.
- ACP connect / turn / interrupt / notification-decode / approval methods per §2.
- `extract_resume_id()` reads `sessionId` from the `session/new` result and the
  `turn_completed` / prompt result.

### 5. `AgentKind` + registration

`agent/mod.rs`: add `Grok` variant; wire `parse` (`"grok"`), `as_str`,
`all()`, `implementation()`; add `mod grok;` + `pub use grok::Grok;`.

### 6. Frontend

- `src/types/index.ts`: add `"grok"` to `AgentType` and `AGENT_DISPLAY_NAMES`
  (TS enforces exhaustiveness).
- `src/lib/agents.ts`: import a `grokIcon`, register in `AGENT_ICONS`,
  re-export; add `src/assets/icons/grok.svg`.
- Everything else — agent/model pickers, approval UI, tool cards, diffs,
  effort selector — is already capability-gated off `AgentInfo` and flows
  automatically once the backend reports Grok's flags.

### 7. Scope boundaries / deferred follow-ups

v1 ships: interactive chat, streamed thinking + text, tool cards with diffs and
command output, interactive approvals, resume, usage/cost, effort selection.

Deferred (not in v1):
- **Plan mode** over ACP — no native plan/read-only permission mode observed in
  the ACP surface. Marked `supports_plan_mode = false`; investigate an ACP
  session-level setting or `_meta` toggle later.
- **Attachments/images** — ACP advertises `image:false`.
- **MCP passthrough** — Grok loads its own user MCP servers; Verun's per-task
  `.mcp.json` injection is not wired for Grok in v1.
- **Skills / slash commands** discovery.
- **ACP resume-error recovery** (fall back to `session/new` when `session/load`
  fails) — add if live testing shows stale-session failures.

## Testing (TDD)

Rust unit tests over the **real captured ACP fixtures** from the live session,
following the exhaustive Codex encoder/decoder test patterns in
`agent/mod.rs::tests`:

- `grok.rs`: `build_session_args` = `["agent","stdio"]`; capability flags;
  `extract_resume_id` from `session/new` result and `turn_completed`.
- ACP encode: `initialize` omits fs capability; `session/new` carries cwd;
  `session/load` carries sessionId; `session/prompt` wraps text; `session/cancel`.
- ACP decode: `agent_thought_chunk`/`agent_message_chunk` → text/thinking
  effects; `tool_call` → tool card; `tool_call_update` with `{type:"diff"}` →
  diff; `turn_completed` → usage.
- Approval: `session/request_permission` classified; `allow_once`/`reject_once`
  responses encode correct `{outcome:{outcome:"selected", optionId}}`.
- **Regression:** the existing Codex RPC tests must all pass unchanged after the
  generalization — they are the contract that the refactor preserved Codex
  behavior.

Integration: drive a real `grok agent stdio` session end-to-end in
`pnpm tauri dev` — verify streaming, a tool call with a diff, an approval
prompt, resume across turns, and usage display.

## Definition of done

`make check` green, clippy clean, no TS errors, works end-to-end in dev, changes
committed, CHANGELOG/ROADMAP/README updated.
