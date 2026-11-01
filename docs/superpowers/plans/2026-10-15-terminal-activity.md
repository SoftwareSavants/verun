# Harness activity and terminal status plan

Status: Claude terminal observer implementation in progress. Research completed 2026-10-15; isolated CLI probes now verify lifecycle hooks. Other harness adapters remain planned.

## Scope and evidence

Verun supports six harnesses. Managed interactive terminal mode currently exists only for Claude (`src-tauri/src/claude_terminal.rs`). Codex uses app-server RPC, Grok uses ACP, and Cursor/Gemini/OpenCode use headless JSON output. Monitoring their interactive terminals requires separate launch/lifecycle integration; hooks alone do not add terminal mode.

Local version probes: Claude 2.1.300, Codex 0.159.2, Grok 1.0.34, OpenCode 1.18.4. Gemini was not found on PATH. `agent` resolves to `/Users/abdulrahman/.grok/bin/agent` and reports Grok 0.2.112, whereas Verun's Cursor adapter requests `agent`. Follow-up: `cursor-agent` resolves to `/Users/abdulrahman/.local/bin/cursor-agent` and reports Cursor version `2026.07.23-e383d2b`; its help confirms stream-json and per-launch `--plugin-dir` support. Cursor is installed under this unambiguous executable name. These are identity/version probes, not live event validation.

## Harness-by-harness findings

### Claude Code
- Documented: UserPromptSubmit, PermissionRequest, Stop, StopFailure, SessionEnd, tool events, and MCP elicitation events.
- Plan: attach session-scoped observer hooks at managed PTY launch. Prompt starts work; actual permission/input requests set waiting; corresponding completion/activity clears only the resolved wait; final stop sets idle. Track AskUserQuestion and plan approval separately from ordinary tool execution.
- Validate: cancellation, automatic permissions, blocked Stop hooks continuing a turn, parallel tools/subagents, resume, and process exit. A pre-tool event alone does not prove permission was granted.
- Source: https://code.claude.com/docs/en/hooks

### Codex
- Current official documentation includes UserPromptSubmit, PermissionRequest, PostToolUse, Stop, Interrupt, SessionEnd, and subagent events. This is broader than the old completion-only notify mechanism.
- Existing structured mode should continue using app-server events and approval requests. Future interactive mode can use hooks; prove coverage on the installed version before enabling it.
- Validate: request-user-input/plan interactions, approval resolution, cancellations and subagent attribution. Subagent hooks can carry the parent's session ID, so session ID alone is insufficient. Transcript format is not a stable integration contract.
- Source: https://learn.chatgpt.com/docs/hooks

### Gemini CLI
- Documented: BeforeAgent/AfterAgent turn boundaries, BeforeTool/AfterTool, session lifecycle, and Notification with ToolPermission type.
- Plan: command hooks feed the same local bridge. Permission notifications indicate waiting; tool/model progress and turn completion reconcile it.
- Unverified: installed-version behavior (CLI absent), cancellation, denied approvals, and non-permission questions. Confirm ordering before treating BeforeTool as a resume signal.
- Source: https://geminicli.com/docs/hooks/reference/

### Cursor Agent
- Documented hook family includes beforeSubmitPrompt, stop, session lifecycle and tool hooks. Local inspection of Cursor 2026.07.23-e383d2b confirms beforeSubmitPrompt and stop dispatcher handlers with conversation_id and generation_id; stop also forwards status and loop_count. This is installed-code evidence, not an end-to-end event capture. Permission-policy hooks must not be mistaken for proof that a human-facing approval dialog is open.
- Plan: prefer the verified `cursor-agent` executable over the ambiguous `agent` alias, then test CLI hook support using a per-launch plugin. Keep headless stream lifecycle as the current source; enable interactive start/stop coverage only after a CLI fixture proves it. Waiting detection remains partial until approval and AskQuestion events are verified.
- The installed Claude-hook compatibility map explicitly maps PermissionRequest and Notification to null. This rules out copying Claude approval hooks as-is; it does not prove every possible native input signal is absent. AskQuestion exists internally, but no public observer hook for it was verified. Mark terminal approval/input coverage partial until independently demonstrated.
- Do not install permissive hooks merely to observe status or assume editor/cloud support means identical CLI behavior.
- Source: https://cursor.com/docs/hooks

### Grok Build
- Official source documents UserPromptSubmit, Stop, Notification, session lifecycle, and tool hooks, with command/HTTP handlers and multiple configuration sources.
- Plan: retain ACP state for structured mode; test native TUI hooks for interactive mode. Verify the exact permission notification schema, denial/cancel handling and session mapping in Grok 1.0.34.
- Grok also loads Claude-compatible hook configuration, so every bridge invocation must validate harness identity and launch token to avoid duplicate or misattributed events.
- Source: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/custom-hooks.md

### OpenCode
- Documented plugin events include session.status, session.idle, session.error, permission.asked and permission.replied. Its server also exposes an event stream.
- Plan: prefer a local server event subscription when Verun owns the server/TUI connection; otherwise use a minimal observer plugin. Do not run a second independent session just to obtain status.
- Verify busy/retry/idle payloads, question requests, reconnect snapshots and session isolation against 1.18.4. Permission replies clear a specific wait, not all pending requests.
- Sources: https://opencode.ai/docs/plugins/ and https://opencode.ai/docs/server/

## Shared architecture

1. Add a Rust-owned activity model independent of process liveness and task completion: unknown, idle, working, waiting, failed, ended. Include session ID, harness, launch generation, turn ID when available, pending request IDs, source and coverage (full/partial/unavailable).
2. Normalize existing structured adapters into this model first. Keep activity separate from the process-management flags used to spawn/send/kill agents; board changes must not accidentally launch duplicate processes.
3. Add a small Rust hook relay and authenticated local transport. Bind events to a Verun-managed launch, constrain payload size, strip prompts/tool arguments, and ignore stale/foreign generation tokens. Return provider-specific neutral output; never approve, deny, inject context, or block continuation. Preserve user hooks and configuration. Prefer per-launch overlays/plugins, with an explicit fallback design if a provider cannot isolate config.
4. Maintain pending waits per request and aggregate per session/task. Attention takes priority over working; archived is a task lifecycle override. Tool failure alone is not terminal failure when the agent is still recovering. Subagent completion must not mark the parent idle.
5. Push updates through Tauri events and offer an initial snapshot for reloads/detached windows. Rust monitors process exit. Disconnect/missing coverage becomes unknown, not idle; time without output is not proof of completion. Unsupported sessions appear in a clearly labeled Status unavailable section rather than falsely under Ready.
6. Preserve the existing board columns and Git attention rules. Both sidebar and board consume the shared activity model. Approvals remain in the harness UI for terminal sessions.

## Delivery order and gates

- [ ] Capability audit fixtures: independently capture start, waiting, approval/denial, resumed work, finish, interrupt and exit for each harness/version. Record coverage, including unsupported events. No automatic CLI upgrades.
- [ ] Shared reducer, local relay, snapshot/event IPC and provider capability reporting. TDD for ordering, duplicate events, stale launches, multiple waits, subagents and concurrent tasks.
- [ ] Claude terminal adapter, because it is the existing managed-terminal gap. Verify in the native app before declaring Kanban terminal-ready.
- [ ] Codex: unify current app-server activity, then add interactive lifecycle integration as a distinct feature with hooks.
- [ ] Grok: unify current ACP activity, then validate and integrate TUI hooks.
- [ ] OpenCode: event subscription/plugin adapter and managed-terminal launch integration.
- [ ] Gemini: install/identify an appropriate CLI in a deliberate test environment, validate hooks, then implement terminal integration.
- [ ] Cursor: prefer `cursor-agent` in executable discovery and complete the CLI event probe before promising full waiting detection.

Providers can ship independently once their coverage gates pass. Partial support is explicit; no regex spinner scraping, CPU-based busy detection, frontend polling, or direct vendor API credentials.

## Acceptance tests

- New/resumed terminal starts with a verified state or unknown, never inferred working solely from a live process.
- Submit -> working -> approval/input -> waiting -> response -> working -> finished -> idle.
- Denial, Escape/Ctrl-C, API failure, retry, unexpected exit and app reload cannot leave a false running/waiting state indefinitely.
- Two sessions in one task, two tasks in one directory, detached windows and subagents remain correctly attributed.
- Existing user hooks continue to run, and an unavailable relay never changes approval decisions or agent behavior.
- Documentation-only research is complete. Implementation requires failing tests first, full make check, warning-free Clippy, frontend typecheck and native end-to-end verification per repo instructions.

## Claude implementation notes (2026-10-15)

- Activity has its own Rust store and monotonically revisioned snapshot/events; process lifecycle flags remain unchanged. Board and sidebar normalize structured status alongside terminal observations.
- The Verun executable has a silent `--verun-activity` relay mode that runs before Tauri initialization. Per-launch `--settings` hooks post only allowlisted metadata to a loopback socket with a random token. No global/project configuration is written; hook failures return neutral success. The relay bounds payload size and execution time.
- Claude's PermissionRequest has no tool_use_id. Anonymous permission waits remain until PostToolBatch or a turn boundary, rather than being cleared by an unrelated tool. Explicit request IDs are tracked independently.
- Escape/Ctrl-C make status unknown until a subsequent hook; process exits reconcile without waiting for renderer acknowledgement. Closing terminal mode releases its override. Older launch tokens, foreign native session IDs and subagent events cannot overwrite the main session.
- Coverage remains partial: permission approval can continue displaying waiting until its tool batch finishes; stop hooks can subsequently be blocked by other hooks; subagent waits and sandbox permission notifications are not covered. No silence/spinner heuristic is used. Native end-to-end verification is still required; desktop automation times out attaching to the dev app.
- Remaining delivery gates above are intentionally unchecked until the full native interaction matrix passes. Other providers' managed terminal integration is not included in this change.

### Verification and related duplication fix

- Claude 2.1.300 print-mode lifecycle probe: SessionStart → UserPromptSubmit → Stop → SessionEnd, with neutral relay output and a successful response.
- Forced-denial probe: PreToolUse → PermissionRequest (no tool_use_id) → PostToolBatch → Stop. The observer did not approve the command.
- Native session clear/resume boundaries are handled separately from PTY exit; stale events from the former session are ignored after rebinding.
- #277: SDK input UUIDs and assistant message IDs were verified against the installed CLI's JSONL. Both ingestion paths now share identity-based ownership, preserving intentional repeated text. This prevents new duplicates; old persisted duplicates lack sufficient provenance for safe automatic removal. Process handoff/scheduling remains tracked separately in #256.
- Broader parent/subagent UX and aggregate child activity are tracked in #67.
