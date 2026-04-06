use crate::db::{DbWrite, DbWriteTx};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdout;

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
    TurnEnd { status: String },

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
            vec![OutputItem::TurnEnd { status: status.to_string() }]
        }

        // -- Telemetry events we can surface --
        "tool_progress" => {
            let tool = v.get("tool_name").and_then(|t| t.as_str()).unwrap_or("tool");
            let elapsed = v.get("elapsed_time_seconds").and_then(|e| e.as_f64()).unwrap_or(0.0);
            vec![OutputItem::System {
                text: format!("{tool} running ({elapsed:.0}s)"),
            }]
        }

        // Ignore rate_limit_event, auth_status, etc. silently
        "rate_limit_event" | "auth_status" | "tool_use_summary" => vec![],

        _ => vec![],
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
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

/// Parse a full assistant message snapshot.
/// With --include-partial-messages, stream_event deltas already deliver text/thinking
/// in real-time, so the snapshot is redundant for those. We skip it to avoid duplication.
fn parse_assistant_message(_v: &serde_json::Value) -> Vec<OutputItem> {
    vec![]
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

/// Stream stdout from the claude process, parse NDJSON events, emit
/// structured items to frontend, persist to DB, and return all captured lines.
///
/// Text and thinking deltas are emitted immediately for real-time feel.
/// Other items are batched with a short flush interval.
pub async fn stream_and_capture(
    app: AppHandle,
    session_id: String,
    stdout: ChildStdout,
    db_tx: DbWriteTx,
) -> Vec<String> {
    let mut reader = BufReader::new(stdout).lines();
    let mut buffer: Vec<OutputItem> = Vec::new();
    let mut captured: Vec<String> = Vec::new();
    let mut last_flush = Instant::now();
    let mut total_persisted: usize = 0;

    loop {
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        captured.push(line.clone());

                        // Parse NDJSON into structured items
                        let items = parse_sdk_event(&line);

                        // Emit text/thinking deltas immediately for real-time streaming
                        let mut has_immediate = false;
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
                                _ => {
                                    buffer.push(item);
                                }
                            }
                        }

                        // Persist raw line to DB
                        persist_line(&db_tx, &session_id, &line, &mut total_persisted);

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
    captured
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
    fn parse_result_success() {
        let line = r#"{"type":"result","subtype":"success","session_id":"abc","cost":0.01}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status } => assert_eq!(status, "completed"),
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
