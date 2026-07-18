# Grok CLI Support via ACP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add xAI's Grok CLI as a first-class Verun agent with full UI parity (streamed reasoning + text, tool cards with diffs, interactive approvals, resume, usage) by driving `grok agent stdio` over ACP.

**Architecture:** Grok speaks ACP (Agent Client Protocol), a persistent bidirectional JSON-RPC 2.0 session over stdio — the same transport shape as Codex's `app-server`. We **generalize** the currently Codex-shaped RPC path into one protocol-agnostic driver that both Codex and Grok flow through: rename the transport module, replace the Codex-named trait encoders/decoders with a generic RPC seam on `Agent`, and make `spawn_rpc_session` + `stream_and_capture_rpc` dispatch entirely through trait methods. Then add the `Grok` impl. The exhaustive existing Codex tests are the regression safety net — they must stay green through the refactor.

**Tech Stack:** Rust (Tauri v2 backend), Solid.js + TypeScript frontend, serde_json, tokio, dashmap.

## Global Constraints

- TDD always: red test → implement → green → commit. `cargo test` (Rust), `pnpm test` (frontend).
- Never `if agent_kind == X` outside `src-tauri/src/agent/` — add a trait method instead (`agent/mod.rs:10-12`).
- Agent impls are zero-sized structs; no state on the struct.
- `make check` green, `cargo clippy` zero warnings, no TS errors before done.
- No em dashes in code comments or docs the user reads; use hyphens.
- Every `#[tauri::command]` needs a typed wrapper in `src/lib/ipc.ts` (no new commands in this plan).
- Frontend list rendering uses `<For>`, never `<Index>`.
- The regression contract: **all pre-existing Codex tests in `agent/mod.rs::tests`, `agent/codex_rpc.rs::tests` (→ `agent/rpc.rs::tests`), and any Codex stream tests must pass unchanged after each task.**

## Naming reference (generic RPC seam)

These names are introduced in Task 2 and used everywhere after. Use them verbatim.

- Module: `agent/rpc.rs` (was `agent/codex_rpc.rs`)
- Event enum: `RpcEvent` (was `CodexRpcEvent`)
- Param types: `RpcClientInfo`, `RpcStartParams`, `RpcResumeParams`, `RpcTurnParams`
- Usage: `RpcTokenUsage { input_tokens, output_tokens, cached_input_tokens }`
- Decision: `RpcApprovalDecision { Approve, ApproveForSession, Deny, Abort }`
- Capability flag: `uses_rpc()` (was `uses_app_server()`)
- Trait methods (all on `Agent`): `rpc_encode_initialize`, `rpc_encode_initialized` (→ `Option`), `rpc_encode_start`, `rpc_encode_resume`, `rpc_parse_session_id`, `rpc_encode_turn`, `rpc_parse_turn_id` (→ `Option`, default `None`), `rpc_encode_interrupt` (→ `Result<Option<Vec<u8>>, String>`), `rpc_decode_notification`, `rpc_extract_usage`, `rpc_is_approval`, `rpc_build_approval_entry`, `rpc_encode_approval_response`, `rpc_is_recoverable_resume_error`
- `ActiveProcess` fields renamed: `rpc_session_id`, `rpc_pending`, `rpc_next_id`, `rpc_current_turn_id` (were `codex_thread_id`, `codex_pending`, `codex_next_id`, `codex_current_turn_id`)
- Driver fns renamed: `spawn_rpc_session` (was `spawn_codex_app_server_session`), `FastPath::GoRpc` (unchanged name)

---

## PHASE 1 — Generalize the transport module (mechanical, low risk)

### Task 1: Rename `codex_rpc.rs` → `rpc.rs`, `CodexRpcEvent` → `RpcEvent`

**Files:**
- Rename: `src-tauri/src/agent/codex_rpc.rs` → `src-tauri/src/agent/rpc.rs`
- Modify: `src-tauri/src/agent/mod.rs:96` (`pub mod codex_rpc;` → `pub mod rpc;`)
- Modify: `src-tauri/src/agent/codex.rs`, `src-tauri/src/task.rs`, `src-tauri/src/stream.rs` (all `codex_rpc` references → `rpc`, `CodexRpcEvent` → `RpcEvent`)

**Interfaces:**
- Produces: module `crate::agent::rpc` with `RpcEvent` enum (variants `Notification{method,params}`, `ServerRequest{id,method,params}`, `ReaderClosed{reason}`, `ParseError{line,detail}`), and unchanged fns `new_pending_rpc_responses`, `next_request_id`, `spawn_reader`, `call`, `write_frame`, `register_pending`, `is_recoverable_thread_resume_error`, `classify_line`, `route_message`, types `PendingRpcResponses`, `JsonRpcError`, `ClassifiedMessage`, `ClassifyError`.

- [ ] **Step 1: Rename the file and the enum**

```bash
git mv src-tauri/src/agent/codex_rpc.rs src-tauri/src/agent/rpc.rs
```

In `src-tauri/src/agent/rpc.rs`: rename `pub enum CodexRpcEvent` → `pub enum RpcEvent` (line ~61) and every `CodexRpcEvent::` → `RpcEvent::`. Generalize the hardcoded strings so they aren't Codex-only:
- `"Codex app-server stdout closed"` → `"rpc transport stdout closed"`
- `"Codex app-server stdout error: {e}"` → `"rpc transport stdout error: {e}"`
- `"Codex app-server stdin is closed"` → `"rpc transport stdin is closed"`
- module doc header `# Codex app-server JSON-RPC transport` → `# JSON-RPC transport (Codex app-server, Grok ACP)`

Leave `is_recoverable_thread_resume_error` as-is (Task 7 generalizes recovery via a trait method; this helper stays for Codex).

- [ ] **Step 2: Update the module declaration**

In `src-tauri/src/agent/mod.rs` line 96: `pub mod codex_rpc;` → `pub mod rpc;`.

- [ ] **Step 3: Update all references**

```bash
grep -rn "codex_rpc\|CodexRpcEvent" src-tauri/src
```

Replace `crate::agent::codex_rpc` → `crate::agent::rpc`, `use crate::agent::codex_rpc;` → `use crate::agent::rpc;`, `codex_rpc::` → `rpc::`, `CodexRpcEvent` → `RpcEvent` across `task.rs`, `stream.rs`, `codex.rs`, and `mod.rs`. (Do NOT rename `CodexRpcClientInfo`/`CodexRpcThreadStartParams`/etc. yet — those are Task 2.)

- [ ] **Step 4: Run tests — expect green (pure rename)**

Run: `cargo test -p verun --lib agent::rpc`
Expected: PASS (the `rpc.rs::tests` module, formerly `codex_rpc::tests`).

Run: `cargo check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(agent): rename codex_rpc transport to generic rpc module"
```

---

## PHASE 2 — Generic RPC seam on the Agent trait, Codex ported onto it

### Task 2: Add generic RPC param/usage/decision types and trait method stubs

**Files:**
- Modify: `src-tauri/src/agent/mod.rs` (add types near lines 275-358; add trait methods near lines 447-615; add `uses_rpc`)
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Produces (new public types in `crate::agent`):
```rust
pub struct RpcClientInfo<'a> { pub name: &'a str, pub version: &'a str }
pub struct RpcStartParams<'a> { pub cwd: &'a str, pub trust_level: crate::policy::TrustLevel, pub model: Option<&'a str> }
pub struct RpcResumeParams<'a> { pub session_id: &'a str, pub cwd: &'a str, pub trust_level: crate::policy::TrustLevel, pub model: Option<&'a str> }
pub struct RpcTurnParams<'a> { pub session_id: &'a str, pub prompt: &'a str, pub image_urls: &'a [String], pub trust_level: crate::policy::TrustLevel, pub model: Option<&'a str>, pub effort: Option<&'a str>, pub plan_mode: bool }
#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum RpcApprovalDecision { Approve, ApproveForSession, Deny, Abort }
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)] pub struct RpcTokenUsage { pub input_tokens: u64, pub output_tokens: u64, pub cached_input_tokens: u64 }
```
- Produces (new `Agent` trait methods, all with defaults so existing agents compile):
```rust
fn uses_rpc(&self) -> bool { false }
fn rpc_encode_initialize(&self, _req_id: i64, _ci: &RpcClientInfo<'_>) -> Result<Vec<u8>, String> { Err("agent is not RPC-based".into()) }
fn rpc_encode_initialized(&self) -> Option<Result<Vec<u8>, String>> { None }
fn rpc_encode_start(&self, _req_id: i64, _p: &RpcStartParams<'_>) -> Result<Vec<u8>, String> { Err("agent is not RPC-based".into()) }
fn rpc_encode_resume(&self, _req_id: i64, _p: &RpcResumeParams<'_>) -> Result<Vec<u8>, String> { Err("agent is not RPC-based".into()) }
fn rpc_parse_session_id(&self, _start_response: &serde_json::Value) -> Option<String> { None }
fn rpc_encode_turn(&self, _req_id: i64, _p: &RpcTurnParams<'_>) -> Result<Vec<u8>, String> { Err("agent is not RPC-based".into()) }
fn rpc_parse_turn_id(&self, _turn_response: &serde_json::Value) -> Option<String> { None }
fn rpc_encode_interrupt(&self, _req_id: i64, _session_id: &str, _turn_id: Option<&str>) -> Result<Option<Vec<u8>>, String> { Err("agent is not RPC-based".into()) }
fn rpc_decode_notification(&self, _method: &str, _params: &serde_json::Value) -> Vec<crate::stream::OutputItem> { vec![] }
fn rpc_extract_usage(&self, _method: &str, _params: &serde_json::Value) -> Option<RpcTokenUsage> { None }
fn rpc_is_approval(&self, _method: &str) -> bool { false }
fn rpc_build_approval_entry(&self, _session_id: &str, _request_id: &str, _method: &str, _params: &serde_json::Value) -> crate::task::PendingApprovalEntry { unreachable!("rpc_build_approval_entry called on non-RPC agent") }
fn rpc_encode_approval_response(&self, _method: &str, _server_req_id: &serde_json::Value, _response: &crate::task::ApprovalResponse, _entry_input: &serde_json::Value) -> Option<Result<Vec<u8>, String>> { None }
fn rpc_is_recoverable_resume_error(&self, _message: &str) -> bool { false }
```

> NOTE: `OutputItem`, `PendingApprovalEntry`, `ApprovalResponse` already exist (`stream.rs`, `task.rs`). If import cycles bite, reference them by full path as shown.

- [ ] **Step 1: Write a failing test for the new default behavior**

Add to `agent/mod.rs::tests`:

```rust
#[test]
fn non_rpc_agents_default_rpc_seam_to_empty() {
    for agent in [Box::new(Cursor) as Box<dyn Agent>, Box::new(Gemini), Box::new(OpenCode)] {
        assert!(!agent.uses_rpc());
        assert!(agent.rpc_encode_initialize(1, &RpcClientInfo { name: "v", version: "0" }).is_err());
        assert!(agent.rpc_encode_initialized().is_none());
        assert!(agent.rpc_parse_turn_id(&json!({})).is_none());
        assert!(agent.rpc_decode_notification("x", &json!({})).is_empty());
        assert!(agent.rpc_extract_usage("x", &json!({})).is_none());
        assert!(!agent.rpc_is_approval("x"));
    }
}
```

- [ ] **Step 2: Run it — expect failure (types/methods don't exist)**

Run: `cargo test -p verun --lib non_rpc_agents_default_rpc_seam_to_empty`
Expected: FAIL to compile — `RpcClientInfo` / `uses_rpc` not found.

- [ ] **Step 3: Add the types and trait method defaults**

Add the six types from the Interfaces block after the existing `CodexRpc*` types (mod.rs ~358). Add the trait method defaults from the Interfaces block into `trait Agent` after the existing capability flags (mod.rs ~452). Keep the old `uses_app_server` and `encode_rpc_*` / `CodexRpc*` in place for now — Tasks 3-8 migrate off them, Task 8 deletes them.

- [ ] **Step 4: Run tests — expect green**

Run: `cargo test -p verun --lib non_rpc_agents_default_rpc_seam_to_empty`
Expected: PASS.
Run: `cargo test -p verun --lib agent::`
Expected: all existing agent tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): add generic RPC trait seam (types + method defaults)"
```

### Task 3: Implement the generic RPC encoders on Codex (handshake + turn + interrupt)

**Files:**
- Modify: `src-tauri/src/agent/codex.rs` (add generic methods delegating to the existing Codex logic)
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `RpcClientInfo`, `RpcStartParams`, `RpcResumeParams`, `RpcTurnParams` (Task 2).
- Produces: `Codex` overrides `uses_rpc`→true, `rpc_encode_initialize`, `rpc_encode_initialized`→`Some`, `rpc_encode_start`, `rpc_encode_resume`, `rpc_parse_session_id` (reads `/thread/id`), `rpc_encode_turn`, `rpc_parse_turn_id` (reads `/turn/id`), `rpc_encode_interrupt` (returns `Ok(Some)` when `turn_id.is_some()`, else `Ok(None)`), `rpc_is_recoverable_resume_error` (delegates to `rpc::is_recoverable_thread_resume_error`).

- [ ] **Step 1: Write failing tests mirroring the existing Codex encoder tests but through the generic methods**

Add to `agent/mod.rs::tests`:

```rust
#[test]
fn codex_generic_rpc_encoders_match_wire() {
    let a = Codex;
    assert!(a.uses_rpc());
    // initialize
    let v = parse_rpc_frame(&a.rpc_encode_initialize(1, &RpcClientInfo { name: "verun", version: "0.9.0" }).unwrap());
    assert_eq!(v["method"], "initialize");
    assert_eq!(v["params"]["capabilities"]["experimentalApi"], true);
    // initialized notification present
    let init = a.rpc_encode_initialized().expect("codex sends initialized");
    assert_eq!(parse_rpc_frame(&init.unwrap())["method"], "initialized");
    // start (thread/start)
    let s = parse_rpc_frame(&a.rpc_encode_start(2, &RpcStartParams { cwd: "/repo", trust_level: crate::policy::TrustLevel::Normal, model: Some("gpt-5.4") }).unwrap());
    assert_eq!(s["method"], "thread/start");
    assert_eq!(s["params"]["sandbox"], "workspace-write");
    // resume (thread/resume)
    let r = parse_rpc_frame(&a.rpc_encode_resume(3, &RpcResumeParams { session_id: "t-abc", cwd: "/repo", trust_level: crate::policy::TrustLevel::Normal, model: None }).unwrap());
    assert_eq!(r["method"], "thread/resume");
    assert_eq!(r["params"]["threadId"], "t-abc");
    // parse session id
    assert_eq!(a.rpc_parse_session_id(&json!({"thread": {"id": "t-9"}})), Some("t-9".into()));
    // turn (turn/start)
    let t = parse_rpc_frame(&a.rpc_encode_turn(4, &RpcTurnParams { session_id: "t-x", prompt: "hi", image_urls: &[], trust_level: crate::policy::TrustLevel::Normal, model: Some("gpt-5.4"), effort: Some("medium"), plan_mode: false }).unwrap());
    assert_eq!(t["method"], "turn/start");
    assert_eq!(t["params"]["threadId"], "t-x");
    // parse turn id
    assert_eq!(a.rpc_parse_turn_id(&json!({"turn": {"id": "turn-7"}})), Some("turn-7".into()));
    // interrupt: Some(turn) -> Some(frame); None -> None
    let i = a.rpc_encode_interrupt(5, "t-x", Some("turn-7")).unwrap().expect("frame");
    assert_eq!(parse_rpc_frame(&i)["method"], "turn/interrupt");
    assert!(a.rpc_encode_interrupt(6, "t-x", None).unwrap().is_none());
    // recoverable resume error
    assert!(a.rpc_is_recoverable_resume_error("thread t-1 not found"));
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib codex_generic_rpc_encoders_match_wire`
Expected: FAIL — methods return the default `Err`/`None`.

- [ ] **Step 3: Implement the generic methods on Codex by delegating to existing private logic**

In `agent/codex.rs`, add these methods to `impl Agent for Codex`. They reuse the existing free fns (`trust_level_to_*`, `encode_rpc_frame`) and the `CodexRpc*Params` bodies. Simplest: have the new methods build the same frames the old `encode_rpc_*` methods build. Concretely, implement each new method by constructing the same `CodexRpc*Params` and calling the existing method:

```rust
fn uses_rpc(&self) -> bool { true }

fn rpc_encode_initialize(&self, req_id: i64, ci: &super::RpcClientInfo<'_>) -> Result<Vec<u8>, String> {
    self.encode_rpc_initialize(req_id, &super::CodexRpcClientInfo { name: ci.name, version: ci.version })
}
fn rpc_encode_initialized(&self) -> Option<Result<Vec<u8>, String>> {
    Some(self.encode_rpc_initialized_notification())
}
fn rpc_encode_start(&self, req_id: i64, p: &super::RpcStartParams<'_>) -> Result<Vec<u8>, String> {
    self.encode_rpc_thread_start(req_id, &super::CodexRpcThreadStartParams { cwd: p.cwd, trust_level: p.trust_level, model: p.model })
}
fn rpc_encode_resume(&self, req_id: i64, p: &super::RpcResumeParams<'_>) -> Result<Vec<u8>, String> {
    self.encode_rpc_thread_resume(req_id, &super::CodexRpcThreadResumeParams { thread_id: p.session_id, cwd: p.cwd, trust_level: p.trust_level })
}
fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
    r.pointer("/thread/id").and_then(|s| s.as_str()).map(|s| s.to_string())
}
fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
    self.encode_rpc_turn_start(req_id, &super::CodexRpcTurnStartParams { thread_id: p.session_id, prompt: p.prompt, image_urls: p.image_urls, trust_level: p.trust_level, model: p.model, effort: p.effort, plan_mode: p.plan_mode })
}
fn rpc_parse_turn_id(&self, r: &Value) -> Option<String> {
    r.pointer("/turn/id").and_then(|s| s.as_str()).map(|s| s.to_string())
}
fn rpc_encode_interrupt(&self, req_id: i64, session_id: &str, turn_id: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    match turn_id {
        Some(tid) => self.encode_rpc_turn_interrupt(req_id, session_id, tid).map(Some),
        None => Ok(None),
    }
}
fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
    super::rpc::is_recoverable_thread_resume_error(message)
}
```

> These delegate for now; Task 8 inlines and deletes the old `encode_rpc_*` once nothing else calls them.

- [ ] **Step 4: Run — expect green (new + all old Codex tests)**

Run: `cargo test -p verun --lib codex`
Expected: PASS (both the new test and the pre-existing `codex_encode_*` tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(codex): implement generic RPC encoder seam"
```

### Task 4: Move Codex notification decode + usage onto the trait

**Files:**
- Modify: `src-tauri/src/agent/codex.rs` (add `rpc_decode_notification`, `rpc_extract_usage`)
- Modify: `src-tauri/src/stream.rs` (make `process_codex_rpc_notification`, `extract_codex_token_usage`, `CodexTokenUsage`, `format_codex_file_change` reachable from `codex.rs` — mark `pub(crate)` if needed; do NOT delete yet)
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `RpcTokenUsage`.
- Produces: `Codex::rpc_decode_notification(method, params) -> Vec<OutputItem>` delegating to `stream::process_codex_rpc_notification`; `Codex::rpc_extract_usage(method, params) -> Option<RpcTokenUsage>` returning `Some` only when `method == "thread/tokenUsage/updated"`, mapping `stream::extract_codex_token_usage`'s `CodexTokenUsage` → `RpcTokenUsage`.

- [ ] **Step 1: Write failing tests**

Add to `agent/mod.rs::tests`:

```rust
#[test]
fn codex_rpc_decode_notification_maps_text_and_turn_end() {
    let a = Codex;
    let out = a.rpc_decode_notification("item/agentMessage/delta", &json!({"delta": "hello"}));
    assert!(matches!(out.as_slice(), [crate::stream::OutputItem::Text { text }] if text == "hello"));
    let end = a.rpc_decode_notification("turn/completed", &json!({"turn": {"status": "completed"}}));
    assert!(matches!(end.as_slice(), [crate::stream::OutputItem::TurnEnd { .. }]));
}

#[test]
fn codex_rpc_extract_usage_reads_token_usage_updated() {
    let a = Codex;
    let u = a.rpc_extract_usage("thread/tokenUsage/updated", &json!({"tokenUsage": {"last": {"inputTokens": 10, "outputTokens": 5, "cachedInputTokens": 3}}})).unwrap();
    assert_eq!(u.input_tokens, 10);
    assert_eq!(u.output_tokens, 5);
    assert_eq!(u.cached_input_tokens, 3);
    assert!(a.rpc_extract_usage("item/agentMessage/delta", &json!({})).is_none());
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib codex_rpc_decode_notification_maps_text_and_turn_end codex_rpc_extract_usage_reads_token_usage_updated`
Expected: FAIL (default impls return empty/None).

- [ ] **Step 3: Make the stream helpers reachable, implement the two methods**

In `stream.rs`: ensure `process_codex_rpc_notification` (already `pub`), `extract_codex_token_usage` (already `pub`), and `CodexTokenUsage` struct are `pub(crate)`.

In `agent/codex.rs` `impl Agent for Codex`:

```rust
fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
    crate::stream::process_codex_rpc_notification(method, params)
}
fn rpc_extract_usage(&self, method: &str, params: &Value) -> Option<super::RpcTokenUsage> {
    if method != "thread/tokenUsage/updated" { return None; }
    crate::stream::extract_codex_token_usage(params).map(|u| super::RpcTokenUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cached_input_tokens: u.cached_input_tokens,
    })
}
```

- [ ] **Step 4: Run — expect green**

Run: `cargo test -p verun --lib codex_rpc_decode codex_rpc_extract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(codex): expose notification decode + usage via trait"
```

### Task 5: Move Codex approval classification/encoding onto the trait

**Files:**
- Modify: `src-tauri/src/agent/codex.rs` (add `rpc_is_approval`, `rpc_build_approval_entry`, `rpc_encode_approval_response`)
- Modify: `src-tauri/src/stream.rs` (mark `is_codex_approval_method`, `build_codex_approval_entry`, `encode_codex_approval_response` `pub(crate)`; keep for now)
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `crate::task::{PendingApprovalEntry, ApprovalResponse}`.
- Produces: `Codex::rpc_is_approval(method)` delegating to `stream::is_codex_approval_method`; `Codex::rpc_build_approval_entry(...)` → `stream::build_codex_approval_entry`; `Codex::rpc_encode_approval_response(method, id, response)` → `stream::encode_codex_approval_response(self, method, id, response)`.

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn codex_rpc_approval_seam() {
    let a = Codex;
    assert!(a.rpc_is_approval("applyPatchApproval"));
    assert!(!a.rpc_is_approval("turn/completed"));
    let entry = a.rpc_build_approval_entry("s1", "r1", "execCommandApproval", &json!({"command": "ls"}));
    assert_eq!(entry.tool_name, "Bash");
    let resp = crate::task::ApprovalResponse { behavior: "allow".into(), updated_input: None, message: None };
    let bytes = a.rpc_encode_approval_response("applyPatchApproval", &json!(42), &resp, &json!({})).unwrap().unwrap();
    let v = parse_rpc_frame(&bytes);
    assert_eq!(v["result"]["decision"], "approved");
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib codex_rpc_approval_seam`
Expected: FAIL.

- [ ] **Step 3: Implement (delegating to stream helpers)**

In `agent/codex.rs`:

```rust
fn rpc_is_approval(&self, method: &str) -> bool {
    crate::stream::is_codex_approval_method(method)
}
fn rpc_build_approval_entry(&self, session_id: &str, request_id: &str, method: &str, params: &Value) -> crate::task::PendingApprovalEntry {
    crate::stream::build_codex_approval_entry(session_id, request_id, method, params)
}
fn rpc_encode_approval_response(&self, method: &str, server_req_id: &Value, response: &crate::task::ApprovalResponse, _entry_input: &Value) -> Option<Result<Vec<u8>, String>> {
    // Codex derives everything from method + response; entry_input is a Grok-only concern.
    crate::stream::encode_codex_approval_response(self, method, server_req_id, response)
}
```

- [ ] **Step 4: Run — expect green**

Run: `cargo test -p verun --lib codex_rpc_approval_seam`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(codex): expose approval classify/encode via trait"
```

### Task 6: Make `stream_and_capture_rpc` protocol-agnostic

**Files:**
- Modify: `src-tauri/src/stream.rs:1832-2081` (`stream_and_capture_rpc`)
- Test: existing Codex behavior via `cargo check` + dev smoke (no unit test change; this is a call-site rewrite covered by Task 4/5 unit tests + Task 16 integration)

**Interfaces:**
- Consumes: `agent.rpc_decode_notification`, `agent.rpc_extract_usage`, `agent.rpc_is_approval`, `agent.rpc_build_approval_entry`, `agent.rpc_encode_approval_response` (Tasks 4-5).
- Produces: same signature and behavior; internally dispatches through the trait instead of `process_codex_rpc_notification` / `is_codex_approval_method` / `build_codex_approval_entry` / `encode_codex_approval_response` / `extract_codex_token_usage`.

- [ ] **Step 1: Rewrite the Notification arm to use the trait**

Replace (stream.rs ~1883-1895):
```rust
if method == "thread/tokenUsage/updated" {
    if let Some(usage) = extract_codex_token_usage(&params) { last_token_usage = Some(usage); }
    continue;
}
let raw_items = process_codex_rpc_notification(&method, &params);
let items: Vec<OutputItem> = raw_items.into_iter()
    .map(|it| patch_turn_end_with_usage(it, &last_token_usage))
    .map(|it| persist_codex_plan_if_ready(it, &worktree_path))
    .collect();
```
with:
```rust
if let Some(usage) = agent.rpc_extract_usage(&method, &params) {
    last_token_usage = Some(usage);
    continue;
}
let raw_items = agent.rpc_decode_notification(&method, &params);
let items: Vec<OutputItem> = raw_items.into_iter()
    .map(|it| patch_turn_end_with_usage(it, &last_token_usage))
    .map(|it| persist_plan_if_ready(it, &worktree_path))
    .collect();
```
Change `last_token_usage` type from `Option<CodexTokenUsage>` to `Option<crate::agent::RpcTokenUsage>` (line ~1862). Update `patch_turn_end_with_usage` signature to take `&Option<crate::agent::RpcTokenUsage>` (stream.rs:2411) — its body only reads `.input_tokens/.output_tokens/.cached_input_tokens`, which `RpcTokenUsage` has, so only the type name changes. Rename `persist_codex_plan_if_ready` → `persist_plan_if_ready` (it already no-ops on non-`CodexPlanReady` items, so it stays generic).

- [ ] **Step 2: Rewrite the ServerRequest (approval) arm to use the trait**

Replace `if !is_codex_approval_method(&method)` (stream.rs:1976) with `if !agent.rpc_is_approval(&method)`. Replace `build_codex_approval_entry(&session_id, &request_id, &method, &params)` (2003) with `agent.rpc_build_approval_entry(&session_id, &request_id, &method, &params)`. In the responder task, replace `encode_codex_approval_response(&*responder_agent, &responder_method, &responder_id, &response)` (2039) with `responder_agent.rpc_encode_approval_response(&responder_method, &responder_id, &response, &responder_entry_input)`. Capture `responder_entry_input = entry.tool_input.clone()` when the entry is built/registered (stream.rs ~2003-2017) and move it into the responder task alongside `responder_method`/`responder_id` (the entry is removed at 2036 before encoding, so clone its `tool_input` up front). For Codex this value is ignored; for Grok it carries the `_grokOptions`.

Change the log tag `[verun][codex-rpc]` → `[verun][rpc]` for generality.

- [ ] **Step 3: Run checks — expect green**

Run: `cargo test -p verun --lib`
Expected: PASS (all Codex encoder/decoder/classify tests still green).
Run: `cargo clippy -- -D warnings`
Expected: no warnings.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(stream): dispatch RPC stream loop through agent trait"
```

### Task 7: Generalize `spawn_codex_app_server_session` → `spawn_rpc_session` and rename `ActiveProcess` fields

**Files:**
- Modify: `src-tauri/src/task.rs` — `ActiveProcess` fields (562-574), `spawn_codex_app_server_session` (1929-2318) + `start_new_thread` (2320-2347), `FastPath::GoRpc` handler (1564-1657) + variant (1412-1419), `abort_message` (2788-2887), `spawn_session_process` dispatch (2442), the `active` insert (2181-2201), non-RPC insert (2632-2635).
- Test: existing Codex tests + `cargo check`; behavior verified in Task 16.

**Interfaces:**
- Consumes: `agent.rpc_encode_initialize/initialized/start/resume/turn/interrupt`, `agent.rpc_parse_session_id`, `agent.rpc_parse_turn_id`, `agent.rpc_is_recoverable_resume_error`, `agent.uses_rpc()`.
- Produces: `spawn_rpc_session(...)` (same params as `spawn_codex_app_server_session`); `ActiveProcess { rpc_session_id, rpc_pending, rpc_next_id, rpc_current_turn_id }`.

- [ ] **Step 1: Rename ActiveProcess fields**

`codex_thread_id`→`rpc_session_id`, `codex_pending`→`rpc_pending`, `codex_next_id`→`rpc_next_id`, `codex_current_turn_id`→`rpc_current_turn_id` (task.rs 562-574). Update all read/write sites (inserts 2196-2199 & 2632-2635, fast-path reads 1440-1453, abort reads 2794-2797).

- [ ] **Step 2: Generalize the handshake in `spawn_rpc_session`**

Rename `spawn_codex_app_server_session`→`spawn_rpc_session`. Replace the Codex-named encoder calls with the generic seam:
- `agent.encode_rpc_initialize(init_id, &CodexRpcClientInfo{...})` → `agent.rpc_encode_initialize(init_id, &crate::agent::RpcClientInfo { name: "verun", version: env!("CARGO_PKG_VERSION") })`
- The `initialized` step becomes conditional (ACP has none):
```rust
if let Some(bytes) = agent.rpc_encode_initialized() {
    rpc::write_frame(&stdin, &bytes?).await?;
}
```
- `start_new_thread` → generic `start_new_rpc_session`:
```rust
async fn start_new_rpc_session(agent: &dyn crate::agent::Agent, stdin: &Arc<TokioMutex<Option<ChildStdin>>>, pending: &crate::agent::rpc::PendingRpcResponses, next_id: &AtomicI64, worktree_path: &str, trust_level: TrustLevel, model: Option<&str>) -> Result<String, String> {
    let req_id = rpc::next_request_id(next_id);
    let bytes = agent.rpc_encode_start(req_id, &crate::agent::RpcStartParams { cwd: worktree_path, trust_level, model })?;
    let result = rpc::call(stdin, pending, req_id, &bytes).await.map_err(|e| format!("rpc start session failed: {e}"))?;
    agent.rpc_parse_session_id(&result).ok_or_else(|| "rpc start response missing session id".to_string())
}
```
- Resume branch: `agent.encode_rpc_thread_resume(...)` → `agent.rpc_encode_resume(resume_id, &crate::agent::RpcResumeParams { session_id: &rid_owned, cwd: &worktree_path, trust_level, model: model.as_deref() })`; the recoverable check `rpc::is_recoverable_thread_resume_error(&err.message)` → `agent.rpc_is_recoverable_resume_error(&err.message)`; fallback calls `start_new_rpc_session`.

- [ ] **Step 3: Generalize turn dispatch + interrupt**

- Turn (spawn 2134 & fast-path 1614): `agent.encode_rpc_turn_start(turn_id, &CodexRpcTurnStartParams{...})` → `agent.rpc_encode_turn(turn_id, &crate::agent::RpcTurnParams { session_id: &thread_id, prompt: &message, image_urls: &image_urls, trust_level, model: model.as_deref(), effort: effort.as_deref(), plan_mode })`. (Variable stays named `thread_id`; it now holds the generic session id.)
- `spawn_turn_start_response_watcher` (2368-2423) extracts turn id via `result.pointer("/turn/id")` (2381) → `agent.rpc_parse_turn_id(&result)`. This requires passing the agent kind into the watcher; simplest is to resolve the id before spawning the watcher is not possible (response arrives later), so pass `agent.kind()` into the watcher and reconstruct via `AgentKind::implementation()` inside, matching the responder-task pattern already used in `stream_and_capture_rpc`. For ACP, `rpc_parse_turn_id` returns `None`, so `current_turn_id` stays `None` — correct (cancel uses session id only).
- Interrupt (`abort_message` 2830-2842): replace the Codex-specific `agent.encode_rpc_turn_interrupt(req_id, thread_id, &turn_id)` block with:
```rust
let req_id = crate::agent::rpc::next_request_id(next_id);
match agent.rpc_encode_interrupt(req_id, session_id, turn_id_opt.as_deref())? {
    Some(bytes) => (Some(bytes), true),
    None => (None, false),
}
```
This makes Codex (turn_id required → `None` when absent → skip) and Grok (`session/cancel`, always `Some`) both correct. Update the RPC-state gather at 2792 to use `agent.uses_rpc()` and the renamed `rpc_*` fields.

- [ ] **Step 4: Update the dispatch + fast-path + docstrings**

- `spawn_session_process` (2442): `if agent.uses_app_server()` → `if agent.uses_rpc()` calling `spawn_rpc_session`.
- `send_message` (1439): `else if agent.uses_app_server()` → `else if agent.uses_rpc()`.
- Update code comments referencing "codex app-server" in these functions to "rpc session (codex app-server / grok acp)".

- [ ] **Step 5: Run checks — expect green**

Run: `cargo test -p verun --lib`
Expected: PASS.
Run: `cargo check && cargo clippy -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(task): generalize codex app-server spawn into spawn_rpc_session"
```

### Task 8: Delete the dead Codex-named trait methods and free helpers

**Files:**
- Modify: `src-tauri/src/agent/mod.rs` (remove `uses_app_server`, `encode_rpc_*` methods, `CodexRpc*` param types + decision enums IF no longer referenced), `src-tauri/src/agent/codex.rs` (inline the delegated bodies, drop old methods), `src-tauri/src/stream.rs` (the decode/approval/usage free fns become private helpers of Codex — move into `codex.rs` or keep `pub(crate)` if still called only via the trait method).
- Test: full suite.

**Interfaces:**
- Produces: a single generic RPC seam; no `uses_app_server` / `encode_rpc_*` / `CodexRpc*` public surface remains.

- [ ] **Step 1: Find remaining references**

```bash
grep -rn "uses_app_server\|encode_rpc_\|CodexRpc" src-tauri/src
```
Expected remaining: only inside `codex.rs` (the delegating bodies) and their tests.

- [ ] **Step 2: Inline and delete**

For each `rpc_encode_*` method on Codex that currently delegates to `encode_rpc_*`, inline the old body into the new method and delete the old `encode_rpc_*` method + its `CodexRpc*Params` type. Update the old Codex encoder tests (`codex_encode_initialize_*`, `codex_encode_thread_*`, `codex_encode_turn_*`, `codex_encode_*_response`, `non_codex_agents_reject_rpc_encoders_by_default`, `non_codex_agents_do_not_use_app_server`) to call the new `rpc_*` methods (keep the assertions; only the method name and param type change). Delete `uses_app_server` (default + Codex override) after confirming no references. Move `process_codex_rpc_notification`, `extract_codex_token_usage`, `is_codex_approval_method`, `build_codex_approval_entry`, `encode_codex_approval_response`, `format_codex_file_change`, `build_codex_user_input_tool_input`, `encode_codex_user_input_response` to `pub(crate)` (they stay in stream.rs, called only from `codex.rs`'s trait methods) — or physically move into `codex.rs`. Keep them in stream.rs as `pub(crate)` to minimize churn.

- [ ] **Step 3: Run full suite — expect green**

Run: `cargo test -p verun --lib`
Expected: PASS.
Run: `cargo clippy -- -D warnings`
Expected: clean (no dead-code warnings).

- [ ] **Step 4: Manual Codex smoke test (regression gate)**

Run: `pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications`
Create a Codex task, send a message that triggers a tool + an approval, verify streaming/approval/resume all work exactly as before. This is the human gate that the refactor preserved Codex behavior.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(agent): remove codex-named RPC surface; single generic seam"
```

---

## PHASE 3 — The Grok agent (ACP)

### Task 9: `grok.rs` skeleton — identity, args, capabilities, registration

**Files:**
- Create: `src-tauri/src/agent/grok.rs`
- Modify: `src-tauri/src/agent/mod.rs` (mod decl 93-99, re-export 105-109, `AgentKind` enum 117-123, `parse` 126-134, `as_str` 136-144, `all` 146-154, `implementation` 157-165)
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Produces: `pub struct Grok;` implementing `Agent`. `cli_binary()="grok"`, `display_name()="Grok"`, `build_session_args()=["agent","stdio"]`, `uses_rpc()=true`, `persists_across_turns()=true`, `abort_strategy()=Interrupt`, `input_mode()=JsonRpcStdio`, `supports_resume()=true`, `defers_resume_id_until_turn_end()=false`, `supports_effort()=false`, `supports_attachments()=false`, `supports_plan_mode()=false`, `available_models()=[grok-4.5]`. `AgentKind::Grok`.

- [ ] **Step 1: Write failing tests**

Add to `agent/mod.rs::tests`:

```rust
#[test]
fn grok_registration_and_caps() {
    assert_eq!(AgentKind::parse("grok"), AgentKind::Grok);
    assert_eq!(AgentKind::Grok.as_str(), "grok");
    assert!(AgentKind::all().contains(&AgentKind::Grok));
    let a = AgentKind::Grok.implementation();
    assert_eq!(a.cli_binary(), "grok");
    assert_eq!(a.build_session_args(&default_args()), vec!["agent".to_string(), "stdio".to_string()]);
    assert!(a.uses_rpc());
    assert!(a.persists_across_turns());
    assert_eq!(a.abort_strategy(), AbortStrategy::Interrupt);
    assert!(a.supports_resume());
    assert!(!a.defers_resume_id_until_turn_end());
    assert!(!a.supports_effort());
    assert!(!a.supports_plan_mode());
    assert_eq!(a.available_models()[0].id, "grok-4.5");
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib grok_registration_and_caps`
Expected: FAIL — `AgentKind::Grok` doesn't exist.

- [ ] **Step 3: Create `grok.rs` and wire `AgentKind`**

Create `src-tauri/src/agent/grok.rs`:

```rust
use super::{Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use serde_json::{json, Value};

/// xAI Grok CLI - agentic coding CLI.
///
/// Transport: `grok agent stdio` speaks ACP (Agent Client Protocol),
/// newline-delimited JSON-RPC 2.0 over stdio. One process persists across
/// turns; each turn is a `session/prompt` request. Grok does its own file
/// I/O (we advertise no client `fs` capability).
///
/// Binary: `grok`   Docs: https://x.ai
pub struct Grok;

impl Agent for Grok {
    fn kind(&self) -> AgentKind { AgentKind::Grok }
    fn display_name(&self) -> &'static str { "Grok" }
    fn cli_binary(&self) -> &'static str { "grok" }
    fn input_mode(&self) -> InputMode { InputMode::JsonRpcStdio }
    fn install_hint(&self) -> &'static str { "curl -fsSL https://x.ai/grok/install.sh | sh" }
    fn docs_url(&self) -> &'static str { "https://x.ai" }

    fn available_models(&self) -> Vec<ModelOption> {
        vec![ModelOption::new("grok-4.5", "Grok 4.5", "xAI frontier coding model")]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["agent".into(), "stdio".into()]
    }

    fn uses_rpc(&self) -> bool { true }
    fn persists_across_turns(&self) -> bool { true }
    fn abort_strategy(&self) -> super::AbortStrategy { super::AbortStrategy::Interrupt }

    fn supports_resume(&self) -> bool { true }
    fn defers_resume_id_until_turn_end(&self) -> bool { false }
    fn supports_effort(&self) -> bool { false }
    fn supports_attachments(&self) -> bool { false }
    fn supports_plan_mode(&self) -> bool { false }
    fn supports_skills(&self) -> bool { false }
    fn supports_fork(&self) -> bool { false }

    // RPC seam methods implemented in Tasks 10-12.
}
```

In `agent/mod.rs`: add `mod grok;` (after `mod gemini;`), `pub use grok::Grok;`, `AgentKind::Grok` variant, and wire `parse` (`"grok" => Self::Grok`), `as_str` (`Self::Grok => "grok"`), `all` (append `Self::Grok`), `implementation` (`Self::Grok => Box::new(Grok)`).

- [ ] **Step 4: Run — expect green**

Run: `cargo test -p verun --lib grok_registration_and_caps`
Expected: PASS. Also run `cargo test -p verun --lib kind_parse_roundtrip all_agents_have_display_name_and_binary` — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(grok): add Grok agent skeleton + AgentKind registration"
```

### Task 10: Grok ACP encoders (initialize / session-new / session-load / prompt / cancel) + id parsing

**Files:**
- Modify: `src-tauri/src/agent/grok.rs`
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `RpcClientInfo`, `RpcStartParams`, `RpcResumeParams`, `RpcTurnParams`.
- Produces: Grok overrides `rpc_encode_initialize` (protocolVersion 1, NO `fs` capability), `rpc_encode_initialized`→`None`, `rpc_encode_start` (`session/new` with `{cwd, mcpServers:[]}`), `rpc_encode_resume` (`session/load` with `{sessionId, cwd, mcpServers:[]}`), `rpc_parse_session_id` (reads `/sessionId`), `rpc_encode_turn` (`session/prompt` with `{sessionId, prompt:[{type:"text",text}]}`), `rpc_parse_turn_id`→`None`, `rpc_encode_interrupt` (`session/cancel {sessionId}`, always `Some`), `rpc_is_recoverable_resume_error` (matches "session"/"not found").

- [ ] **Step 1: Write failing tests (from captured ACP wire shapes)**

```rust
#[test]
fn grok_acp_encoders() {
    let a = Grok;
    // initialize: protocolVersion 1, NO fs capability advertised
    let init = parse_rpc_frame(&a.rpc_encode_initialize(1, &RpcClientInfo { name: "verun", version: "0.9.0" }).unwrap());
    assert_eq!(init["method"], "initialize");
    assert_eq!(init["params"]["protocolVersion"], 1);
    assert!(init["params"]["clientCapabilities"].get("fs").is_none(), "must NOT advertise fs");
    // no initialized notification in ACP
    assert!(a.rpc_encode_initialized().is_none());
    // session/new
    let s = parse_rpc_frame(&a.rpc_encode_start(2, &RpcStartParams { cwd: "/repo", trust_level: crate::policy::TrustLevel::Normal, model: None }).unwrap());
    assert_eq!(s["method"], "session/new");
    assert_eq!(s["params"]["cwd"], "/repo");
    assert!(s["params"]["mcpServers"].is_array());
    // parse session id from session/new result
    assert_eq!(a.rpc_parse_session_id(&json!({"sessionId": "sess-9"})), Some("sess-9".into()));
    // session/load
    let l = parse_rpc_frame(&a.rpc_encode_resume(3, &RpcResumeParams { session_id: "sess-9", cwd: "/repo", trust_level: crate::policy::TrustLevel::Normal, model: None }).unwrap());
    assert_eq!(l["method"], "session/load");
    assert_eq!(l["params"]["sessionId"], "sess-9");
    assert_eq!(l["params"]["cwd"], "/repo");
    // session/prompt
    let t = parse_rpc_frame(&a.rpc_encode_turn(4, &RpcTurnParams { session_id: "sess-9", prompt: "fix the bug", image_urls: &[], trust_level: crate::policy::TrustLevel::Normal, model: None, effort: None, plan_mode: false }).unwrap());
    assert_eq!(t["method"], "session/prompt");
    assert_eq!(t["params"]["sessionId"], "sess-9");
    assert_eq!(t["params"]["prompt"][0]["type"], "text");
    assert_eq!(t["params"]["prompt"][0]["text"], "fix the bug");
    // no turn id in ACP
    assert!(a.rpc_parse_turn_id(&json!({"stopReason":"end_turn"})).is_none());
    // interrupt = session/cancel, always Some
    let i = a.rpc_encode_interrupt(5, "sess-9", None).unwrap().expect("cancel frame");
    let iv = parse_rpc_frame(&i);
    assert_eq!(iv["method"], "session/cancel");
    assert_eq!(iv["params"]["sessionId"], "sess-9");
    // recoverable resume error
    assert!(a.rpc_is_recoverable_resume_error("session sess-9 not found"));
    assert!(!a.rpc_is_recoverable_resume_error("network refused"));
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib grok_acp_encoders`
Expected: FAIL (default impls).

- [ ] **Step 3: Implement the encoders**

Add a private `fn frame(v: &Value) -> Result<Vec<u8>, String>` in `grok.rs` (serialize + `\n`, same as codex's `encode_rpc_frame`). Then in `impl Agent for Grok`:

```rust
fn rpc_encode_initialize(&self, req_id: i64, ci: &super::RpcClientInfo<'_>) -> Result<Vec<u8>, String> {
    frame(&json!({
        "id": req_id, "method": "initialize",
        "params": { "protocolVersion": 1, "clientInfo": { "name": ci.name, "version": ci.version }, "clientCapabilities": {} }
    }))
}
fn rpc_encode_initialized(&self) -> Option<Result<Vec<u8>, String>> { None }
fn rpc_encode_start(&self, req_id: i64, p: &super::RpcStartParams<'_>) -> Result<Vec<u8>, String> {
    frame(&json!({ "id": req_id, "method": "session/new", "params": { "cwd": p.cwd, "mcpServers": [] } }))
}
fn rpc_encode_resume(&self, req_id: i64, p: &super::RpcResumeParams<'_>) -> Result<Vec<u8>, String> {
    frame(&json!({ "id": req_id, "method": "session/load", "params": { "sessionId": p.session_id, "cwd": p.cwd, "mcpServers": [] } }))
}
fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
    r.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string())
}
fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
    frame(&json!({ "id": req_id, "method": "session/prompt", "params": { "sessionId": p.session_id, "prompt": [{ "type": "text", "text": p.prompt }] } }))
}
fn rpc_parse_turn_id(&self, _r: &Value) -> Option<String> { None }
fn rpc_encode_interrupt(&self, req_id: i64, session_id: &str, _turn_id: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    frame(&json!({ "id": req_id, "method": "session/cancel", "params": { "sessionId": session_id } })).map(Some)
}
fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("session") && (m.contains("not found") || m.contains("does not exist") || m.contains("unknown") || m.contains("no such"))
}
```

- [ ] **Step 4: Run — expect green**

Run: `cargo test -p verun --lib grok_acp_encoders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(grok): ACP handshake/turn/cancel encoders"
```

### Task 11: Grok ACP notification decode + usage

**Files:**
- Modify: `src-tauri/src/agent/grok.rs`
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `crate::stream::OutputItem`, `RpcTokenUsage`.
- Produces: `Grok::rpc_decode_notification("session/update", params) -> Vec<OutputItem>` switching on `params.update.sessionUpdate`; `Grok::rpc_extract_usage("session/update", params) -> Option<RpcTokenUsage>` reading `turn_completed.usage`.

Mapping (from captured ACP `session/update` shapes):
- `agent_thought_chunk` `{content:{text}}` → `OutputItem::Thinking { text }`
- `agent_message_chunk` `{content:{text}}` → `OutputItem::Text { text }`
- `tool_call` `{toolCallId, title, rawInput}` → `OutputItem::ToolStart { tool: title, input: rawInput-as-pretty-json }`
- `tool_call_update` `{status, content:[...], toolCallId}`:
  - content item `{type:"diff", path, oldText, newText}` → `OutputItem::DiffUpdate { diff }` (render a unified-diff string from old/new, or pass through — use existing `OutputItem::DiffUpdate`)
  - content item `{type:"content", content:{type:"text", text}}` with `status in {completed, failed}` → `OutputItem::ToolResult { text, is_error: status=="failed" }`
  - other statuses (`in_progress`) → `vec![]`
- `turn_completed` `{stop_reason, usage}` → `OutputItem::TurnEnd { status: map(stop_reason), error: None, ..default }`
- everything else (`plan`, `available_commands_update`, `session_summary_generated`, `pending_interaction`, `interaction_resolved`, `user_message_chunk`, `tool_call_delta_chunk`) → `vec![]`

- [ ] **Step 1: Write failing tests (from captured fixtures)**

```rust
#[test]
fn grok_decode_thought_and_message() {
    let a = Grok;
    let th = a.rpc_decode_notification("session/update", &json!({"update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}}));
    assert!(matches!(th.as_slice(), [crate::stream::OutputItem::Thinking { text }] if text == "hmm"));
    let msg = a.rpc_decode_notification("session/update", &json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}}));
    assert!(matches!(msg.as_slice(), [crate::stream::OutputItem::Text { text }] if text == "hi"));
}

#[test]
fn grok_decode_tool_call_and_diff_and_result() {
    let a = Grok;
    let tc = a.rpc_decode_notification("session/update", &json!({"update": {"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "read_file", "rawInput": {"target_file": "x.rs"}}}));
    assert!(matches!(tc.as_slice(), [crate::stream::OutputItem::ToolStart { tool, .. }] if tool == "read_file"));
    let diff = a.rpc_decode_notification("session/update", &json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "c2", "status": "completed", "content": [{"type": "diff", "path": "out.txt", "oldText": "", "newText": "DONE\n"}]}}));
    assert!(diff.iter().any(|i| matches!(i, crate::stream::OutputItem::DiffUpdate { .. })));
    let res = a.rpc_decode_notification("session/update", &json!({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "c3", "status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}]}}));
    assert!(res.iter().any(|i| matches!(i, crate::stream::OutputItem::ToolResult { text, is_error } if text == "ok" && !is_error)));
}

#[test]
fn grok_decode_turn_completed_and_usage() {
    let a = Grok;
    let params = json!({"update": {"sessionUpdate": "turn_completed", "stop_reason": "end_turn", "usage": {"inputTokens": 100, "outputTokens": 20, "cachedReadTokens": 60}}});
    let end = a.rpc_decode_notification("session/update", &params);
    assert!(matches!(end.as_slice(), [crate::stream::OutputItem::TurnEnd { status, .. }] if status == "completed"));
    let u = a.rpc_extract_usage("session/update", &params).unwrap();
    assert_eq!(u.input_tokens, 100);
    assert_eq!(u.output_tokens, 20);
    assert_eq!(u.cached_input_tokens, 60);
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib grok_decode`
Expected: FAIL.

- [ ] **Step 3: Implement decode + usage**

In `grok.rs`, add a free helper `fn stop_reason_to_status(sr: &str) -> &'static str` (`"end_turn" => "completed"`, `"cancelled"|"canceled"|"interrupted" => "interrupted"`, `"refusal"|"error" => "error"`, `_ => "completed"`) and:

```rust
fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
    use crate::stream::OutputItem;
    if method != "session/update" { return vec![]; }
    let Some(u) = params.get("update") else { return vec![]; };
    match u.get("sessionUpdate").and_then(|s| s.as_str()).unwrap_or("") {
        "agent_thought_chunk" => u.pointer("/content/text").and_then(|t| t.as_str()).filter(|s| !s.is_empty())
            .map(|t| vec![OutputItem::Thinking { text: t.to_string() }]).unwrap_or_default(),
        "agent_message_chunk" => u.pointer("/content/text").and_then(|t| t.as_str()).filter(|s| !s.is_empty())
            .map(|t| vec![OutputItem::Text { text: t.to_string() }]).unwrap_or_default(),
        "tool_call" => {
            let tool = u.get("title").and_then(|t| t.as_str()).unwrap_or("tool").to_string();
            let input = u.get("rawInput").map(|a| serde_json::to_string_pretty(a).unwrap_or_default()).unwrap_or_default();
            vec![OutputItem::ToolStart { tool, input }]
        }
        "tool_call_update" => {
            let status = u.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let mut out = Vec::new();
            if let Some(items) = u.get("content").and_then(|c| c.as_array()) {
                for it in items {
                    match it.get("type").and_then(|t| t.as_str()) {
                        Some("diff") => {
                            let path = it.get("path").and_then(|p| p.as_str()).unwrap_or("");
                            let old = it.get("oldText").and_then(|t| t.as_str()).unwrap_or("");
                            let new = it.get("newText").and_then(|t| t.as_str()).unwrap_or("");
                            out.push(OutputItem::DiffUpdate { diff: render_unified_diff(path, old, new) });
                        }
                        Some("content") if status == "completed" || status == "failed" => {
                            let text = it.pointer("/content/text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            out.push(OutputItem::ToolResult { text, is_error: status == "failed" });
                        }
                        _ => {}
                    }
                }
            }
            out
        }
        "turn_completed" => {
            let status = stop_reason_to_status(u.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("end_turn"));
            vec![OutputItem::TurnEnd { status: status.to_string(), cost: None, input_tokens: None, output_tokens: None, cache_read_tokens: None, cache_write_tokens: None, error: None }]
        }
        _ => vec![],
    }
}

fn rpc_extract_usage(&self, method: &str, params: &Value) -> Option<super::RpcTokenUsage> {
    if method != "session/update" { return None; }
    let u = params.get("update")?;
    if u.get("sessionUpdate").and_then(|s| s.as_str()) != Some("turn_completed") { return None; }
    let usage = u.get("usage")?;
    Some(super::RpcTokenUsage {
        input_tokens: usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        cached_input_tokens: usage.get("cachedReadTokens").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}
```

Add `render_unified_diff(path, old, new)` — a minimal helper producing a `--- a/path`/`+++ b/path` header plus line-level `+`/`-` (reuse any existing diff formatter in the codebase if present; check `grep -rn "fn.*unified_diff\|--- a/" src-tauri/src` first and reuse it, else write a minimal one).

> Note: `rpc_extract_usage` returning `Some` causes the stream loop's `continue` to skip decode for that notification. Since `turn_completed` also needs to emit `TurnEnd`, this is a conflict. RESOLUTION: in the stream loop (Task 6), the usage check `continue`s. For Grok, `turn_completed` carries BOTH usage and the end signal. So Grok must NOT short-circuit: have `rpc_extract_usage` return `None` for `turn_completed` and instead fold usage into the `TurnEnd` item directly inside `rpc_decode_notification` (fill `input_tokens/output_tokens/cache_read_tokens/cost` on the `TurnEnd`). Update the test `grok_decode_turn_completed_and_usage` to assert the usage lands on `TurnEnd` fields instead of via `rpc_extract_usage`. Codex keeps the separate `thread/tokenUsage/updated` notification + `patch_turn_end_with_usage` path unchanged. This keeps the generic loop correct for both.

- [ ] **Step 4: Adjust per the resolution note, run — expect green**

Rewrite the `turn_completed` arm to read `usage` and populate `TurnEnd { input_tokens: Some(..), output_tokens: Some(..), cache_read_tokens: Some(..), cost: usage.get("costUsdTicks").map(|t| ticks_to_usd(t)), .. }`, and leave `rpc_extract_usage` returning `None` for Grok (or omit the override entirely). Update the test accordingly.

Run: `cargo test -p verun --lib grok_decode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(grok): ACP session/update decode with diffs + usage on turn end"
```

### Task 12: Grok ACP approval classification + response

**Files:**
- Modify: `src-tauri/src/agent/grok.rs`
- Test: `src-tauri/src/agent/mod.rs::tests`

**Interfaces:**
- Consumes: `crate::task::{PendingApprovalEntry, ApprovalResponse}`.
- Produces: `Grok::rpc_is_approval("session/request_permission") -> true`; `Grok::rpc_build_approval_entry(...)` mapping the ACP `toolCall` to a Verun `PendingApprovalEntry` (tool_name from `toolCall.kind`/`title`, tool_input = `toolCall.rawInput`); `Grok::rpc_encode_approval_response(method, server_req_id, response)` → ACP `{id, result:{outcome:{outcome:"selected", optionId}}}` where optionId is chosen from `response.behavior` (allow → an `allow_*` option, deny → a `reject_*` option).

> Wire note: `session/request_permission` params carry `options:[{optionId, name, kind}]` with kinds `allow_always`/`allow_once`/`reject_once`. Verun's `ApprovalResponse.behavior` is `"allow"`/`"deny"`. We must map behavior → optionId. Since the entry-build step has the params (with options) but the encode step (in the responder task) only gets `method` + `server_req_id` + `response`, we need the options at encode time. RESOLUTION: stash the option ids on the `PendingApprovalEntry.tool_input` under a private key (e.g. `_grokOptions`) during `rpc_build_approval_entry`, then read them back in `rpc_encode_approval_response` from... it doesn't receive the entry. Instead: `rpc_encode_approval_response` receives `server_req_id` only. So encode a FIXED optionId convention: ACP option `kind` is stable (`allow_once`/`reject_once`), and the response can select by `kind` rather than `optionId` — verify Grok accepts `{outcome:{outcome:"selected", optionId}}` where optionId equals the kind, OR select `allow_once`/`reject_once` literal optionIds. During Task 16 live testing, confirm the exact optionId values; the captured sample showed `optionId` values `"allow-edits-session"`, `"allow-once"`, `"reject-once"` (hyphenated, distinct from `kind`). Therefore the options MUST be threaded to encode time.

RESOLUTION (already wired in Tasks 2/5/6): `rpc_encode_approval_response` takes `entry_input: &Value` (the stored entry's `tool_input`). In `rpc_build_approval_entry`, Grok stashes the options: `tool_input = json!({ "toolCall": <toolCall>, "_grokOptions": <options array> })`. The Task 6 responder task passes the cloned `entry.tool_input` in, so `rpc_encode_approval_response` can read `_grokOptions` and pick the right `optionId`. Codex ignores the param. No new signature change is introduced in this task — it was defined with the param from Task 2.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn grok_approval_classify_and_encode() {
    let a = Grok;
    assert!(a.rpc_is_approval("session/request_permission"));
    assert!(!a.rpc_is_approval("session/update"));
    let params = json!({"toolCall": {"toolCallId": "c1", "kind": "edit", "title": "Write out.txt", "rawInput": {"file_path": "out.txt"}},
        "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"}, {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]});
    let entry = a.rpc_build_approval_entry("s1", "r1", "session/request_permission", &params);
    assert_eq!(entry.tool_name, "Edit");
    // allow -> selects an allow_* optionId
    let allow = crate::task::ApprovalResponse { behavior: "allow".into(), updated_input: None, message: None };
    let bytes = a.rpc_encode_approval_response("session/request_permission", &json!(7), &allow, &entry.tool_input).unwrap().unwrap();
    let v = parse_rpc_frame(&bytes);
    assert_eq!(v["id"], 7);
    assert_eq!(v["result"]["outcome"]["outcome"], "selected");
    assert_eq!(v["result"]["outcome"]["optionId"], "allow-once");
    // deny -> selects a reject_* optionId
    let deny = crate::task::ApprovalResponse { behavior: "deny".into(), updated_input: None, message: None };
    let db = a.rpc_encode_approval_response("session/request_permission", &json!(7), &deny, &entry.tool_input).unwrap().unwrap();
    assert_eq!(parse_rpc_frame(&db)["result"]["outcome"]["optionId"], "reject-once");
}
```

- [ ] **Step 2: Run — expect failure**

Run: `cargo test -p verun --lib grok_approval_classify_and_encode`
Expected: FAIL.

- [ ] **Step 3: Implement**

Map `toolCall.kind` → Verun tool name: `"edit" => "Edit"`, `"execute" => "Bash"`, `"read" => "Read"`, `_ => title-or-"Tool"`. Store options for encode time:

```rust
fn rpc_is_approval(&self, method: &str) -> bool { method == "session/request_permission" }

fn rpc_build_approval_entry(&self, session_id: &str, request_id: &str, _method: &str, params: &Value) -> crate::task::PendingApprovalEntry {
    let tc = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let kind = tc.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let tool_name = match kind { "edit" => "Edit", "execute" => "Bash", "read" => "Read", _ => tc.get("title").and_then(|t| t.as_str()).unwrap_or("Tool") }.to_string();
    let tool_input = json!({ "toolCall": tc, "_grokOptions": params.get("options").cloned().unwrap_or(json!([])) });
    crate::task::PendingApprovalEntry { request_id: request_id.to_string(), session_id: session_id.to_string(), tool_name, tool_input }
}

fn rpc_encode_approval_response(&self, _method: &str, server_req_id: &Value, response: &crate::task::ApprovalResponse, entry_input: &Value) -> Option<Result<Vec<u8>, String>> {
    let allow = response.behavior == "allow";
    let options = entry_input.get("_grokOptions").and_then(|o| o.as_array())?;
    let want_prefix = if allow { "allow" } else { "reject" };
    // Prefer the *_once option matching the behavior; fall back to any matching-prefix kind.
    let pick = options.iter().find(|o| o.get("kind").and_then(|k| k.as_str()).map(|k| k == format!("{want_prefix}_once")).unwrap_or(false))
        .or_else(|| options.iter().find(|o| o.get("kind").and_then(|k| k.as_str()).map(|k| k.starts_with(want_prefix)).unwrap_or(false)));
    let option_id = pick.and_then(|o| o.get("optionId")).cloned().unwrap_or(Value::Null);
    Some(frame(&json!({ "id": server_req_id, "result": { "outcome": { "outcome": "selected", "optionId": option_id } } })))
}
```

- [ ] **Step 4: Run — expect green**

Run: `cargo test -p verun --lib grok_approval_classify_and_encode`
Expected: PASS. Also re-run the Codex approval test updated in Task 6 for the new `entry_input` param — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(grok): ACP permission request classify + response"
```

---

## PHASE 4 — Frontend + docs + integration

### Task 13: Frontend registration (type, display name, icon)

**Files:**
- Modify: `src/types/index.ts:16` (`AgentType`), `:18-24` (`AGENT_DISPLAY_NAMES`)
- Modify: `src/lib/agents.ts:1-13,48` (`AGENT_ICONS` + import + re-export)
- Create: `src/assets/icons/grok.svg`
- Test: `src/**/*.test.ts` (add a small type/display test if the repo tests these; otherwise `pnpm check`)

**Interfaces:**
- Consumes: backend `AgentInfo` with `id: "grok"` (flows automatically from `list_available_agents`).
- Produces: `AgentType` includes `"grok"`; `AGENT_DISPLAY_NAMES.grok = "Grok"`; `AGENT_ICONS.grok = grokIcon`.

- [ ] **Step 1: Write a failing test (if agents display map is unit-tested)**

Check: `grep -rn "AGENT_DISPLAY_NAMES\|AGENT_ICONS" src/**/*.test.ts`. If a test file exists, add:
```ts
import { AGENT_DISPLAY_NAMES } from "../types";
test("grok has a display name", () => { expect(AGENT_DISPLAY_NAMES.grok).toBe("Grok"); });
```
If no such test exists, skip to Step 3 and rely on `pnpm check` (TS exhaustiveness on the `Record<AgentType, string>` will fail the build until `grok` is added — that IS the red state).

- [ ] **Step 2: Verify red**

Run: `pnpm check`
Expected: TS error — `AGENT_DISPLAY_NAMES` missing key `grok` once `"grok"` is added to the union (add the union member first to force it).

- [ ] **Step 3: Add the type, display name, icon**

- `src/types/index.ts:16`: `export type AgentType = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "grok";`
- `:18-24`: add `grok: "Grok",` to `AGENT_DISPLAY_NAMES`.
- `src/assets/icons/grok.svg`: add an SVG (use a simple wordmark/glyph placeholder; a monochrome "X"-style or "G" glyph is fine — must be a valid standalone `.svg`).
- `src/lib/agents.ts`: `import grokIcon from "../assets/icons/grok.svg";` (line ~5), add `grok: grokIcon,` to `AGENT_ICONS` (line ~13). Confirm `agentIcon()` fallback still compiles.

- [ ] **Step 4: Verify green**

Run: `pnpm check`
Expected: no TS errors.
Run: `pnpm test` (if a test was added)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(frontend): register Grok agent (type, display name, icon)"
```

### Task 14: Docs — CHANGELOG, ROADMAP, README

**Files:**
- Modify: `CHANGELOG.md` (add bullet under `## Unreleased`, create the section if absent)
- Modify: `ROADMAP.md` (check off / move Grok if listed; do not add new items unless Grok is already there)
- Modify: `README.md` (Features list: add Grok to supported agents)

- [ ] **Step 1: Update CHANGELOG**

Under `## Unreleased` (create above the latest version section if missing):
```markdown
- Grok CLI support via ACP (grok agent stdio): streamed reasoning + text, tool cards with diffs, interactive approvals, resume, and usage
```

- [ ] **Step 2: Update README Features**

Add Grok to the list of supported agents/CLIs (find the existing "Claude, Codex, Cursor, Gemini, OpenCode" enumeration and append "Grok").

- [ ] **Step 3: Update ROADMAP (only if Grok/multi-agent is tracked there)**

Run: `grep -in "grok\|agent" ROADMAP.md`. If Grok is a listed item, check it off `[X]`; otherwise leave ROADMAP unchanged.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md ROADMAP.md && git commit -m "docs: note Grok CLI support"
```

### Task 15: Full health check

- [ ] **Step 1: Run the full project check**

Run: `make check`
Expected: zero errors (typecheck + cargo check + clippy + tests).

Run: `cargo clippy -- -D warnings`
Expected: zero warnings.

- [ ] **Step 2: Fix anything red, re-run, commit if changes**

```bash
git add -A && git commit -m "chore: satisfy make check for grok support"
```

### Task 16: End-to-end integration verification in dev

**Files:** none (manual verification). Use the `verify` skill / `/run` if available.

- [ ] **Step 1: Launch dev**

Run: `pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications`

- [ ] **Step 2: Verify Grok end-to-end**

In a git-repo project, create a task with agent = Grok. Then confirm each:
- [ ] Streamed **thinking** and **assistant text** render live.
- [ ] A prompt that reads a file shows a **tool card** (`read_file` / `run_terminal_command`).
- [ ] A prompt that writes a file shows a **diff** and triggers an **approval prompt**; approving it applies the write; the tool card shows completion.
- [ ] Denying an approval blocks the action.
- [ ] **Resume:** close and reopen / send a second turn — Grok recalls prior context (the process persists; turn 2 uses the same session). Kill and cold-resume via `--resume` path — session restored (matches the verified `session/load` behavior).
- [ ] **Usage/cost** appears on turn end.
- [ ] **Cancel** mid-turn (`session/cancel`) stops the turn and returns to idle.

- [ ] **Step 3: Verify Codex still works (regression)**

Repeat a Codex task with a tool + approval + resume — confirm unchanged behavior.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "fix(grok): integration adjustments from dev verification"
```

---

## Self-review notes

- **Spec coverage:** §1-2 (ACP surface) → Tasks 10-12; §3 (Verun seam) → Tasks 1-8; §4 (grok.rs) → Tasks 9-12; §5 (registration) → Task 9; §6 (frontend) → Task 13; §7 (deferred: plan mode, effort, attachments — all set false in Task 9); Testing → per-task TDD + Task 16; DoD → Tasks 15-16.
- **Known implementation-time confirmations (flagged in tasks, resolve during Task 16):** exact ACP permission `optionId` values (Task 12 threads options through, so any values work); whether `session/new`-time sessionId is resumable before the first turn (recoverable fallback covers it, Task 7); reuse vs. write a unified-diff helper (Task 11).
- **Type consistency:** `RpcTokenUsage`, `RpcTurnParams`, `rpc_*` method names, and `ActiveProcess.rpc_*` fields are used identically across Tasks 2-12. `rpc_encode_approval_response(method, server_req_id, response, entry_input: &Value)` carries the `entry_input` param from its definition in Task 2 — Codex ignores it (Task 5), the Task 6 call site threads the cloned entry `tool_input`, and Grok reads `_grokOptions` from it (Task 12). No mid-plan signature change.
