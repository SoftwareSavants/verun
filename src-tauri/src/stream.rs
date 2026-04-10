use crate::db::{DbWrite, DbWriteTx};
use crate::policy::{self, PolicyDecision, TrustLevel};
use crate::task::{ApprovalResponse, PendingApprovalEntry, PendingApprovalMeta, PendingApprovals};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

const FLUSH_INTERVAL: Duration = Duration::from_millis(30);
const MAX_PERSISTED_LINES: usize = 10_000;

// ---------------------------------------------------------------------------
// Events emitted to the frontend
// ---------------------------------------------------------------------------

/// Structured output event — each item is a rendered piece of Claude's response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutputEvent {
    pub session_id: String,
    pub items: Vec<OutputItem>,
}

/// A single piece of structured output
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OutputItem {
    /// Assistant text content
    #[serde(rename_all = "camelCase")]
    Text { text: String },

    /// Thinking/reasoning content
    #[serde(rename_all = "camelCase")]
    Thinking { text: String },

    /// Tool use started
    #[serde(rename_all = "camelCase")]
    ToolStart { tool: String, input: String },

    /// Tool result
    #[serde(rename_all = "camelCase")]
    ToolResult { text: String, is_error: bool },

    /// System/status message
    #[serde(rename_all = "camelCase")]
    System { text: String },

    /// Turn completed
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        status: String,
        cost: Option<f64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },

    /// Raw line (fallback for unrecognized events)
    #[serde(rename_all = "camelCase")]
    Raw { text: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameEvent {
    pub session_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNameEvent {
    pub task_id: String,
    pub name: String,
}

/// Emitted to frontend when git status may have changed (session ended)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusChangedEvent {
    pub task_id: String,
}

/// Emitted to frontend when a task's setup hook starts, completes, or fails
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupHookEvent {
    pub task_id: String,
    pub status: String,
    pub error: Option<String>,
}

/// Emitted to frontend when Claude needs tool approval
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalEvent {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
}

/// Emitted to frontend with subscription rate limit info
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfoEvent {
    pub session_id: String,
    pub resets_at: i64,
    pub overage_resets_at: i64,
    pub rate_limit_type: String,
    pub overage_status: String,
    pub is_using_overage: bool,
}

/// Emitted to frontend when a tool call was auto-approved by the policy engine
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyAutoApprovedEvent {
    pub session_id: String,
    pub tool_name: String,
    pub tool_input_summary: String,
    pub decision: PolicyDecision,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// NDJSON event parser
// ---------------------------------------------------------------------------

/// Parse a single NDJSON line from Claude's stream-json output into OutputItems.
fn parse_sdk_event(line: &str) -> Vec<OutputItem> {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![OutputItem::Raw { text: line.to_string() }],
    };

    let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match msg_type {
        // -- Streaming token deltas (real-time) --
        "stream_event" => parse_stream_event(&v),

        // -- Full assistant message snapshot --
        "assistant" => parse_assistant_message(&v),

        // -- User message (tool results) --
        "user" => parse_user_message(&v),

        // -- System messages --
        // System messages (init, status) are internal — don't surface in chat
        "system" => vec![],

        // -- Result (turn completed) --
        // Text is already delivered via stream_event deltas; skip result.result to avoid duplication.
        "result" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("unknown");
            let status = match subtype {
                "success" => "completed",
                _ => "error",
            };
            let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
            let usage = v.get("usage");
            let input_tokens = usage.and_then(|u| u.get("input_tokens")).and_then(|t| t.as_u64());
            let output_tokens = usage.and_then(|u| u.get("output_tokens")).and_then(|t| t.as_u64());
            vec![OutputItem::TurnEnd { status: status.to_string(), cost, input_tokens, output_tokens }]
        }

        // -- Telemetry events we can surface --
        "tool_progress" => {
            let tool = v.get("tool_name").and_then(|t| t.as_str()).unwrap_or("tool");
            let elapsed = v.get("elapsed_time_seconds").and_then(|e| e.as_f64()).unwrap_or(0.0);
            vec![OutputItem::System {
                text: format!("{tool} running ({elapsed:.0}s)"),
            }]
        }

        // Rate limit events are handled directly in stream_and_capture (emitted as separate Tauri event)
        "rate_limit_event" => vec![],

        // Ignore auth_status, etc. silently
        "auth_status" | "tool_use_summary" => vec![],

        // Control requests are handled separately in stream_and_capture
        "control_request" | "control_response" => vec![],

        other => {
            eprintln!("[verun-debug] unhandled event type: {other} | line: {}", &line[..line.len().min(200)]);
            vec![]
        }
    }
}

/// Parse stream_event (content_block_delta, content_block_start, etc.)
fn parse_stream_event(v: &serde_json::Value) -> Vec<OutputItem> {
    let event = match v.get("event") {
        Some(e) => e,
        None => return vec![],
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match event_type {
        "content_block_delta" => {
            let delta = match event.get("delta") {
                Some(d) => d,
                None => return vec![],
            };
            let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match delta_type {
                "text_delta" => {
                    let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![OutputItem::Text { text: text.to_string() }]
                    }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![OutputItem::Thinking { text: text.to_string() }]
                    }
                }
                "input_json_delta" => {
                    // Partial tool input — skip, we'll get the full input from content_block_start
                    vec![]
                }
                _ => vec![],
            }
        }
        "content_block_start" => {
            let block = match event.get("content_block") {
                Some(b) => b,
                None => return vec![],
            };
            let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(serde_json::Value::Object(Default::default()));
                    let input_str = if input.is_object() && input.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                        String::new()
                    } else {
                        serde_json::to_string_pretty(&input).unwrap_or_default()
                    };
                    vec![OutputItem::ToolStart {
                        tool: name.to_string(),
                        input: input_str,
                    }]
                }
                other => {
                    eprintln!("[verun-debug] content_block_start unhandled block type: {other}");
                    vec![]
                }
            }
        }
        "content_block_stop" | "message_start" | "message_delta" | "message_stop" => vec![],
        other => {
            eprintln!("[verun-debug] unhandled stream_event type: {other}");
            vec![]
        }
    }
}

/// Parse a full assistant message snapshot.
/// With --include-partial-messages, stream_event deltas already deliver text/thinking
/// in real-time, so the snapshot is redundant for those. We skip it to avoid duplication.
/// However, we DO extract tool_use blocks since content_block_start may not always arrive.
fn parse_assistant_message(v: &serde_json::Value) -> Vec<OutputItem> {
    let content = match v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return vec![],
    };

    let mut items = Vec::new();
    for block in content {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match block_type {
            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or(serde_json::Value::Object(Default::default()));
                let input_str = if input.is_object() && input.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                    String::new()
                } else {
                    serde_json::to_string_pretty(&input).unwrap_or_default()
                };
                eprintln!("[verun-debug] ToolStart from assistant message: {name}");
                items.push(OutputItem::ToolStart {
                    tool: name.to_string(),
                    input: input_str,
                });
            }
            _ => {}
        }
    }
    items
}

/// Parse user messages (typically tool results)
fn parse_user_message(v: &serde_json::Value) -> Vec<OutputItem> {
    let content = match v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return vec![],
    };

    let mut items = Vec::new();
    for block in content {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if block_type == "tool_result" {
            let is_error = block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            let text = extract_text_content(block.get("content"));
            if !text.is_empty() {
                items.push(OutputItem::ToolResult { text, is_error });
            }
        }
    }
    items
}


/// Extract text from various content formats
fn extract_text_content(content: Option<&serde_json::Value>) -> String {
    match content {
        None => String::new(),
        Some(v) => {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
            if let Some(arr) = v.as_array() {
                let mut result = String::new();
                for item in arr {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        result.push_str(text);
                    }
                }
                return result;
            }
            String::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Main streaming loop
// ---------------------------------------------------------------------------

/// Result of streaming a session — captured lines + accumulated cost
pub struct StreamResult {
    pub lines: Vec<String>,
    pub total_cost: f64,
}

/// Stream stdout from the claude process, parse NDJSON events, emit
/// structured items to frontend, persist to DB, and return all captured lines.
///
/// Text and thinking deltas are emitted immediately for real-time feel.
/// Other items are batched with a short flush interval.
///
/// When a `control_request` (tool approval) is detected, we emit it to the
/// frontend and block until the user responds via `respond_to_approval`.
#[allow(clippy::too_many_arguments)]
pub async fn stream_and_capture(
    app: AppHandle,
    session_id: String,
    task_id: String,
    stdout: ChildStdout,
    stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    db_tx: DbWriteTx,
    worktree_path: String,
    repo_path: String,
    trust_level: TrustLevel,
) -> StreamResult {
    let mut reader = BufReader::new(stdout).lines();
    let mut buffer: Vec<OutputItem> = Vec::new();
    let mut captured: Vec<String> = Vec::new();
    let mut last_flush = Instant::now();
    let mut total_persisted: usize = 0;
    let mut total_cost: f64 = 0.0;

    loop {
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        captured.push(line.clone());

                        // Intercept control_request for tool approval
                        if let Some(cr) = handle_control_request(
                            &app, &session_id, &task_id, &line, &stdin,
                            &pending_approvals, &pending_approval_meta,
                            &worktree_path, &repo_path,
                            trust_level, &db_tx,
                        ).await {
                            if cr.handled {
                                // Emit ToolStart so the frontend knows which tool is running
                                if let Some(tool_start) = cr.tool_start {
                                    if let OutputItem::ToolStart { ref tool, .. } = tool_start {
                                        eprintln!("[verun-debug] ToolStart from control_request: {tool}");
                                    }
                                    buffer.push(tool_start);
                                } else {
                                    eprintln!("[verun-debug] control_request handled but no tool_start");
                                }
                                persist_line(&db_tx, &session_id, &line, &mut total_persisted);
                                continue;
                            }
                        }

                        // Intercept rate_limit_event — emit as separate Tauri event
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                            if v.get("type").and_then(|t| t.as_str()) == Some("rate_limit_event") {
                                if let Some(info) = v.get("rate_limit_info") {
                                    let _ = app.emit("rate-limit-info", RateLimitInfoEvent {
                                        session_id: session_id.clone(),
                                        resets_at: info.get("resetsAt").and_then(|r| r.as_i64()).unwrap_or(0),
                                        overage_resets_at: info.get("overageResetsAt").and_then(|r| r.as_i64()).unwrap_or(0),
                                        rate_limit_type: info.get("rateLimitType").and_then(|r| r.as_str()).unwrap_or("").to_string(),
                                        overage_status: info.get("overageStatus").and_then(|r| r.as_str()).unwrap_or("").to_string(),
                                        is_using_overage: info.get("isUsingOverage").and_then(|r| r.as_bool()).unwrap_or(false),
                                    });
                                }
                                persist_line(&db_tx, &session_id, &line, &mut total_persisted);
                                continue;
                            }
                        }

                        // Parse NDJSON into structured items
                        let items = parse_sdk_event(&line);

                        // Emit text/thinking deltas immediately for real-time streaming
                        let mut has_immediate = false;
                        let mut is_turn_end = false;
                        for item in &items {
                            match item {
                                OutputItem::ToolStart { tool, .. } => eprintln!("[verun-debug] ToolStart: {tool}"),
                                OutputItem::ToolResult { is_error, .. } => eprintln!("[verun-debug] ToolResult (error={is_error})"),
                                _ => {}
                            }
                        }
                        for item in items {
                            match &item {
                                OutputItem::Text { .. } | OutputItem::Thinking { .. } => {
                                    // Flush any buffered items first, then emit this one directly
                                    if !buffer.is_empty() {
                                        flush_buffer(&app, &session_id, &mut buffer);
                                    }
                                    emit_item(&app, &session_id, item);
                                    has_immediate = true;
                                }
                                OutputItem::TurnEnd { cost, .. } => {
                                    is_turn_end = true;
                                    if let Some(c) = cost {
                                        total_cost += c;
                                    }
                                    buffer.push(item);
                                }
                                _ => {
                                    buffer.push(item);
                                }
                            }
                        }

                        // Persist raw line to DB
                        persist_line(&db_tx, &session_id, &line, &mut total_persisted);

                        // Close stdin after turn completes so the CLI process can exit
                        if is_turn_end {
                            // Take the ChildStdin out and drop it to close the fd (sends EOF)
                            let mut guard = stdin.lock().await;
                            drop(guard.take());
                        }

                        // Flush non-streaming buffer periodically
                        if !buffer.is_empty() && (has_immediate || last_flush.elapsed() >= FLUSH_INTERVAL) {
                            flush_buffer(&app, &session_id, &mut buffer);
                            last_flush = Instant::now();
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            _ = &mut deadline => {
                if !buffer.is_empty() {
                    flush_buffer(&app, &session_id, &mut buffer);
                    last_flush = Instant::now();
                }
            }
        }
    }

    flush_buffer(&app, &session_id, &mut buffer);
    StreamResult { lines: captured, total_cost }
}

/// Check if a line is a `control_request` for tool approval.
/// Evaluates the policy engine first — auto-approves safe actions, only prompts
/// the user for actions that require approval.
/// Returns `Some(true)` if handled, `Some(false)` if not a control_request, `None` on parse error.
#[allow(clippy::too_many_arguments)]
/// Result from handle_control_request: whether it was handled, plus optional ToolStart to emit
struct ControlRequestResult {
    handled: bool,
    tool_start: Option<OutputItem>,
}

#[allow(clippy::too_many_arguments)]
async fn handle_control_request(
    app: &AppHandle,
    session_id: &str,
    task_id: &str,
    line: &str,
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending_approvals: &PendingApprovals,
    pending_meta: &PendingApprovalMeta,
    worktree_path: &str,
    repo_path: &str,
    trust_level: TrustLevel,
    db_tx: &DbWriteTx,
) -> Option<ControlRequestResult> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;

    if v.get("type").and_then(|t| t.as_str()) != Some("control_request") {
        return Some(ControlRequestResult { handled: false, tool_start: None });
    }

    let request = v.get("request")?;
    if request.get("subtype").and_then(|s| s.as_str()) != Some("can_use_tool") {
        return Some(ControlRequestResult { handled: false, tool_start: None });
    }

    let cli_request_id = v.get("request_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
    let tool_name = request.get("tool_name").and_then(|t| t.as_str()).unwrap_or("unknown").to_string();
    let tool_input = request.get("input").cloned().unwrap_or(serde_json::Value::Null);

    // Build a ToolStart item so the frontend knows which tool is running
    let input_str = if tool_input.is_null() || (tool_input.is_object() && tool_input.as_object().map(|o| o.is_empty()).unwrap_or(true)) {
        String::new()
    } else {
        serde_json::to_string_pretty(&tool_input).unwrap_or_default()
    };
    let tool_start = OutputItem::ToolStart {
        tool: tool_name.clone(),
        input: input_str,
    };

    // Evaluate policy
    let result = policy::evaluate(&tool_name, &tool_input, worktree_path, repo_path, trust_level);
    let input_summary = policy::summarize_input(&tool_name, &tool_input);

    // Fire-and-forget audit log entry
    let _ = db_tx.send(DbWrite::InsertAuditEntry {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        tool_name: tool_name.clone(),
        tool_input_summary: input_summary.clone(),
        decision: result.decision.as_str().to_string(),
        reason: result.reason.clone(),
        created_at: crate::task::epoch_ms(),
    }).await;

    match result.decision {
        PolicyDecision::AutoAllow | PolicyDecision::AutoAllowLogged => {
            // Auto-approve: write allow response directly to stdin
            let response = serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": cli_request_id,
                    "response": {
                        "behavior": "allow",
                        "updatedInput": tool_input,
                    },
                }
            });

            let mut payload = serde_json::to_string(&response).unwrap_or_default();
            payload.push('\n');

            let mut stdin_guard = stdin.lock().await;
            if let Some(ref mut writer) = *stdin_guard {
                let _ = writer.write_all(payload.as_bytes()).await;
                let _ = writer.flush().await;
            }

            // Notify frontend (lightweight event for UI indicator)
            let _ = app.emit("policy-auto-approved", PolicyAutoApprovedEvent {
                session_id: session_id.to_string(),
                tool_name,
                tool_input_summary: input_summary,
                decision: result.decision,
                reason: result.reason,
            });

            Some(ControlRequestResult { handled: true, tool_start: Some(tool_start) })
        }
        PolicyDecision::RequireApproval => {
            // Original behavior: emit to frontend, wait for user response
            let request_id = uuid::Uuid::new_v4().to_string();

            let _ = app.emit("tool-approval-request", ToolApprovalEvent {
                request_id: request_id.clone(),
                session_id: session_id.to_string(),
                tool_name: tool_name.clone(),
                tool_input: tool_input.clone(),
            });

            let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalResponse>();
            pending_approvals.insert(request_id.clone(), tx);
            pending_meta.insert(request_id.clone(), PendingApprovalEntry {
                request_id: request_id.clone(),
                session_id: session_id.to_string(),
                tool_name,
                tool_input: tool_input.clone(),
            });

            let (behavior, updated_input) = match rx.await {
                Ok(resp) => (resp.behavior, resp.updated_input),
                Err(_) => ("deny".to_string(), None),
            };

            pending_approvals.remove(&request_id);
            pending_meta.remove(&request_id);

            let response_inner = if behavior == "allow" {
                let input = updated_input.unwrap_or(tool_input);
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": input
                })
            } else {
                serde_json::json!({
                    "behavior": "deny",
                    "message": "User denied this action",
                    "interrupt": false
                })
            };

            let control_response = serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": cli_request_id,
                    "response": response_inner,
                }
            });

            let mut payload = serde_json::to_string(&control_response).unwrap_or_default();
            payload.push('\n');

            let mut stdin_guard = stdin.lock().await;
            if let Some(ref mut writer) = *stdin_guard {
                let _ = writer.write_all(payload.as_bytes()).await;
                let _ = writer.flush().await;
            }

            Some(ControlRequestResult { handled: true, tool_start: Some(tool_start) })
        }
    }
}

fn emit_item(
    app: &AppHandle,
    session_id: &str,
    item: OutputItem,
) {
    let _ = app.emit(
        "session-output",
        SessionOutputEvent {
            session_id: session_id.to_string(),
            items: vec![item],
        },
    );
}

fn flush_buffer(
    app: &AppHandle,
    session_id: &str,
    buffer: &mut Vec<OutputItem>,
) {
    if buffer.is_empty() {
        return;
    }

    let items = std::mem::take(buffer);
    let _ = app.emit(
        "session-output",
        SessionOutputEvent {
            session_id: session_id.to_string(),
            items,
        },
    );
}

fn persist_line(
    db_tx: &DbWriteTx,
    session_id: &str,
    line: &str,
    total_persisted: &mut usize,
) {
    if *total_persisted >= MAX_PERSISTED_LINES {
        return;
    }
    *total_persisted += 1;
    let now = epoch_ms();
    let _ = db_tx.try_send(DbWrite::InsertOutputLines {
        session_id: session_id.to_string(),
        lines: vec![(line.to_string(), now)],
    });
}

pub fn map_exit_status(code: Option<i32>) -> &'static str {
    match code {
        Some(0) => "done",
        Some(_) => "error",
        None => "error",
    }
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Text { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Text item"),
        }
    }

    #[test]
    fn parse_thinking_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Thinking { text } => assert_eq!(text, "Let me think..."),
            _ => panic!("Expected Thinking item"),
        }
    }

    #[test]
    fn parse_tool_start() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"Bash","input":{}}}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Bash"),
            _ => panic!("Expected ToolStart item"),
        }
    }

    #[test]
    fn parse_tool_result() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_1","content":"output here","is_error":false}]}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::ToolResult { text, is_error } => {
                assert_eq!(text, "output here");
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult item"),
        }
    }

    #[test]
    fn parse_system_init_is_silent() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-sonnet-4-6","tools":[]}"#;
        let items = parse_sdk_event(line);
        assert!(items.is_empty(), "System messages should be silently consumed");
    }

    #[test]
    fn parse_result_success_with_usage() {
        let line = r#"{"type":"result","subtype":"success","session_id":"abc","total_cost_usd":0.042,"usage":{"input_tokens":100,"output_tokens":50}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status, cost, input_tokens, output_tokens } => {
                assert_eq!(status, "completed");
                assert_eq!(*cost, Some(0.042));
                assert_eq!(*input_tokens, Some(100));
                assert_eq!(*output_tokens, Some(50));
            }
            _ => panic!("Expected TurnEnd item"),
        }
    }

    #[test]
    fn parse_result_without_usage() {
        let line = r#"{"type":"result","subtype":"success","session_id":"abc"}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { cost, input_tokens, output_tokens, .. } => {
                assert_eq!(*cost, None);
                assert_eq!(*input_tokens, None);
                assert_eq!(*output_tokens, None);
            }
            _ => panic!("Expected TurnEnd item"),
        }
    }

    #[test]
    fn parse_invalid_json_returns_raw() {
        let line = "not json at all";
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Raw { text } => assert_eq!(text, "not json at all"),
            _ => panic!("Expected Raw item"),
        }
    }

    #[test]
    fn parse_rate_limit_ignored() {
        let line = r#"{"type":"rate_limit_event","data":{}}"#;
        let items = parse_sdk_event(line);
        assert!(items.is_empty());
    }

    #[test]
    fn flush_interval_is_30ms() {
        assert_eq!(FLUSH_INTERVAL, std::time::Duration::from_millis(30));
    }

    #[test]
    fn max_persisted_lines_is_10k() {
        assert_eq!(MAX_PERSISTED_LINES, 10_000);
    }

    #[test]
    fn status_event_serializes_as_camel_case() {
        let event = SessionStatusEvent {
            session_id: "s-001".into(),
            status: "done".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["sessionId"], "s-001");
        assert_eq!(json["status"], "done");
    }

    #[test]
    fn output_item_text_serializes() {
        let item = OutputItem::Text { text: "hello".into() };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "text");
        assert_eq!(json["text"], "hello");
    }

    #[test]
    fn output_item_thinking_serializes() {
        let item = OutputItem::Thinking { text: "hmm".into() };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "thinking");
        assert_eq!(json["text"], "hmm");
    }

    #[test]
    fn output_item_tool_start_serializes() {
        let item = OutputItem::ToolStart { tool: "Bash".into(), input: "ls".into() };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "toolStart");
        assert_eq!(json["tool"], "Bash");
    }

    #[test]
    fn map_exit_status_zero_is_done() {
        assert_eq!(map_exit_status(Some(0)), "done");
    }

    #[test]
    fn map_exit_status_nonzero_is_error() {
        assert_eq!(map_exit_status(Some(1)), "error");
    }

    #[test]
    fn map_exit_status_signal_is_error() {
        assert_eq!(map_exit_status(None), "error");
    }
}
