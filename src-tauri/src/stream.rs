use crate::claude_jsonl;
use crate::db::{DbWrite, DbWriteTx};
use crate::policy::{self, PolicyDecision, TrustLevel};
use crate::snapshots;
use crate::task::{
    ApprovalResponse, PendingApprovalEntry, PendingApprovalMeta, PendingApprovals,
    PendingControlResponses,
};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
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

    /// Provider error (API failure, auth, overload, prompt-too-long, etc.).
    /// Carries the human message plus the raw source JSON so the frontend
    /// can show a persistent retry banner with an expandable details panel.
    #[serde(rename_all = "camelCase")]
    ErrorMessage {
        message: String,
        raw: Option<String>,
    },

    /// Turn completed
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        status: String,
        cost: Option<f64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        error: Option<String>,
    },

    /// Per-turn snapshot marker — frontend attaches the message uuid to the
    /// most recent assistant block so the "fork from here" affordance has a
    /// stable identifier to send back to the backend.
    #[serde(rename_all = "camelCase")]
    TurnSnapshot { message_uuid: String },

    /// Codex plan-mode update. Carries the current checklist and an optional
    /// explanation string. Emitted from `turn/plan/updated` notifications;
    /// the frontend renders this as a plan card distinct from assistant text.
    #[serde(rename_all = "camelCase")]
    PlanUpdate {
        items: Vec<PlanStep>,
        explanation: Option<String>,
    },

    /// Per-turn unified diff update. Emitted from `turn/diff/updated`; the
    /// frontend renders a diff badge that expands to show the patch.
    #[serde(rename_all = "camelCase")]
    DiffUpdate { diff: String },

    /// Live-streaming chunk of a Codex plan-mode `<proposed_plan>` body.
    /// Emitted from `item/plan/delta`; the frontend accumulates these into a
    /// plan viewer that pops open on first delta. Deltas are NOT written to
    /// the chat transcript (the authoritative text arrives via
    /// `CodexPlanReady`).
    #[serde(rename_all = "camelCase")]
    CodexPlanDelta { item_id: String, delta: String },

    /// Authoritative completion of a Codex plan item. Emitted from
    /// `item/completed` with `type: "plan"`. `filePath` points at the
    /// persisted `.md` file (written under `<worktree>/.verun/plans/`) that
    /// the frontend can re-read on session restore.
    #[serde(rename_all = "camelCase")]
    CodexPlanReady {
        item_id: String,
        text: String,
        file_path: Option<String>,
    },

    /// Raw line (fallback for unrecognized events)
    #[serde(rename_all = "camelCase")]
    Raw { text: String },
}

/// One row in a Codex plan-mode checklist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub status: String,
    pub step: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: String,
    pub error: Option<String>,
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

/// Emitted to frontend when a task's hook starts, completes, or fails
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupHookEvent {
    pub task_id: String,
    pub status: String,
    pub error: Option<String>,
    pub terminal_id: Option<String>,
    pub hook_type: Option<String>,
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
///
/// Kept for tests and rare call sites that only have the raw line. The stream
/// loop itself parses once upfront and calls `parse_sdk_event_value` directly to
/// avoid re-parsing the same line two or three times per tick.
#[cfg_attr(not(test), allow(dead_code))]
fn parse_sdk_event(line: &str) -> Vec<OutputItem> {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(v) => parse_sdk_event_value(&v),
        Err(_) => vec![OutputItem::Raw {
            text: line.to_string(),
        }],
    }
}

fn parse_sdk_event_value(v: &serde_json::Value) -> Vec<OutputItem> {
    let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match msg_type {
        // -- Streaming token deltas (real-time) --
        "stream_event" => parse_stream_event(v),

        // -- Assistant message --
        // Cursor with --stream-partial-output sends per-token `assistant` events
        // with a `timestamp_ms` field. The final snapshot has no `timestamp_ms`.
        "assistant" => {
            if v.get("timestamp_ms").is_some() {
                // Streaming delta: extract just the text content
                parse_assistant_text_only(v)
            } else {
                // Final snapshot or non-streaming: extract text + tool_use blocks
                parse_assistant_message(v)
            }
        }

        // -- User message (tool results) --
        "user" => parse_user_message(v),

        // -- System messages --
        // `system.init` gives us the resume id (extracted in stream_and_capture);
        // other system subtypes are silently ignored.
        "system" => vec![],

        // -- Result (turn completed) --
        // Text is already delivered via stream_event deltas; skip result.result to avoid duplication.
        "result" => {
            // Claude/Cursor use `subtype`, Gemini uses `status` at top level
            let status_str = v
                .get("subtype")
                .and_then(|s| s.as_str())
                .or_else(|| v.get("status").and_then(|s| s.as_str()))
                .unwrap_or("unknown");
            let is_error = v
                .get("is_error")
                .and_then(|e| e.as_bool())
                .unwrap_or(false);
            let error = v
                .get("error")
                .and_then(|e| e.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| {
                    if is_error {
                        v.get("result")
                            .and_then(|r| r.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                });
            // `error_during_execution` is how the Claude CLI signals that the
            // user aborted the turn via `control_request interrupt`. Treat it
            // as a distinct `interrupted` status so the renderer can suppress
            // the bubble (the user already knows they hit stop).
            let status = if status_str == "error_during_execution" {
                "interrupted"
            } else if is_error || status_str != "success" {
                "error"
            } else {
                "completed"
            };
            let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
            // Claude/Cursor: `usage`, Gemini: `stats`
            let usage = v.get("usage").or_else(|| v.get("stats"));
            // Claude: snake_case, Cursor: camelCase
            let input_tokens = usage
                .and_then(|u| u.get("input_tokens").or_else(|| u.get("inputTokens")))
                .and_then(|t| t.as_u64());
            let output_tokens = usage
                .and_then(|u| u.get("output_tokens").or_else(|| u.get("outputTokens")))
                .and_then(|t| t.as_u64());
            let cache_read_tokens = usage
                .and_then(|u| {
                    u.get("cache_read_input_tokens")
                        .or_else(|| u.get("cacheReadTokens"))
                        .or_else(|| u.get("cached"))
                })
                .and_then(|t| t.as_u64());
            let cache_write_tokens = usage
                .and_then(|u| {
                    u.get("cache_creation_input_tokens")
                        .or_else(|| u.get("cacheWriteTokens"))
                })
                .and_then(|t| t.as_u64());
            vec![OutputItem::TurnEnd {
                status: status.to_string(),
                cost,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                error,
            }]
        }

        // -- Telemetry events we can surface --
        "tool_progress" => {
            let tool = v
                .get("tool_name")
                .and_then(|t| t.as_str())
                .unwrap_or("tool");
            let elapsed = v
                .get("elapsed_time_seconds")
                .and_then(|e| e.as_f64())
                .unwrap_or(0.0);
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

        // ── Cursor-specific events ───────────────────────────────────────
        "tool_call" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let tc = v.get("tool_call").and_then(|t| t.as_object());
            match subtype {
                "started" => {
                    if let Some(tc) = tc {
                        let (tool, input) = parse_cursor_tool_call(tc);
                        vec![OutputItem::ToolStart { tool, input }]
                    } else {
                        vec![]
                    }
                }
                "completed" => {
                    if let Some(tc) = tc {
                        let output = extract_cursor_tool_result(tc);
                        vec![OutputItem::ToolResult {
                            text: output,
                            is_error: false,
                        }]
                    } else {
                        vec![]
                    }
                }
                _ => vec![],
            }
        }

        "thinking" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if subtype == "delta" {
                if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        return vec![OutputItem::Thinking {
                            text: text.to_string(),
                        }];
                    }
                }
            }
            vec![]
        }

        // ── Codex event format ────────────────────────────────────────────
        // Streaming text delta
        "item.delta" => {
            let delta = v.get("delta");
            if delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) == Some("text_delta") {
                if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                    return vec![OutputItem::Text {
                        text: text.to_string(),
                    }];
                }
            }
            vec![]
        }

        // Tool started: show the command/tool being invoked
        "item.started" => {
            let item = match v.get("item") {
                Some(i) => i,
                None => return vec![],
            };
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "command_execution" => {
                    let cmd = item
                        .get("command")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    vec![OutputItem::ToolStart {
                        tool: "shell".to_string(),
                        input: cmd,
                    }]
                }
                _ => vec![],
            }
        }

        // Completed item: agent message, command result, tool call, or tool result
        "item.completed" => {
            let item = match v.get("item") {
                Some(i) => i,
                None => return vec![],
            };
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "agent_message" => item
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|text| {
                        vec![OutputItem::Text {
                            text: text.to_string(),
                        }]
                    })
                    .unwrap_or_default(),
                "command_execution" => {
                    let output = item
                        .get("aggregated_output")
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_error = item
                        .get("exit_code")
                        .and_then(|c| c.as_i64())
                        .map(|c| c != 0)
                        .unwrap_or(false);
                    vec![OutputItem::ToolResult {
                        text: output,
                        is_error,
                    }]
                }
                "tool_call" => {
                    let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    let args = item
                        .get("arguments")
                        .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
                        .unwrap_or_default();
                    vec![OutputItem::ToolStart {
                        tool: name.to_string(),
                        input: args,
                    }]
                }
                "tool_result" => {
                    let output = item
                        .get("output")
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_error = item
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);
                    vec![OutputItem::ToolResult {
                        text: output,
                        is_error,
                    }]
                }
                "file_change" => format_codex_file_change(item),
                "file_read" => {
                    let path = item
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("(unknown)")
                        .to_string();
                    vec![
                        OutputItem::ToolStart {
                            tool: "Read".to_string(),
                            input: path.clone(),
                        },
                        OutputItem::ToolResult {
                            text: path,
                            is_error: false,
                        },
                    ]
                }
                _ => vec![],
            }
        }

        // Turn completed: emit TurnEnd with token usage
        "turn.completed" => {
            let usage = v.get("usage");
            let input_tokens = usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|t| t.as_u64());
            let output_tokens = usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|t| t.as_u64());
            let cache_read_tokens = usage
                .and_then(|u| u.get("cached_input_tokens"))
                .and_then(|t| t.as_u64());
            vec![OutputItem::TurnEnd {
                status: "completed".to_string(),
                cost: None,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens: None,
                error: None,
            }]
        }

        // Ignored Codex lifecycle events
        "thread.started" | "turn.started" | "item.created" => vec![],

        // ── OpenCode event format ────────────────────────────────────────
        "text" => {
            let part = match v.get("part") {
                Some(p) => p,
                None => return vec![],
            };
            // OpenCode nests the assistant text inside part — try known field names
            let content = part
                .get("content")
                .and_then(|c| c.as_str())
                .or_else(|| part.get("text").and_then(|t| t.as_str()));
            match content {
                Some(text) if !text.is_empty() => vec![OutputItem::Text {
                    text: text.to_string(),
                }],
                _ => {
                    eprintln!(
                        "[verun][opencode] unhandled text part: {}",
                        serde_json::to_string(part).unwrap_or_default()
                    );
                    vec![]
                }
            }
        }

        "tool_use" => {
            if let Some(part) = v.get("part") {
                // OpenCode format: { type: "tool_use", part: { tool, state: { status, input, output } } }
                let tool = part
                    .get("tool")
                    .and_then(|t| t.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let state = part.get("state");
                let status = state
                    .and_then(|s| s.get("status"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if status == "completed" {
                    let input = state
                        .and_then(|s| s.get("input"))
                        .map(|i| serde_json::to_string_pretty(i).unwrap_or_default())
                        .unwrap_or_default();
                    let output = state
                        .and_then(|s| s.get("output"))
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_string();
                    vec![
                        OutputItem::ToolStart { tool, input },
                        OutputItem::ToolResult {
                            text: output,
                            is_error: false,
                        },
                    ]
                } else {
                    let input = state
                        .and_then(|s| s.get("input"))
                        .map(|i| serde_json::to_string_pretty(i).unwrap_or_default())
                        .unwrap_or_default();
                    vec![OutputItem::ToolStart { tool, input }]
                }
            } else {
                // Gemini format: { type: "tool_use", tool_name, tool_id, parameters }
                let tool = v
                    .get("tool_name")
                    .and_then(|t| t.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = v
                    .get("parameters")
                    .map(|p| serde_json::to_string_pretty(p).unwrap_or_default())
                    .unwrap_or_default();
                vec![OutputItem::ToolStart { tool, input }]
            }
        }

        "step_finish" => {
            let part = v.get("part");
            let reason = part
                .and_then(|p| p.get("reason"))
                .and_then(|r| r.as_str())
                .unwrap_or("stop");
            if reason == "stop" {
                let tokens = part.and_then(|p| p.get("tokens"));
                // OpenCode's `input` is a fixed overhead (not user message tokens)
                // and `total` is the cumulative context window. Only `output` is
                // meaningful per-turn, so we skip input to avoid misleading numbers.
                let output_tokens = tokens
                    .and_then(|t| t.get("output"))
                    .and_then(|t| t.as_u64());
                let input_tokens = tokens.and_then(|t| t.get("total")).and_then(|t| t.as_u64());
                let cache = tokens.and_then(|t| t.get("cache"));
                let cache_read_tokens = cache.and_then(|c| c.get("read")).and_then(|t| t.as_u64());
                let cache_write_tokens =
                    cache.and_then(|c| c.get("write")).and_then(|t| t.as_u64());
                let cost = part
                    .and_then(|p| p.get("cost"))
                    .and_then(|c| c.as_f64())
                    .filter(|c| *c > 0.0);
                vec![OutputItem::TurnEnd {
                    status: "completed".to_string(),
                    cost,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    error: None,
                }]
            } else {
                vec![]
            }
        }

        "step_start" => vec![],

        // ── Gemini CLI event format ──────────────────────────────────────
        "message" => {
            let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "assistant" {
                return vec![];
            }
            match v.get("content").and_then(|c| c.as_str()) {
                Some(text) if !text.is_empty() => vec![OutputItem::Text {
                    text: text.to_string(),
                }],
                _ => vec![],
            }
        }

        "tool_result" if v.get("tool_id").is_some() => {
            // Gemini format: { type: "tool_result", tool_id, status, output }
            let output = v
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = v.get("status").and_then(|s| s.as_str()) == Some("error");
            vec![OutputItem::ToolResult {
                text: output,
                is_error,
            }]
        }

        _ => vec![],
    }
}

/// Map a single `codex app-server` JSON-RPC **notification** to UI output
/// items. The legacy `exec --json` path in `parse_sdk_event_value` maps
/// top-level `type` strings; this one maps RPC `method` strings.
///
/// Wire ref: t3code `packages/effect-codex-app-server/src/_generated/meta.gen.ts`.
pub fn process_codex_rpc_notification(
    method: &str,
    params: &serde_json::Value,
) -> Vec<OutputItem> {
    match method {
        // -- Token deltas (streamed into the current assistant / thinking block) --
        "item/agentMessage/delta" => params
            .get("delta")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|text| {
                vec![OutputItem::Text {
                    text: text.to_string(),
                }]
            })
            .unwrap_or_default(),
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => params
            .get("delta")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|text| {
                vec![OutputItem::Thinking {
                    text: text.to_string(),
                }]
            })
            .unwrap_or_default(),
        // Plan-mode streams the `<proposed_plan>...</proposed_plan>` body
        // through a dedicated `plan` ThreadItem. Emit deltas as a distinct
        // variant so the frontend can accumulate them into a live plan
        // viewer overlay instead of the chat transcript.
        "item/plan/delta" => {
            let item_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            params
                .get("delta")
                .and_then(|d| d.as_str())
                .filter(|s| !s.is_empty())
                .map(|text| {
                    vec![OutputItem::CodexPlanDelta {
                        item_id: item_id.clone(),
                        delta: text.to_string(),
                    }]
                })
                .unwrap_or_default()
        }

        // -- Item lifecycle (command / tool / file change / file read) --
        // Live `codex app-server` (>= 0.120) emits camelCase item types
        // (`commandExecution`, `agentMessage`, `fileChange`, `fileRead`,
        // `toolCall`, `toolResult`) and camelCase fields (`aggregatedOutput`,
        // `exitCode`, `isError`). The snake_case variants are kept as a
        // transitional alias so replayed transcripts from older CLIs still
        // render.
        "item/started" => {
            let Some(item) = params.get("item") else {
                return vec![];
            };
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "commandExecution" | "command_execution" => vec![OutputItem::ToolStart {
                    tool: "shell".to_string(),
                    input: item
                        .get("command")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string(),
                }],
                "toolCall" | "tool_call" => {
                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let args = item
                        .get("arguments")
                        .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
                        .unwrap_or_default();
                    vec![OutputItem::ToolStart {
                        tool: name,
                        input: args,
                    }]
                }
                _ => vec![],
            }
        }
        "item/completed" => {
            let Some(item) = params.get("item") else {
                return vec![];
            };
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                // `agentMessage` already streams via `item/agentMessage/delta`;
                // re-emitting the final text here would render the assistant
                // reply twice. Swallow the completion frame.
                "agentMessage" | "agent_message" => vec![],
                // `plan` items stream via `item/plan/delta`; the completion
                // frame carries the authoritative text. Emit it as
                // `CodexPlanReady` so the caller (which has worktree context)
                // can persist the markdown and the frontend can flip the
                // live plan viewer into the "approve / request changes"
                // resolution state.
                "plan" => {
                    let item_id = item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let text = item
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![OutputItem::CodexPlanReady {
                            item_id,
                            text,
                            file_path: None,
                        }]
                    }
                }
                "commandExecution" | "command_execution" => {
                    let output = item
                        .get("aggregatedOutput")
                        .or_else(|| item.get("aggregated_output"))
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_error = item
                        .get("exitCode")
                        .or_else(|| item.get("exit_code"))
                        .and_then(|c| c.as_i64())
                        .map(|c| c != 0)
                        .unwrap_or(false);
                    vec![OutputItem::ToolResult {
                        text: output,
                        is_error,
                    }]
                }
                "toolCall" | "tool_call" => {
                    let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    let args = item
                        .get("arguments")
                        .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
                        .unwrap_or_default();
                    vec![OutputItem::ToolStart {
                        tool: name.to_string(),
                        input: args,
                    }]
                }
                "toolResult" | "tool_result" => {
                    let output = item
                        .get("output")
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_error = item
                        .get("isError")
                        .or_else(|| item.get("is_error"))
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);
                    vec![OutputItem::ToolResult {
                        text: output,
                        is_error,
                    }]
                }
                "fileChange" | "file_change" => format_codex_file_change(item),
                "fileRead" | "file_read" => {
                    let path = item
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("(unknown)")
                        .to_string();
                    vec![
                        OutputItem::ToolStart {
                            tool: "Read".to_string(),
                            input: path.clone(),
                        },
                        OutputItem::ToolResult {
                            text: path,
                            is_error: false,
                        },
                    ]
                }
                _ => vec![],
            }
        }

        // -- Plan-mode and diff updates --
        "turn/plan/updated" => {
            let plan = params
                .get("plan")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let items = plan
                .into_iter()
                .map(|step| PlanStep {
                    status: step
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("pending")
                        .to_string(),
                    step: step
                        .get("step")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect();
            let explanation = params
                .get("explanation")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string());
            vec![OutputItem::PlanUpdate { items, explanation }]
        }
        "turn/diff/updated" => {
            let diff = params
                .get("diff")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            if diff.is_empty() {
                vec![]
            } else {
                vec![OutputItem::DiffUpdate { diff }]
            }
        }

        // -- Turn completion --
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(serde_json::Value::Null);
            let status_str = turn
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("completed");
            let error_msg = turn
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string());
            let status = match status_str {
                "completed" => "completed",
                "failed" => "error",
                "cancelled" | "canceled" | "interrupted" => "interrupted",
                _ => "completed",
            };
            vec![OutputItem::TurnEnd {
                status: status.to_string(),
                cost: None,
                input_tokens: None,
                output_tokens: None,
                cache_read_tokens: None,
                cache_write_tokens: None,
                error: error_msg,
            }]
        }

        // -- Provider-level error outside a turn --
        "error" => {
            let message = params
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Codex error")
                .to_string();
            vec![OutputItem::ErrorMessage {
                message,
                raw: Some(params.to_string()),
            }]
        }

        // Lifecycle / deltas we don't surface yet — swallow silently, the
        // same way the legacy `exec --json` path drops lifecycle frames.
        _ => vec![],
    }
}

fn format_codex_file_change(item: &serde_json::Value) -> Vec<OutputItem> {
    let changes = item
        .get("changes")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items = Vec::with_capacity(changes.len() * 2);
    for change in &changes {
        let path = change
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("(unknown)")
            .to_string();
        // `PatchChangeKind` is an object discriminated by `type`
        // (`{"type":"add"}` / `{"type":"delete"}` / `{"type":"update", move_path?}`),
        // not a bare string. Older CLIs emitted a string; accept both.
        let kind = change
            .get("kind")
            .and_then(|k| k.get("type").and_then(|t| t.as_str()).or_else(|| k.as_str()))
            .unwrap_or("");
        let tool = match kind {
            "add" => "Write",
            "delete" => "Delete",
            _ => "Edit",
        };
        items.push(OutputItem::ToolStart {
            tool: tool.to_string(),
            input: path.clone(),
        });
        items.push(OutputItem::ToolResult {
            text: path,
            is_error: false,
        });
    }

    if items.is_empty() {
        vec![OutputItem::System {
            text: "File changed".to_string(),
        }]
    } else {
        items
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
                        vec![OutputItem::Text {
                            text: text.to_string(),
                        }]
                    }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![OutputItem::Thinking {
                            text: text.to_string(),
                        }]
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
                    let input = block
                        .get("input")
                        .cloned()
                        .unwrap_or(serde_json::Value::Object(Default::default()));
                    let input_str = if input.is_object()
                        && input.as_object().map(|o| o.is_empty()).unwrap_or(true)
                    {
                        String::new()
                    } else {
                        serde_json::to_string_pretty(&input).unwrap_or_default()
                    };
                    vec![OutputItem::ToolStart {
                        tool: name.to_string(),
                        input: input_str,
                    }]
                }
                _ => {
                    vec![]
                }
            }
        }
        "content_block_stop" | "message_start" | "message_delta" | "message_stop" => vec![],
        _ => {
            vec![]
        }
    }
}

/// Parse a full assistant message snapshot.
/// With --include-partial-messages, stream_event deltas already deliver text/thinking
/// in real-time, so the snapshot is redundant for those. We skip it to avoid duplication.
/// However, we DO extract tool_use blocks since content_block_start may not always arrive.
fn parse_assistant_message(v: &serde_json::Value) -> Vec<OutputItem> {
    let message = match v.get("message") {
        Some(m) => m,
        None => return vec![],
    };
    let content = match message.get("content").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return vec![],
    };

    // Synthetic assistant snapshots (e.g. "Prompt is too long", API errors)
    // arrive with `model: "<synthetic>"` and carry the error text as a text
    // block — they never have stream_event deltas, so skipping text here
    // would drop the message entirely. For regular assistant snapshots text
    // is already delivered via deltas, so we skip it to avoid duplication.
    let is_synthetic = message.get("model").and_then(|m| m.as_str()) == Some("<synthetic>");

    let mut items = Vec::new();
    for block in content {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match block_type {
            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let input = block
                    .get("input")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(Default::default()));
                let input_str = if input.is_object()
                    && input.as_object().map(|o| o.is_empty()).unwrap_or(true)
                {
                    String::new()
                } else {
                    serde_json::to_string_pretty(&input).unwrap_or_default()
                };
                items.push(OutputItem::ToolStart {
                    tool: name.to_string(),
                    input: input_str,
                });
            }
            "text" if is_synthetic => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        let raw = serde_json::to_string(v).ok();
                        items.push(OutputItem::ErrorMessage {
                            message: text.to_string(),
                            raw,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    items
}

/// Extract text from a Cursor streaming assistant delta (has `timestamp_ms`).
fn parse_assistant_text_only(v: &serde_json::Value) -> Vec<OutputItem> {
    let content = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(c) => c,
        None => return vec![],
    };
    let mut items = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        items.push(OutputItem::Text {
                            text: text.to_string(),
                        });
                    }
                }
            }
            "thinking" => {
                if let Some(text) = block.get("thinking").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        items.push(OutputItem::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    items
}

/// Parse user messages (typically tool results)
fn parse_user_message(v: &serde_json::Value) -> Vec<OutputItem> {
    let content = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(c) => c,
        None => return vec![],
    };

    let mut items = Vec::new();
    for block in content {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if block_type == "tool_result" {
            let is_error = block
                .get("is_error")
                .and_then(|e| e.as_bool())
                .unwrap_or(false);
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

/// Parse a Cursor tool_call object like `{"readToolCall": {"args": {"path": "..."}, ...}}`
/// into (tool_name, input_string).
fn parse_cursor_tool_call(tc: &serde_json::Map<String, serde_json::Value>) -> (String, String) {
    // The object has a single key like "readToolCall", "editToolCall", "bashToolCall", etc.
    if let Some((key, val)) = tc.iter().next() {
        let tool = key
            .trim_end_matches("ToolCall")
            .trim_end_matches("Tool_call")
            .to_string();
        let args = val.get("args");
        let input = args
            .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
            .unwrap_or_default();
        (tool, input)
    } else {
        ("tool".to_string(), String::new())
    }
}

/// Extract result text from a Cursor completed tool_call object.
fn extract_cursor_tool_result(tc: &serde_json::Map<String, serde_json::Value>) -> String {
    if let Some((_key, val)) = tc.iter().next() {
        val.get("result")
            .and_then(|r| r.as_str())
            .or_else(|| val.get("output").and_then(|o| o.as_str()))
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Main streaming loop
// ---------------------------------------------------------------------------

pub struct StreamResult {
    pub total_cost: f64,
    pub error: Option<String>,
}

/// After a turn ends, snapshot the worktree and persist a `turn_snapshots`
/// row keyed to the latest assistant message uuid in the on-disk JSONL.
///
/// All failures are logged and swallowed — the snapshot machinery is
/// best-effort and must never break the streaming hot path.
async fn snapshot_turn_best_effort(
    verun_session_id: &str,
    worktree_path: &str,
    resume_session_id: Option<&str>,
    db_tx: &DbWriteTx,
    app: &AppHandle,
) {
    let csid = match resume_session_id {
        Some(s) => s.to_string(),
        None => return,
    };
    let worktree = worktree_path.to_string();
    let verun_sid = verun_session_id.to_string();
    let db_tx = db_tx.clone();
    let app = app.clone();

    // Do all blocking I/O off the runtime thread.
    let result = tokio::task::spawn_blocking(move || {
        let wt_path = Path::new(&worktree);
        let jsonl = match claude_jsonl::session_path(wt_path, &csid) {
            Some(p) => p,
            None => return Err("no $HOME for jsonl path".to_string()),
        };
        if !jsonl.exists() {
            return Err(format!("jsonl not found: {}", jsonl.display()));
        }
        let last_uuid = latest_assistant_text_uuid(&jsonl)
            .ok_or_else(|| "no assistant text uuid in jsonl".to_string())?;
        let sha = snapshots::snapshot_turn(wt_path, &verun_sid, &last_uuid)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "snapshot returned None (no HEAD?)".to_string())?;
        Ok::<(String, String), String>((last_uuid, sha))
    })
    .await;

    if let Ok(Ok((message_uuid, stash_sha))) = result {
        let now = now_ms();
        let _ = db_tx
            .send(DbWrite::InsertTurnSnapshot {
                session_id: verun_session_id.to_string(),
                message_uuid: message_uuid.clone(),
                stash_sha,
                created_at: now,
            })
            .await;

        let marker = serde_json::json!({
            "type": "verun_turn_snapshot",
            "sessionId": verun_session_id,
            "messageUuid": message_uuid,
        })
        .to_string();
        let _ = db_tx
            .send(DbWrite::InsertOutputLines {
                session_id: verun_session_id.to_string(),
                lines: vec![(marker.clone(), now)],
            })
            .await;

        let _ = app.emit(
            "session-output",
            SessionOutputEvent {
                session_id: verun_session_id.to_string(),
                items: vec![OutputItem::TurnSnapshot {
                    message_uuid: message_uuid.clone(),
                }],
            },
        );
    }
}

/// Walk a Claude Code session JSONL and return the uuid of the most recent
/// `type=assistant` line whose message content contains a `text` block.
fn latest_assistant_text_uuid(jsonl_path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(jsonl_path).ok()?;
    let reader = BufReader::new(f);
    let mut last: Option<String> = None;
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array());
        let has_text = match content {
            Some(arr) => arr
                .iter()
                .any(|c| c.get("type").and_then(|t| t.as_str()) == Some("text")),
            None => false,
        };
        if !has_text {
            continue;
        }
        if let Some(uuid) = v.get("uuid").and_then(|u| u.as_str()) {
            last = Some(uuid.to_string());
        }
    }
    last
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
    busy: Arc<AtomicBool>,
    pending_approvals: PendingApprovals,
    pending_approval_meta: PendingApprovalMeta,
    pending_control_responses: PendingControlResponses,
    db_tx: DbWriteTx,
    worktree_path: String,
    repo_path: String,
    trust_level: Arc<AtomicU8>,
    agent: Box<dyn crate::agent::Agent>,
) -> StreamResult {
    let mut reader = BufReader::new(stdout).lines();
    let mut buffer: Vec<OutputItem> = Vec::new();
    let mut last_flush = Instant::now();
    let mut total_persisted: usize = 0;
    let mut total_cost: f64 = 0.0;
    let mut last_error: Option<String> = None;
    // Captured from `system.init` events for the per-turn snapshot hook.
    let mut resume_id_for_snapshot: Option<String> = None;
    // For agents that defer (Codex): hold the captured id until the first
    // turn completes, because the rollout file isn't persisted until then.
    let mut pending_resume_id: Option<String> = None;
    let defers_resume = agent.defers_resume_id_until_turn_end();

    loop {
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        eprintln!("[verun][stream][{session_id}] {line}");

                        // Cleanly skip non-JSON garbage (e.g. `[SandboxDebug]` lines the CLI
                        // can interleave under permission/sandbox modes). Matches the
                        // claude-agent-sdk-python fix for issue #347.
                        let trimmed = line.trim_start();
                        if !trimmed.starts_with('{') {
                            if !trimmed.is_empty() {
                                eprintln!("[verun][stream][{session_id}] skipping non-JSON: {trimmed}");
                            }
                            continue;
                        }

                        // Parse each line exactly once. Every downstream check (control_request,
                        // control_response, resume_id extraction, rate_limit, event parse) now
                        // works off this one `Value`.
                        let v: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => {
                                eprintln!("[verun][stream][{session_id}] JSON parse error: {e}");
                                // Keep the raw line visible in the UI rather than silently dropping it
                                let items = vec![OutputItem::Raw { text: line.clone() }];
                                for item in &items { buffer.push(item.clone()); }
                                persist_items(&db_tx, &session_id, &items, &mut total_persisted);
                                continue;
                            }
                        };
                        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                        // Incoming `control_response` — resolve the matching pending oneshot so
                        // IPC callers like `interrupt_session` / `get_session_context_usage`
                        // can unblock. No UI emission for these.
                        if msg_type == "control_response" {
                            if let Some(response) = v.get("response") {
                                if let Some(req_id) = response.get("request_id").and_then(|r| r.as_str()) {
                                    if let Some((_, tx)) = pending_control_responses.remove(req_id) {
                                        let subtype = response.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                                        let result = if subtype == "error" {
                                            Err(response.get("error")
                                                .and_then(|e| e.as_str())
                                                .unwrap_or("CLI returned error")
                                                .to_string())
                                        } else {
                                            Ok(response.get("response").cloned().unwrap_or(serde_json::Value::Null))
                                        };
                                        let _ = tx.send(result);
                                    }
                                }
                            }
                            continue;
                        }

                        // Intercept control_request for tool approval
                        if let Some(cr) = handle_control_request(
                            &app, &session_id, &task_id, &v, &stdin,
                            &pending_approvals, &pending_approval_meta,
                            &worktree_path, &repo_path,
                            &trust_level, &db_tx,
                        ).await {
                            if cr.handled {
                                if let Some(tool_start) = cr.tool_start {
                                    buffer.push(tool_start.clone());
                                    persist_items(&db_tx, &session_id, &[tool_start], &mut total_persisted);
                                }
                                continue;
                            }
                        }

                        // Extract the resume session id via the agent's own logic
                        if resume_id_for_snapshot.is_none() {
                            if let Some(sid) = agent.extract_resume_id(&v) {
                                resume_id_for_snapshot = Some(sid.clone());
                                if defers_resume {
                                    pending_resume_id = Some(sid);
                                } else {
                                    let _ = db_tx.send(crate::db::DbWrite::SetResumeSessionId {
                                        id: session_id.clone(),
                                        resume_session_id: sid,
                                    }).await;
                                }
                            }
                        }

                        // Intercept rate_limit_event — emit as separate Tauri event
                        if msg_type == "rate_limit_event" {
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

                        // Parse NDJSON into structured items (already have Value — no re-parse)
                        let items = parse_sdk_event_value(&v);

                        // Emit text/thinking deltas immediately for real-time streaming
                        let mut has_immediate = false;
                        let mut is_turn_end = false;
                        for item in &items {
                            match item {
                                OutputItem::Text { .. } | OutputItem::Thinking { .. } => {
                                    if !buffer.is_empty() {
                                        flush_buffer(&app, &session_id, &mut buffer);
                                    }
                                    emit_item(&app, &session_id, item.clone());
                                    has_immediate = true;
                                }
                                OutputItem::TurnEnd { cost, error: ref err, .. } => {
                                    is_turn_end = true;
                                    if let Some(c) = cost {
                                        total_cost += *c;
                                    }
                                    if err.is_some() {
                                        last_error.clone_from(err);
                                    }
                                    buffer.push(item.clone());
                                }
                                _ => {
                                    buffer.push(item.clone());
                                }
                            }
                        }

                        // Persist pre-parsed items (agent-format-agnostic)
                        persist_items(&db_tx, &session_id, &items, &mut total_persisted);

                        // Commit the deferred resume id once a turn has completed —
                        // by this point the agent (e.g. Codex) has written its
                        // rollout file, so the id is safe to use for future resumes.
                        if is_turn_end {
                            if let Some(sid) = pending_resume_id.take() {
                                let _ = db_tx.send(crate::db::DbWrite::SetResumeSessionId {
                                    id: session_id.clone(),
                                    resume_session_id: sid,
                                }).await;
                            }
                        }

                        // For one-shot-per-turn agents (e.g. Codex), close stdin so
                        // the CLI exits and we respawn on next send. For persistent
                        // agents (Claude), keep stdin open — `busy=false` signals the
                        // process is ready for the next turn. Since the process never
                        // exits, the monitor's post-stream status emission never fires,
                        // so we emit it here: idle on success, error (with the provider
                        // message) on an API/auth failure so the retry banner renders.
                        if is_turn_end {
                            if !agent.persists_across_turns() {
                                let mut guard = stdin.lock().await;
                                drop(guard.take());
                            } else {
                                let (status, error) = turn_end_session_status(&last_error);
                                let _ = db_tx.send(DbWrite::UpdateSessionStatus {
                                    id: session_id.clone(),
                                    status: status.to_string(),
                                }).await;
                                let _ = app.emit(
                                    "session-status",
                                    SessionStatusEvent {
                                        session_id: session_id.clone(),
                                        status: status.to_string(),
                                        error,
                                    },
                                );
                                // Clear so the next turn starts clean — the error is
                                // associated with the turn that just ended, not future ones.
                                last_error = None;
                            }
                            busy.store(false, Ordering::SeqCst);
                        }

                        // Flush buffer. On turn end we ALWAYS flush so the TurnEnd
                        // event reaches the frontend before any subsequent turn-snapshot
                        // marker — otherwise the marker walks back to find an assistant
                        // block that hasn't been created yet.
                        if !buffer.is_empty()
                            && (has_immediate || is_turn_end || last_flush.elapsed() >= FLUSH_INTERVAL)
                        {
                            flush_buffer(&app, &session_id, &mut buffer);
                            last_flush = Instant::now();
                        }

                        // Fire-and-forget: snapshot the worktree and persist a turn_snapshots
                        // row keyed to the latest assistant message uuid in the on-disk JSONL.
                        // Used by the "fork from this message" feature. We deliberately do
                        // NOT await this so the stream loop is never blocked on git I/O.
                        if is_turn_end && agent.uses_claude_jsonl() {
                            let sid = session_id.clone();
                            let wt = worktree_path.clone();
                            let csid = resume_id_for_snapshot.clone();
                            let dbtx = db_tx.clone();
                            let app2 = app.clone();
                            tokio::spawn(async move {
                                snapshot_turn_best_effort(
                                    &sid,
                                    &wt,
                                    csid.as_deref(),
                                    &dbtx,
                                    &app2,
                                )
                                .await;
                            });
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
    StreamResult {
        total_cost,
        error: last_error,
    }
}

/// JSON-RPC streaming loop for Codex `app-server`. Mirrors the legacy
/// `stream_and_capture` but consumes `CodexRpcEvent`s instead of parsing
/// NDJSON from stdout. Server-originated approval requests are routed
/// through `pending_approvals` the same way Claude's `control_request`
/// tool approvals are.
#[allow(clippy::too_many_arguments)]
pub async fn stream_and_capture_rpc(
    app: AppHandle,
    session_id: String,
    task_id: String,
    mut events_rx: tokio::sync::mpsc::UnboundedReceiver<
        crate::agent::codex_rpc::CodexRpcEvent,
    >,
    stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    busy: Arc<AtomicBool>,
    _pending_approvals: PendingApprovals,
    _pending_approval_meta: PendingApprovalMeta,
    db_tx: DbWriteTx,
    agent: &dyn crate::agent::Agent,
    // Slot populated by the `turn/start` response watcher and read by
    // `abort_message`. The stream loop clears it on `turn/completed` so the
    // next abort cannot target a stale (already-finished) turn id.
    current_turn_id: Arc<TokioMutex<Option<String>>>,
    // Worktree path — used to persist Codex plan-mode proposals as markdown
    // under `<worktree>/.verun/plans/` so restoring the session can re-open
    // them via the existing `planFilePathForSession` flow.
    worktree_path: std::path::PathBuf,
) -> StreamResult {
    let mut buffer: Vec<OutputItem> = Vec::new();
    let mut last_flush = Instant::now();
    let mut total_persisted: usize = 0;
    let mut last_error: Option<String> = None;
    // `turn/completed` from `codex app-server` does not carry token usage —
    // usage arrives via the separate `thread/tokenUsage/updated` notification
    // that fires throughout the turn. Cache the most recent breakdown so we
    // can populate the next `TurnEnd` before emitting it to the UI / db.
    let mut last_token_usage: Option<CodexTokenUsage> = None;
    let _ = task_id; // reserved for snapshot hook parity with legacy path

    loop {
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        tokio::select! {
            ev = events_rx.recv() => {
                let Some(ev) = ev else { break };
                match ev {
                    crate::agent::codex_rpc::CodexRpcEvent::Notification { method, params } => {
                        eprintln!("[verun][codex-rpc][{session_id}] <- {method}");

                        // Cache the most recent per-turn token breakdown so
                        // the next `turn/completed` can stamp the values onto
                        // the emitted `TurnEnd`. `last` is the current turn's
                        // usage — `total` is the whole thread.
                        if method == "thread/tokenUsage/updated" {
                            if let Some(usage) = extract_codex_token_usage(&params) {
                                last_token_usage = Some(usage);
                            }
                            continue;
                        }

                        let raw_items = process_codex_rpc_notification(&method, &params);
                        let items: Vec<OutputItem> = raw_items
                            .into_iter()
                            .map(|it| patch_turn_end_with_usage(it, &last_token_usage))
                            .map(|it| persist_codex_plan_if_ready(it, &worktree_path))
                            .collect();
                        let mut has_immediate = false;
                        let mut is_turn_end = false;

                        for item in &items {
                            match item {
                                OutputItem::Text { .. }
                                | OutputItem::Thinking { .. }
                                | OutputItem::CodexPlanDelta { .. } => {
                                    if !buffer.is_empty() {
                                        flush_buffer(&app, &session_id, &mut buffer);
                                    }
                                    emit_item(&app, &session_id, item.clone());
                                    has_immediate = true;
                                }
                                OutputItem::TurnEnd { error: ref err, .. } => {
                                    is_turn_end = true;
                                    if err.is_some() {
                                        last_error.clone_from(err);
                                    }
                                    buffer.push(item.clone());
                                }
                                _ => buffer.push(item.clone()),
                            }
                        }

                        persist_items(&db_tx, &session_id, &items, &mut total_persisted);

                        if is_turn_end {
                            let (status, error) = turn_end_session_status(&last_error);
                            let _ = db_tx.send(DbWrite::UpdateSessionStatus {
                                id: session_id.clone(),
                                status: status.to_string(),
                            }).await;
                            let _ = app.emit(
                                "session-status",
                                SessionStatusEvent {
                                    session_id: session_id.clone(),
                                    status: status.to_string(),
                                    error,
                                },
                            );
                            last_error = None;
                            // Reset cached usage so the next turn's
                            // `TurnEnd` reflects that turn only.
                            last_token_usage = None;
                            // Clear the in-flight turn id so a subsequent
                            // abort cannot target this already-finished turn.
                            *current_turn_id.lock().await = None;
                            busy.store(false, Ordering::SeqCst);
                        }

                        if !buffer.is_empty()
                            && (has_immediate
                                || is_turn_end
                                || last_flush.elapsed() >= FLUSH_INTERVAL)
                        {
                            flush_buffer(&app, &session_id, &mut buffer);
                            last_flush = Instant::now();
                        }
                    }
                    crate::agent::codex_rpc::CodexRpcEvent::ServerRequest {
                        id,
                        method,
                        params,
                    } => {
                        eprintln!(
                            "[verun][codex-rpc][{session_id}] <- req {method} id={id}"
                        );
                        if !is_codex_approval_method(&method) {
                            // Truly unknown server-originated request: reply
                            // JSON-RPC method-not-found so the CLI doesn't
                            // sit blocked on a response that never arrives.
                            eprintln!(
                                "[verun][codex-rpc][{session_id}] unhandled server request method: {method} — replying method-not-found"
                            );
                            let frame = serde_json::json!({
                                "id": id,
                                "error": {
                                    "code": -32601,
                                    "message": format!("Method not supported: {method}"),
                                },
                            });
                            if let Ok(mut bytes) = serde_json::to_vec(&frame) {
                                bytes.push(b'\n');
                                let mut guard = stdin.lock().await;
                                if let Some(writer) = guard.as_mut() {
                                    let _ = writer.write_all(&bytes).await;
                                    let _ = writer.flush().await;
                                }
                            }
                            continue;
                        }

                        let request_id = uuid::Uuid::new_v4().to_string();
                        let entry = build_codex_approval_entry(
                            &session_id,
                            &request_id,
                            &method,
                            &params,
                        );
                        let _ = app.emit("tool-approval-request", ToolApprovalEvent {
                            request_id: request_id.clone(),
                            session_id: session_id.clone(),
                            tool_name: entry.tool_name.clone(),
                            tool_input: entry.tool_input.clone(),
                        });

                        let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalResponse>();
                        _pending_approvals.insert(request_id.clone(), tx);
                        _pending_approval_meta.insert(request_id.clone(), entry);

                        let responder_stdin = stdin.clone();
                        let responder_pending = _pending_approvals.clone();
                        let responder_meta = _pending_approval_meta.clone();
                        let responder_sid = session_id.clone();
                        let responder_agent_kind =
                            crate::agent::AgentKind::parse(
                                agent.kind().as_str(),
                            );
                        let responder_method = method.clone();
                        let responder_id = id.clone();
                        let responder_request_id = request_id.clone();
                        tokio::spawn(async move {
                            let response = rx.await.unwrap_or_else(|_| ApprovalResponse {
                                behavior: "deny".to_string(),
                                updated_input: None,
                                message: None,
                            });
                            responder_pending.remove(&responder_request_id);
                            responder_meta.remove(&responder_request_id);
                            let responder_agent = responder_agent_kind.implementation();
                            if let Some(Ok(bytes)) = encode_codex_approval_response(
                                &*responder_agent,
                                &responder_method,
                                &responder_id,
                                &response,
                            ) {
                                let mut guard = responder_stdin.lock().await;
                                if let Some(writer) = guard.as_mut() {
                                    let _ = writer.write_all(&bytes).await;
                                    let _ = writer.flush().await;
                                }
                            } else {
                                eprintln!(
                                    "[verun][codex-rpc][{responder_sid}] failed to encode approval response for {responder_method}"
                                );
                            }
                        });
                    }
                    crate::agent::codex_rpc::CodexRpcEvent::ReaderClosed { reason } => {
                        if let Some(r) = reason {
                            last_error = Some(r);
                        }
                        break;
                    }
                    crate::agent::codex_rpc::CodexRpcEvent::ParseError { line, detail } => {
                        eprintln!(
                            "[verun][codex-rpc][{session_id}] parse error {detail}: {line}"
                        );
                    }
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
    StreamResult {
        total_cost: 0.0,
        error: last_error,
    }
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
    v: &serde_json::Value,
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending_approvals: &PendingApprovals,
    pending_meta: &PendingApprovalMeta,
    worktree_path: &str,
    repo_path: &str,
    trust_level: &Arc<AtomicU8>,
    db_tx: &DbWriteTx,
) -> Option<ControlRequestResult> {
    if v.get("type").and_then(|t| t.as_str()) != Some("control_request") {
        return Some(ControlRequestResult {
            handled: false,
            tool_start: None,
        });
    }

    let request = v.get("request")?;
    if request.get("subtype").and_then(|s| s.as_str()) != Some("can_use_tool") {
        return Some(ControlRequestResult {
            handled: false,
            tool_start: None,
        });
    }

    let cli_request_id = v
        .get("request_id")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let tool_name = request
        .get("tool_name")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown")
        .to_string();
    let tool_input = request
        .get("input")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    // Build a ToolStart item so the frontend knows which tool is running
    let input_str = if tool_input.is_null()
        || (tool_input.is_object() && tool_input.as_object().map(|o| o.is_empty()).unwrap_or(true))
    {
        String::new()
    } else {
        serde_json::to_string_pretty(&tool_input).unwrap_or_default()
    };
    let tool_start = OutputItem::ToolStart {
        tool: tool_name.clone(),
        input: input_str,
    };

    // Evaluate policy — load trust level fresh so mid-run IPC edits apply.
    let result = policy::evaluate(
        &tool_name,
        &tool_input,
        worktree_path,
        repo_path,
        TrustLevel::from_atomic(trust_level),
    );
    let input_summary = policy::summarize_input(&tool_name, &tool_input);

    // Fire-and-forget audit log entry
    let _ = db_tx
        .send(DbWrite::InsertAuditEntry {
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
            tool_name: tool_name.clone(),
            tool_input_summary: input_summary.clone(),
            decision: result.decision.as_str().to_string(),
            reason: result.reason.clone(),
            created_at: crate::task::epoch_ms(),
        })
        .await;

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
            let _ = app.emit(
                "policy-auto-approved",
                PolicyAutoApprovedEvent {
                    session_id: session_id.to_string(),
                    tool_name,
                    tool_input_summary: input_summary,
                    decision: result.decision,
                    reason: result.reason,
                },
            );

            Some(ControlRequestResult {
                handled: true,
                tool_start: Some(tool_start),
            })
        }
        PolicyDecision::RequireApproval => {
            // Original behavior: emit to frontend, wait for user response
            let request_id = uuid::Uuid::new_v4().to_string();

            let _ = app.emit(
                "tool-approval-request",
                ToolApprovalEvent {
                    request_id: request_id.clone(),
                    session_id: session_id.to_string(),
                    tool_name: tool_name.clone(),
                    tool_input: tool_input.clone(),
                },
            );

            let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalResponse>();
            pending_approvals.insert(request_id.clone(), tx);
            pending_meta.insert(
                request_id.clone(),
                PendingApprovalEntry {
                    request_id: request_id.clone(),
                    session_id: session_id.to_string(),
                    tool_name,
                    tool_input: tool_input.clone(),
                },
            );

            let (behavior, updated_input, deny_message) = match rx.await {
                Ok(resp) => (resp.behavior, resp.updated_input, resp.message),
                Err(_) => ("deny".to_string(), None, None),
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
                let msg = deny_message.unwrap_or_else(|| "User denied this action".to_string());
                serde_json::json!({
                    "behavior": "deny",
                    "message": msg,
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

            Some(ControlRequestResult {
                handled: true,
                tool_start: Some(tool_start),
            })
        }
    }
}

fn emit_item(app: &AppHandle, session_id: &str, item: OutputItem) {
    let _ = app.emit(
        "session-output",
        SessionOutputEvent {
            session_id: session_id.to_string(),
            items: vec![item],
        },
    );
}

fn flush_buffer(app: &AppHandle, session_id: &str, buffer: &mut Vec<OutputItem>) {
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

fn persist_line(db_tx: &DbWriteTx, session_id: &str, line: &str, total_persisted: &mut usize) {
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

fn persist_items(
    db_tx: &DbWriteTx,
    session_id: &str,
    items: &[OutputItem],
    total_persisted: &mut usize,
) {
    if items.is_empty() || *total_persisted >= MAX_PERSISTED_LINES {
        return;
    }
    *total_persisted += items.len();
    let line = serde_json::json!({ "type": "verun_items", "items": items }).to_string();
    let now = epoch_ms();
    let _ = db_tx.try_send(DbWrite::InsertOutputLines {
        session_id: session_id.to_string(),
        lines: vec![(line, now)],
    });
}

pub fn map_exit_status(code: Option<i32>) -> &'static str {
    match code {
        Some(0) => "done",
        Some(_) => "error",
        None => "error",
    }
}

/// Decide the `session-status` event payload to emit at turn_end for a
/// persistent agent. The process stays alive, so we can't wait for exit —
/// a turn-level error (e.g. API 401, overload) must propagate as the
/// session status so the frontend can render the retry banner.
pub fn turn_end_session_status(err: &Option<String>) -> (&'static str, Option<String>) {
    match err {
        Some(msg) => ("error", Some(msg.clone())),
        None => ("idle", None),
    }
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Per-turn token accounting captured from `thread/tokenUsage/updated`.
/// `cached_input_tokens` is the "cache read" count reported by the upstream
/// model — Codex does not currently report a separate "cache write" number,
/// so that field stays `None` on emitted `TurnEnd` items.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
}

/// Pull the per-turn usage (`tokenUsage.last`) out of a
/// `thread/tokenUsage/updated` params object. Returns `None` if the shape is
/// unrecognised so the caller can simply skip the frame.
pub fn extract_codex_token_usage(params: &serde_json::Value) -> Option<CodexTokenUsage> {
    let last = params.pointer("/tokenUsage/last")?;
    let input_tokens = last
        .get("inputTokens")
        .or_else(|| last.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = last
        .get("outputTokens")
        .or_else(|| last.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cached_input_tokens = last
        .get("cachedInputTokens")
        .or_else(|| last.get("cached_input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Some(CodexTokenUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
    })
}

/// Stamp the most recent `thread/tokenUsage/updated` breakdown onto a
/// `TurnEnd` item. Leaves non-`TurnEnd` items untouched.
pub fn patch_turn_end_with_usage(
    item: OutputItem,
    usage: &Option<CodexTokenUsage>,
) -> OutputItem {
    match (item, usage) {
        (
            OutputItem::TurnEnd {
                status,
                cost,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                error,
            },
            Some(u),
        ) => OutputItem::TurnEnd {
            status,
            cost,
            input_tokens: input_tokens.or(Some(u.input_tokens)),
            output_tokens: output_tokens.or(Some(u.output_tokens)),
            cache_read_tokens: cache_read_tokens.or(Some(u.cached_input_tokens)),
            cache_write_tokens,
            error,
        },
        (item, _) => item,
    }
}

/// Persist a finalized Codex plan-mode proposal to
/// `<worktree>/.verun/plans/plan-<YYYYMMDD-HHmmss>.md`. Returns the absolute
/// path on success. Errors are non-fatal — the caller surfaces the plan in
/// the viewer either way, the file is just for restore / user reference.
pub fn persist_codex_plan_markdown(
    worktree_path: &Path,
    item_id: &str,
    text: &str,
) -> std::io::Result<std::path::PathBuf> {
    let dir = worktree_path.join(".verun").join("plans");
    std::fs::create_dir_all(&dir)?;
    // Use Unix epoch seconds for a stable, sortable, dependency-free stamp;
    // the frontend formats it for display.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // itemId tail keeps colliding timestamps separable while staying
    // readable; Codex item ids look like `item_...` (~20+ chars).
    let suffix: String = item_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let filename = if suffix.is_empty() {
        format!("plan-{ts}.md")
    } else {
        format!("plan-{ts}-{suffix}.md")
    };
    let path = dir.join(filename);
    std::fs::write(&path, text)?;
    Ok(path)
}

/// Fill in `file_path` on a `CodexPlanReady` item by writing the plan
/// markdown under the worktree. Leaves non-`CodexPlanReady` items untouched.
pub fn persist_codex_plan_if_ready(item: OutputItem, worktree_path: &Path) -> OutputItem {
    match item {
        OutputItem::CodexPlanReady {
            item_id,
            text,
            file_path,
        } => {
            let resolved = file_path.or_else(|| {
                match persist_codex_plan_markdown(worktree_path, &item_id, &text) {
                    Ok(p) => Some(p.to_string_lossy().into_owned()),
                    Err(e) => {
                        eprintln!(
                            "[verun][codex-rpc] failed to persist plan markdown: {e}"
                        );
                        None
                    }
                }
            });
            OutputItem::CodexPlanReady {
                item_id,
                text,
                file_path: resolved,
            }
        }
        other => other,
    }
}

/// True when a Codex JSON-RPC server-originated request is one of the
/// approval prompts Verun routes through `PendingApprovals`.
pub fn is_codex_approval_method(method: &str) -> bool {
    matches!(
        method,
        "applyPatchApproval"
            | "execCommandApproval"
            | "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
    )
}

/// Build the `PendingApprovalEntry` for a Codex JSON-RPC server-originated
/// approval request. Maps the method name onto Verun's canonical tool names
/// so the existing frontend approval UI can render exec / patch / permission
/// prompts without a special-case branch.
pub fn build_codex_approval_entry(
    session_id: &str,
    request_id: &str,
    method: &str,
    params: &serde_json::Value,
) -> PendingApprovalEntry {
    let tool_name = match method {
        "applyPatchApproval" | "item/fileChange/requestApproval" => "Edit",
        "execCommandApproval" | "item/commandExecution/requestApproval" => "Bash",
        "item/permissions/requestApproval" => "Permission",
        "item/tool/requestUserInput" => "AskUserQuestion",
        _ => "Unknown",
    }
    .to_string();
    let tool_input = if method == "item/tool/requestUserInput" {
        build_codex_user_input_tool_input(params)
    } else {
        params.clone()
    };
    PendingApprovalEntry {
        request_id: request_id.to_string(),
        session_id: session_id.to_string(),
        tool_name,
        tool_input,
    }
}

/// Translate `item/tool/requestUserInput` params into the Claude
/// `AskUserQuestion` `tool_input` shape so the existing UI can render it
/// verbatim: `{ questions: [{ question, header?, options?: [{label, description?}], multiSelect: false }] }`.
/// Preserves the Codex question id per question under `_codexQuestionIds`
/// (keyed by question text) so the responder can build the
/// `Record<questionId, {answers: string[]}>` payload without a second lookup.
fn build_codex_user_input_tool_input(params: &serde_json::Value) -> serde_json::Value {
    let questions_in = params
        .get("questions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut questions_out: Vec<serde_json::Value> = Vec::with_capacity(questions_in.len());
    let mut ids: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    for q in &questions_in {
        let question = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
        if question.is_empty() {
            continue;
        }
        let header = q.get("header").and_then(|v| v.as_str());
        let id = q.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let options_out = q
            .get("options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| {
                        let label = o.get("label").and_then(|v| v.as_str())?;
                        let description = o.get("description").and_then(|v| v.as_str());
                        let mut m = serde_json::Map::new();
                        m.insert("label".into(), serde_json::Value::String(label.into()));
                        if let Some(d) = description {
                            m.insert("description".into(), serde_json::Value::String(d.into()));
                        }
                        Some(serde_json::Value::Object(m))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut qm = serde_json::Map::new();
        qm.insert(
            "question".into(),
            serde_json::Value::String(question.to_string()),
        );
        if let Some(h) = header {
            qm.insert("header".into(), serde_json::Value::String(h.to_string()));
        }
        qm.insert("options".into(), serde_json::Value::Array(options_out));
        qm.insert("multiSelect".into(), serde_json::Value::Bool(false));
        questions_out.push(serde_json::Value::Object(qm));
        ids.insert(question.to_string(), serde_json::Value::String(id.into()));
    }
    serde_json::json!({
        "questions": questions_out,
        "_codexQuestionIds": serde_json::Value::Object(ids),
    })
}

/// Encode the JSON-RPC response frame for a Codex server-originated approval.
/// Returns `None` if `method` is not a recognised approval request; the outer
/// `Result` surfaces encoder serialization failures.
pub fn encode_codex_approval_response(
    agent: &dyn crate::agent::Agent,
    method: &str,
    server_req_id: &serde_json::Value,
    response: &ApprovalResponse,
) -> Option<Result<Vec<u8>, String>> {
    let behavior = response.behavior.as_str();
    let allow = behavior == "allow";
    match method {
        "applyPatchApproval" | "execCommandApproval" => {
            let decision = if allow {
                crate::agent::CodexRpcDecision::Approved
            } else {
                crate::agent::CodexRpcDecision::Denied
            };
            Some(agent.encode_rpc_review_decision_response(server_req_id, decision))
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let decision = if allow {
                crate::agent::CodexRpcItemDecision::Accept
            } else {
                crate::agent::CodexRpcItemDecision::Decline
            };
            Some(agent.encode_rpc_item_approval_response(server_req_id, decision))
        }
        "item/permissions/requestApproval" => {
            // Live schema says this response wants
            // `{permissions: GrantedPermissionProfile, scope}` — NOT
            // `{decision: "accept"|"decline"}`. Verun has no UI for granting
            // scoped paths / network yet, so only the deny path is wired up:
            // "allow" falls through to deny so the request does not hang.
            let _ = allow; // granted-permission UI not wired yet
            Some(agent.encode_rpc_permissions_response(
                server_req_id,
                crate::agent::CodexRpcPermissionsDecision::Deny,
            ))
        }
        "item/tool/requestUserInput" => Some(encode_codex_user_input_response(
            server_req_id,
            response.updated_input.as_ref(),
        )),
        _ => None,
    }
}

/// Translate the frontend's `answerQuestion` payload (question-text keyed)
/// back into Codex's `ToolRequestUserInputResponse` shape
/// (question-id keyed, `{answers: string[]}` per entry). The question id
/// side-channel is `updated_input._codexQuestionIds` inserted by
/// `build_codex_user_input_tool_input`.
fn encode_codex_user_input_response(
    server_req_id: &serde_json::Value,
    updated_input: Option<&serde_json::Value>,
) -> Result<Vec<u8>, String> {
    let mut out: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    if let Some(input) = updated_input {
        let answers = input.get("answers").and_then(|v| v.as_object());
        let ids = input.get("_codexQuestionIds").and_then(|v| v.as_object());
        if let (Some(answers), Some(ids)) = (answers, ids) {
            for (question_text, answer_val) in answers {
                let Some(answer_text) = answer_val.as_str() else { continue };
                let Some(id_val) = ids.get(question_text) else { continue };
                let Some(id) = id_val.as_str() else { continue };
                out.insert(
                    id.to_string(),
                    serde_json::json!({ "answers": [answer_text] }),
                );
            }
        }
    }
    let frame = serde_json::json!({
        "id": server_req_id,
        "result": { "answers": serde_json::Value::Object(out) },
    });
    let mut bytes = serde_json::to_vec(&frame)
        .map_err(|e| format!("serialize user input response: {e}"))?;
    bytes.push(b'\n');
    Ok(bytes)
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
        assert!(
            items.is_empty(),
            "System messages should be silently consumed"
        );
    }

    #[test]
    fn parse_result_success_with_usage() {
        let line = r#"{"type":"result","subtype":"success","session_id":"abc","total_cost_usd":0.042,"usage":{"input_tokens":100,"output_tokens":50}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd {
                status,
                cost,
                input_tokens,
                output_tokens,
                error,
                ..
            } => {
                assert_eq!(status, "completed");
                assert_eq!(*cost, Some(0.042));
                assert_eq!(*input_tokens, Some(100));
                assert_eq!(*output_tokens, Some(50));
                assert!(error.is_none());
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
            OutputItem::TurnEnd {
                cost,
                input_tokens,
                output_tokens,
                ..
            } => {
                assert_eq!(*cost, None);
                assert_eq!(*input_tokens, None);
                assert_eq!(*output_tokens, None);
            }
            _ => panic!("Expected TurnEnd item"),
        }
    }

    #[test]
    fn parse_result_error_with_message() {
        let line = r#"{"type":"result","subtype":"error","error":"API Error: 529 overloaded","session_id":"abc"}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status, error, .. } => {
                assert_eq!(status, "error");
                assert_eq!(error.as_deref(), Some("API Error: 529 overloaded"));
            }
            _ => panic!("Expected TurnEnd item"),
        }
    }

    #[test]
    fn parse_result_success_with_is_error_uses_result_text() {
        let line = r#"{"type":"result","subtype":"success","is_error":true,"result":"Prompt is too long","api_error_status":400,"session_id":"abc"}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status, error, .. } => {
                assert_eq!(status, "error");
                assert_eq!(error.as_deref(), Some("Prompt is too long"));
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
    fn turn_end_session_status_idle_when_no_error() {
        let (status, err) = turn_end_session_status(&None);
        assert_eq!(status, "idle");
        assert!(err.is_none());
    }

    #[test]
    fn turn_end_session_status_error_when_present() {
        // Regression: auth/API errors on persistent Claude sessions were
        // dropped because the persistent-agent turn_end branch always
        // emitted idle. The red retry banner depends on status=error +
        // the provider message propagating through session-status.
        let msg = "API Error: 401 authentication_error".to_string();
        let (status, err) = turn_end_session_status(&Some(msg.clone()));
        assert_eq!(status, "error");
        assert_eq!(err.as_deref(), Some(msg.as_str()));
    }

    #[test]
    fn parse_result_error_during_execution_maps_to_interrupted() {
        // Claude CLI emits this subtype when the user sends a
        // `control_request interrupt` mid-turn. It is NOT an error worth
        // surfacing as a red bubble in chat — the user already knows they
        // hit stop. We map it to a distinct `interrupted` status so the
        // renderer can suppress the bubble entirely.
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":1000,"session_id":"abc"}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status, error, .. } => {
                assert_eq!(status, "interrupted");
                assert!(error.is_none(), "interrupt should not carry an error");
            }
            _ => panic!("Expected TurnEnd item"),
        }
    }

    #[test]
    fn parse_assistant_synthetic_error_emits_error_message_with_raw() {
        // When the Claude API returns an error mid-turn (e.g. "Prompt is
        // too long"), the CLI emits a synthetic assistant message with
        // `model: "<synthetic>"` and a text block carrying the error
        // message. We surface it as an `ErrorMessage` item so the UI can
        // render a single persistent retry banner (no duplicate text / sys
        // bubbles) with the raw JSON available for "Show details".
        let line = r#"{"type":"assistant","message":{"id":"x","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"Prompt is too long"}]},"session_id":"abc","uuid":"u","error":"invalid_request"}"#;
        let items = parse_sdk_event(line);
        let err = items.iter().find_map(|i| match i {
            OutputItem::ErrorMessage { message, raw } => Some((message.clone(), raw.clone())),
            _ => None,
        });
        let (message, raw) = err.expect("expected ErrorMessage item");
        assert_eq!(message, "Prompt is too long");
        let raw = raw.expect("expected raw JSON payload");
        assert!(raw.contains("\"<synthetic>\""), "raw should carry source JSON: {raw}");
        // Should NOT emit a duplicate plain Text item for the same synthetic error.
        assert!(
            !items.iter().any(|i| matches!(i, OutputItem::Text { .. })),
            "synthetic error must not also emit a plain Text item: {items:?}"
        );
    }

    #[test]
    fn parse_codex_file_change_as_tool_call() {
        let line = r#"{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/verun-normal-test.txt","kind":"add"}],"status":"completed"}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 2);
        match &items[0] {
            OutputItem::ToolStart { tool, input } => {
                assert_eq!(tool, "Write");
                assert_eq!(input, "/tmp/verun-normal-test.txt");
            }
            _ => panic!("Expected ToolStart"),
        }
        match &items[1] {
            OutputItem::ToolResult { text, is_error } => {
                assert_eq!(text, "/tmp/verun-normal-test.txt");
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult"),
        }
    }

    #[test]
    fn format_codex_file_change_multiple() {
        let item = serde_json::json!({
            "changes": [
                { "path": "src/a.ts", "kind": "update" },
                { "path": "src/b.ts", "kind": "delete" },
                { "path": "src/c.ts", "kind": "add" }
            ]
        });

        let items = format_codex_file_change(&item);
        assert_eq!(items.len(), 6);
        match &items[0] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Edit"),
            _ => panic!("Expected ToolStart"),
        }
        match &items[2] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Delete"),
            _ => panic!("Expected ToolStart"),
        }
        match &items[4] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Write"),
            _ => panic!("Expected ToolStart"),
        }
    }

    #[test]
    fn parse_codex_file_read_as_tool_call() {
        let line = r#"{"type":"item.completed","item":{"id":"item_3","type":"file_read","path":"/tmp/foo.txt","status":"completed"}}"#;
        let items = parse_sdk_event(line);
        assert_eq!(items.len(), 2);
        match &items[0] {
            OutputItem::ToolStart { tool, input } => {
                assert_eq!(tool, "Read");
                assert_eq!(input, "/tmp/foo.txt");
            }
            _ => panic!("Expected ToolStart"),
        }
        match &items[1] {
            OutputItem::ToolResult { text, is_error } => {
                assert_eq!(text, "/tmp/foo.txt");
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult"),
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
            error: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["sessionId"], "s-001");
        assert_eq!(json["status"], "done");
    }

    #[test]
    fn output_item_text_serializes() {
        let item = OutputItem::Text {
            text: "hello".into(),
        };
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
        let item = OutputItem::ToolStart {
            tool: "Bash".into(),
            input: "ls".into(),
        };
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

    // ── Codex app-server JSON-RPC notification mapping ────────────────

    #[test]
    fn rpc_agent_message_delta_becomes_text() {
        let params = serde_json::json!({
            "delta": "Hello ",
            "itemId": "item_1",
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/agentMessage/delta", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Text { text } => assert_eq!(text, "Hello "),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn rpc_reasoning_text_delta_becomes_thinking() {
        let params = serde_json::json!({
            "delta": "Let me think",
            "itemId": "item_r",
            "contentIndex": 0,
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/reasoning/textDelta", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Thinking { text } => assert_eq!(text, "Let me think"),
            other => panic!("expected Thinking, got {other:?}"),
        }
    }

    #[test]
    fn rpc_reasoning_summary_text_delta_becomes_thinking() {
        let params = serde_json::json!({
            "delta": "Summary bits",
            "itemId": "item_r",
            "summaryIndex": 0,
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/reasoning/summaryTextDelta", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::Thinking { text } => assert_eq!(text, "Summary bits"),
            other => panic!("expected Thinking, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_started_command_execution_becomes_toolstart() {
        // Live app-server emits camelCase item types.
        let params = serde_json::json!({
            "item": {
                "id": "i1",
                "type": "commandExecution",
                "command": "ls -la",
            },
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/started", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::ToolStart { tool, input } => {
                assert_eq!(tool, "shell");
                assert_eq!(input, "ls -la");
            }
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_started_command_execution_snake_case_alias_still_works() {
        let params = serde_json::json!({
            "item": { "id": "i1", "type": "command_execution", "command": "ls" },
        });
        let items = process_codex_rpc_notification("item/started", &params);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn rpc_item_completed_command_execution_with_exit_code_is_error() {
        let params = serde_json::json!({
            "item": {
                "id": "i3",
                "type": "commandExecution",
                "aggregatedOutput": "bash: bad\n",
                "exitCode": 1,
            },
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::ToolResult { text, is_error } => {
                assert!(is_error);
                assert!(text.contains("bash"));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_completed_file_change_formats_changes() {
        // Live schema: `kind` is `PatchChangeKind`, an object discriminated
        // by `type`. The older string form is still accepted as a
        // transitional alias; the object form must also produce the right
        // tool (`Write` for "add", `Edit` for "update", `Delete`).
        let params = serde_json::json!({
            "item": {
                "id": "i4",
                "type": "fileChange",
                "changes": [{"path": "/tmp/x.rs", "kind": {"type": "add"}}],
                "status": "completed",
            },
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        assert_eq!(items.len(), 2);
        match &items[0] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Write"),
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_completed_file_change_kind_update_object_is_edit() {
        let params = serde_json::json!({
            "item": {
                "id": "i5",
                "type": "fileChange",
                "changes": [{"path": "/tmp/y.rs", "kind": {"type": "update"}}],
                "status": "completed",
            },
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        match &items[0] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Edit"),
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_completed_file_change_kind_delete_object_is_delete() {
        let params = serde_json::json!({
            "item": {
                "id": "i6",
                "type": "fileChange",
                "changes": [{"path": "/tmp/z.rs", "kind": {"type": "delete"}}],
                "status": "completed",
            },
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        match &items[0] {
            OutputItem::ToolStart { tool, .. } => assert_eq!(tool, "Delete"),
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_completed_agent_message_is_swallowed() {
        // `item/agentMessage/delta` already streams this text; re-emitting on
        // completion would render the same assistant reply twice.
        let params = serde_json::json!({
            "item": {
                "id": "a1",
                "type": "agentMessage",
                "text": "Hello world",
            },
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        assert!(items.is_empty(), "agentMessage must not double-emit");
    }

    #[test]
    fn rpc_item_plan_delta_streams_codex_plan_delta() {
        // Codex plan-mode emits `<proposed_plan>...</proposed_plan>` via a
        // dedicated `item/plan/delta` channel. The delta is routed into a
        // live plan viewer overlay, NOT the chat transcript, so the
        // authoritative completion text doesn't duplicate the stream.
        let params = serde_json::json!({
            "delta": "<proposed_plan>",
            "itemId": "p1",
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/plan/delta", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::CodexPlanDelta { item_id, delta } => {
                assert_eq!(item_id, "p1");
                assert_eq!(delta, "<proposed_plan>");
            }
            other => panic!("expected CodexPlanDelta, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_plan_delta_empty_is_swallowed() {
        let params = serde_json::json!({
            "delta": "",
            "itemId": "p1",
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/plan/delta", &params);
        assert!(items.is_empty());
    }

    #[test]
    fn rpc_item_completed_plan_emits_codex_plan_ready() {
        // The `plan` ThreadItem's `text` is the authoritative plan body;
        // the frontend uses it to finalize the live viewer (deltas may not
        // match concat per schema). The caller fills `filePath` after
        // persisting the markdown.
        let params = serde_json::json!({
            "item": {
                "id": "p1",
                "type": "plan",
                "text": "<proposed_plan>design it</proposed_plan>",
            },
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::CodexPlanReady { item_id, text, file_path } => {
                assert_eq!(item_id, "p1");
                assert!(text.contains("design it"));
                assert!(file_path.is_none(), "filePath is filled by the stream loop after writing");
            }
            other => panic!("expected CodexPlanReady, got {other:?}"),
        }
    }

    #[test]
    fn rpc_item_completed_plan_empty_text_is_swallowed() {
        let params = serde_json::json!({
            "item": {"id": "p1", "type": "plan", "text": ""},
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("item/completed", &params);
        assert!(items.is_empty());
    }

    #[test]
    fn persist_codex_plan_markdown_writes_under_verun_plans() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = persist_codex_plan_markdown(
            tmp.path(),
            "item_abcdef",
            "<proposed_plan>hello</proposed_plan>",
        )
        .expect("write plan");
        assert!(path.starts_with(tmp.path().join(".verun").join("plans")));
        assert!(path.extension().and_then(|e| e.to_str()) == Some("md"));
        let contents = std::fs::read_to_string(&path).expect("read back");
        assert!(contents.contains("hello"));
    }

    #[test]
    fn persist_codex_plan_if_ready_fills_file_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let item = OutputItem::CodexPlanReady {
            item_id: "item_xyz".into(),
            text: "body".into(),
            file_path: None,
        };
        match persist_codex_plan_if_ready(item, tmp.path()) {
            OutputItem::CodexPlanReady { file_path, .. } => {
                let path = file_path.expect("filePath populated");
                assert!(path.contains(".verun/plans/plan-"));
                assert!(std::path::Path::new(&path).exists());
            }
            other => panic!("expected CodexPlanReady, got {other:?}"),
        }
    }

    #[test]
    fn persist_codex_plan_if_ready_leaves_other_items_untouched() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let item = OutputItem::Text { text: "hi".into() };
        match persist_codex_plan_if_ready(item, tmp.path()) {
            OutputItem::Text { text } => assert_eq!(text, "hi"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn extract_codex_token_usage_reads_last_breakdown() {
        let params = serde_json::json!({
            "threadId": "t",
            "turnId": "u",
            "tokenUsage": {
                "last": {
                    "inputTokens": 120,
                    "outputTokens": 45,
                    "cachedInputTokens": 10,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 165,
                },
                "total": {
                    "inputTokens": 999,
                    "outputTokens": 999,
                    "cachedInputTokens": 999,
                    "reasoningOutputTokens": 999,
                    "totalTokens": 999,
                },
            },
        });
        let u = extract_codex_token_usage(&params).expect("usage");
        assert_eq!(u.input_tokens, 120);
        assert_eq!(u.output_tokens, 45);
        assert_eq!(u.cached_input_tokens, 10);
    }

    #[test]
    fn patch_turn_end_with_usage_fills_in_missing_fields() {
        let usage = Some(CodexTokenUsage {
            input_tokens: 120,
            output_tokens: 45,
            cached_input_tokens: 10,
        });
        let base = OutputItem::TurnEnd {
            status: "completed".into(),
            cost: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            error: None,
        };
        match patch_turn_end_with_usage(base, &usage) {
            OutputItem::TurnEnd {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                ..
            } => {
                assert_eq!(input_tokens, Some(120));
                assert_eq!(output_tokens, Some(45));
                assert_eq!(cache_read_tokens, Some(10));
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn patch_turn_end_preserves_non_turn_end_items() {
        let item = OutputItem::Text {
            text: "hi".into(),
        };
        match patch_turn_end_with_usage(item, &None) {
            OutputItem::Text { text } => assert_eq!(text, "hi"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn rpc_turn_plan_updated_becomes_plan_update() {
        let params = serde_json::json!({
            "explanation": "Proposed plan",
            "plan": [
                {"status": "pending", "step": "Read files"},
                {"status": "in_progress", "step": "Write tests"},
            ],
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("turn/plan/updated", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::PlanUpdate { items, explanation } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].status, "pending");
                assert_eq!(items[0].step, "Read files");
                assert_eq!(explanation.as_deref(), Some("Proposed plan"));
            }
            other => panic!("expected PlanUpdate, got {other:?}"),
        }
    }

    #[test]
    fn rpc_turn_diff_updated_becomes_diff_update() {
        let params = serde_json::json!({
            "diff": "--- a\n+++ b\n@@\n-x\n+y\n",
            "threadId": "t",
            "turnId": "u",
        });
        let items = process_codex_rpc_notification("turn/diff/updated", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::DiffUpdate { diff } => assert!(diff.contains("+y")),
            other => panic!("expected DiffUpdate, got {other:?}"),
        }
    }

    #[test]
    fn rpc_turn_completed_becomes_turn_end_with_usage() {
        let params = serde_json::json!({
            "threadId": "t",
            "turn": {
                "id": "u",
                "status": "completed",
                "items": [],
            },
        });
        let items = process_codex_rpc_notification("turn/completed", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::TurnEnd { status, .. } => assert_eq!(status, "completed"),
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn rpc_turn_completed_failed_becomes_error_status() {
        let params = serde_json::json!({
            "threadId": "t",
            "turn": {
                "id": "u",
                "status": "failed",
                "items": [],
                "error": {"message": "overloaded"},
            },
        });
        let items = process_codex_rpc_notification("turn/completed", &params);
        match &items[0] {
            OutputItem::TurnEnd { status, error, .. } => {
                assert_eq!(status, "error");
                assert_eq!(error.as_deref(), Some("overloaded"));
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn rpc_error_notification_becomes_error_message() {
        let params = serde_json::json!({
            "threadId": "t",
            "turnId": "u",
            "willRetry": false,
            "error": {"message": "unauthorized"},
        });
        let items = process_codex_rpc_notification("error", &params);
        assert_eq!(items.len(), 1);
        match &items[0] {
            OutputItem::ErrorMessage { message, .. } => assert!(message.contains("unauthorized")),
            other => panic!("expected ErrorMessage, got {other:?}"),
        }
    }

    #[test]
    fn rpc_lifecycle_notifications_are_ignored() {
        for m in [
            "thread/started",
            "turn/started",
            "thread/status/changed",
            "thread/closed",
            "thread/tokenUsage/updated",
            "item/commandExecution/outputDelta",
        ] {
            let items = process_codex_rpc_notification(m, &serde_json::json!({}));
            assert!(items.is_empty(), "{m} should be swallowed");
        }
    }

    #[test]
    fn codex_approval_entry_maps_exec_to_bash_tool() {
        let entry = build_codex_approval_entry(
            "session-1",
            "req-123",
            "execCommandApproval",
            &serde_json::json!({"command": ["rm", "-rf", "node_modules"]}),
        );
        assert_eq!(entry.request_id, "req-123");
        assert_eq!(entry.session_id, "session-1");
        assert_eq!(entry.tool_name, "Bash");
        assert_eq!(
            entry.tool_input,
            serde_json::json!({"command": ["rm", "-rf", "node_modules"]})
        );
    }

    #[test]
    fn codex_approval_entry_maps_patch_to_edit_tool() {
        let entry = build_codex_approval_entry(
            "s",
            "r",
            "applyPatchApproval",
            &serde_json::json!({"changes": {}}),
        );
        assert_eq!(entry.tool_name, "Edit");
    }

    #[test]
    fn codex_approval_entry_maps_item_command_execution_to_bash() {
        let entry = build_codex_approval_entry(
            "s",
            "r",
            "item/commandExecution/requestApproval",
            &serde_json::json!({}),
        );
        assert_eq!(entry.tool_name, "Bash");
    }

    #[test]
    fn codex_approval_entry_maps_item_file_change_to_edit() {
        let entry = build_codex_approval_entry(
            "s",
            "r",
            "item/fileChange/requestApproval",
            &serde_json::json!({}),
        );
        assert_eq!(entry.tool_name, "Edit");
    }

    #[test]
    fn encode_codex_approval_allow_maps_to_approved_for_exec() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "execCommandApproval",
            &serde_json::json!("srv-1"),
            &approval_response("allow"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"decision\":\"approved\""), "{s}");
        assert!(s.contains("\"id\":\"srv-1\""));
    }

    #[test]
    fn encode_codex_approval_deny_maps_to_denied_for_exec() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "applyPatchApproval",
            &serde_json::json!(42),
            &approval_response("deny"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"decision\":\"denied\""), "{s}");
    }

    #[test]
    fn encode_codex_approval_allow_maps_to_accept_for_item_method() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "item/fileChange/requestApproval",
            &serde_json::json!("x"),
            &approval_response("allow"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"decision\":\"accept\""), "{s}");
    }

    #[test]
    fn encode_codex_approval_permissions_deny_sends_empty_permissions() {
        // `item/permissions/requestApproval` expects `{permissions, scope}`,
        // not `{decision}`. Deny = empty permissions at turn scope.
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "item/permissions/requestApproval",
            &serde_json::json!("y"),
            &approval_response("deny"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(!s.contains("\"decision\""), "{s}");
        assert!(s.contains("\"permissions\":{}"), "{s}");
        assert!(s.contains("\"scope\":\"turn\""), "{s}");
    }

    #[test]
    fn encode_codex_approval_item_command_allow_maps_to_accept() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "item/commandExecution/requestApproval",
            &serde_json::json!("z"),
            &approval_response("allow"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"decision\":\"accept\""), "{s}");
    }

    #[test]
    fn encode_codex_approval_unknown_method_returns_none() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let out = encode_codex_approval_response(
            &*agent,
            "not/an/approval",
            &serde_json::json!(1),
            &approval_response("allow"),
        );
        assert!(out.is_none());
    }

    fn approval_response(behavior: &str) -> ApprovalResponse {
        ApprovalResponse {
            behavior: behavior.to_string(),
            updated_input: None,
            message: None,
        }
    }

    #[test]
    fn codex_approval_entry_maps_request_user_input_to_ask_user_question() {
        let entry = build_codex_approval_entry(
            "session-1",
            "req-42",
            "item/tool/requestUserInput",
            &serde_json::json!({
                "itemId": "it-1",
                "threadId": "t-1",
                "turnId": "tr-1",
                "questions": [
                    {
                        "id": "q1",
                        "question": "Pick a framework",
                        "header": "Frontend",
                        "options": [
                            { "label": "Solid", "description": "Fine-grained reactive" },
                            { "label": "React" },
                        ],
                    }
                ],
            }),
        );
        assert_eq!(entry.tool_name, "AskUserQuestion");
        let qs = entry
            .tool_input
            .get("questions")
            .and_then(|v| v.as_array())
            .expect("questions array");
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].get("question").and_then(|v| v.as_str()), Some("Pick a framework"));
        assert_eq!(qs[0].get("header").and_then(|v| v.as_str()), Some("Frontend"));
        assert_eq!(qs[0].get("multiSelect").and_then(|v| v.as_bool()), Some(false));
        let opts = qs[0].get("options").and_then(|v| v.as_array()).unwrap();
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0].get("label").and_then(|v| v.as_str()), Some("Solid"));
        assert_eq!(
            opts[0].get("description").and_then(|v| v.as_str()),
            Some("Fine-grained reactive"),
        );
        let ids = entry
            .tool_input
            .get("_codexQuestionIds")
            .and_then(|v| v.as_object())
            .unwrap();
        assert_eq!(
            ids.get("Pick a framework").and_then(|v| v.as_str()),
            Some("q1"),
        );
    }

    #[test]
    fn encode_codex_user_input_response_maps_answers_back_to_question_ids() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let response = ApprovalResponse {
            behavior: "allow".to_string(),
            updated_input: Some(serde_json::json!({
                "answers": { "Pick a framework": "Solid" },
                "_codexQuestionIds": { "Pick a framework": "q1" },
            })),
            message: None,
        };
        let bytes = encode_codex_approval_response(
            &*agent,
            "item/tool/requestUserInput",
            &serde_json::json!(7),
            &response,
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"id\":7"), "{s}");
        assert!(s.contains("\"q1\":{\"answers\":[\"Solid\"]}"), "{s}");
    }

    #[test]
    fn encode_codex_user_input_response_empty_when_no_answers() {
        let agent = crate::agent::AgentKind::Codex.implementation();
        let bytes = encode_codex_approval_response(
            &*agent,
            "item/tool/requestUserInput",
            &serde_json::json!("s"),
            &approval_response("deny"),
        )
        .expect("method recognised")
        .expect("encoder ok");
        let s = String::from_utf8(bytes).unwrap();
        // Empty map, not array — matches `Record<questionId, {answers}>` schema
        assert!(s.contains("\"answers\":{}"), "{s}");
    }
}
