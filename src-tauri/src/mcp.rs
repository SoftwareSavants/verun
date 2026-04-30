#![allow(dead_code)]

//! Verun MCP (Model Context Protocol) server.
//!
//! Exposes a curated subset of Verun's task/session/start-command surface
//! as MCP tools so that agents (Claude Code, etc.) running inside a Verun
//! task can read sibling tasks, spawn new ones, and control per-task dev
//! servers without going through bash.
//!
//! Architecture: this module is the in-process *host* (single source of
//! truth, lives inside the running Verun.app). A thin stdio relay binary
//! (added in a later slice) accepts the JSON-RPC stream from Claude Code
//! over stdio and forwards it to the host over a Unix socket; this module
//! implements `dispatch` which is the entry point either transport hits.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

use crate::db;

const PROTOCOL_VERSION: &str = "2025-11-25";
const SERVER_NAME: &str = "verun";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const DEFAULT_LIST_LIMIT: i64 = 50;
const MAX_LIST_LIMIT: i64 = 200;

const DEFAULT_TAIL_BYTES: i64 = 16 * 1024;
const MIN_TAIL_BYTES: i64 = 1024;
const MAX_TAIL_BYTES: i64 = 64 * 1024;

// JSON-RPC 2.0 standard error codes.
pub const E_PARSE_ERROR: i32 = -32700;
pub const E_METHOD_NOT_FOUND: i32 = -32601;
pub const E_INVALID_PARAMS: i32 = -32602;
pub const E_INTERNAL: i32 = -32603;

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

/// Per-call context. The transport layer fills in `caller_task_id` from the
/// `VERUN_TASK_ID` env var (stdio relay) or from request metadata so the
/// handler knows which task is "current" for default-scoped queries.
///
/// `actions` carries a sender for side-effect actions (send-message, spawn,
/// app-start/stop) that need access to Tauri-managed runtime state. Tools
/// that only read the DB don't need it; tools that need it return
/// `E_INTERNAL` when it's `None` (set up only in production wiring).
pub struct McpContext {
    pub pool: SqlitePool,
    pub caller_task_id: Option<String>,
    pub actions: Option<mpsc::Sender<McpAction>>,
}

/// Side-effect actions an MCP tool can ask the in-app worker to perform.
/// The reply oneshot carries the worker's response back to the tool handler
/// so the JSON-RPC reply can mirror the success/failure of the underlying
/// Verun command.
#[derive(Debug)]
pub enum McpAction {
    SendUserMessage {
        session_id: String,
        message: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SpawnTask {
        project_id: String,
        base_branch: Option<String>,
        agent_type: String,
        initial_message: Option<String>,
        reply: oneshot::Sender<Result<SpawnTaskOutcome, String>>,
    },
    AppStart {
        task_id: String,
        reply: oneshot::Sender<Result<AppStartOutcome, String>>,
    },
    AppStop {
        task_id: String,
        reply: oneshot::Sender<Result<AppStopOutcome, String>>,
    },
    AppLogs {
        task_id: String,
        tail_bytes: i64,
        reply: oneshot::Sender<Result<AppLogsOutcome, String>>,
    },
}

/// Result returned by the worker after a successful `SpawnTask`. Carries
/// just enough metadata for the tool handler to build a useful payload for
/// the calling agent without re-querying the DB.
#[derive(Debug, Clone)]
pub struct SpawnTaskOutcome {
    pub task_id: String,
    pub branch: String,
    pub session_id: String,
    pub agent_type: String,
    pub initial_message_delivered: bool,
}

#[derive(Debug, Clone)]
pub struct AppStartOutcome {
    pub task_id: String,
    pub terminal_id: String,
    pub command: String,
    pub already_running: bool,
}

#[derive(Debug, Clone)]
pub struct AppStopOutcome {
    pub task_id: String,
    pub stopped: bool,
    pub terminal_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppLogsOutcome {
    pub task_id: String,
    pub terminal_id: Option<String>,
    pub running: bool,
    pub output: String,
    pub bytes: i64,
}

pub async fn dispatch(ctx: &McpContext, req: JsonRpcRequest) -> JsonRpcResponse {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        "initialize" => Ok(initialize_result()),
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => handle_tools_call(ctx, req.params).await,
        "ping" => Ok(json!({})),
        other => Err(JsonRpcError {
            code: E_METHOD_NOT_FOUND,
            message: format!("Unknown method: {other}"),
        }),
    };

    match result {
        Ok(value) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(value),
            error: None,
        },
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(err),
        },
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
    })
}

fn tools_list_result() -> Value {
    json!({
        "tools": [
            tool_schema_list_tasks(),
            tool_schema_read_task_output(),
            tool_schema_send_message(),
            tool_schema_spawn_task(),
            tool_schema_app_start(),
            tool_schema_app_stop(),
            tool_schema_app_logs(),
        ]
    })
}

fn tool_schema_list_tasks() -> Value {
    json!({
        "name": "verun_list_tasks",
        "description": "List active (non-archived) Verun tasks. By default returns only tasks in the caller's current project so you can discover sibling agents working alongside you. Set all_projects=true to see every task across every project. Returns up to `limit` items (default 50, max 200) ordered newest first. If `truncated` is true in the response, more results exist - call again with `cursor` set to `next_cursor` to fetch the next page. Use the returned task_id with verun_read_task_output, verun_send_message, or verun_spawn_task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "all_projects": {
                    "type": "boolean",
                    "default": false,
                    "description": "If true, list tasks across every project. If false (default), only tasks in the caller's project."
                },
                "limit": {
                    "type": "integer",
                    "default": 50,
                    "minimum": 1,
                    "maximum": 200
                },
                "cursor": {
                    "type": "string",
                    "description": "Opaque pagination cursor from a previous response's next_cursor. Do not interpret or construct; pass through verbatim."
                }
            }
        }
    })
}

async fn handle_tools_call(ctx: &McpContext, params: Value) -> Result<Value, JsonRpcError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "tools/call: missing 'name'".into(),
        })?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let text = match name {
        "verun_list_tasks" => tool_list_tasks(ctx, arguments).await?,
        "verun_read_task_output" => tool_read_task_output(ctx, arguments).await?,
        "verun_send_message" => tool_send_message(ctx, arguments).await?,
        "verun_spawn_task" => tool_spawn_task(ctx, arguments).await?,
        "verun_app_start" => tool_app_start(ctx, arguments).await?,
        "verun_app_stop" => tool_app_stop(ctx, arguments).await?,
        "verun_app_logs" => tool_app_logs(ctx, arguments).await?,
        other => {
            return Err(JsonRpcError {
                code: E_METHOD_NOT_FOUND,
                message: format!("Unknown tool: {other}"),
            });
        }
    };

    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

async fn tool_list_tasks(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let all_projects = args
        .get("all_projects")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let cursor: Option<i64> = args
        .get("cursor")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let project_filter: Option<String> = if all_projects {
        None
    } else {
        let task_id = ctx.caller_task_id.as_deref().ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "Cannot resolve caller's project: VERUN_TASK_ID is not set in this MCP session. Pass all_projects=true to list tasks across every project.".into(),
        })?;
        let task = db::get_task(&ctx.pool, task_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!("Caller task '{task_id}' no longer exists. Pass all_projects=true to list tasks across every project."),
            })?;
        Some(task.project_id)
    };

    let rows = db::list_active_tasks(
        &ctx.pool,
        project_filter.as_deref(),
        limit + 1,
        cursor,
    )
    .await
    .map_err(internal)?;

    let truncated = rows.len() as i64 > limit;
    let visible: Vec<&db::ActiveTaskRow> = rows.iter().take(limit as usize).collect();

    let next_cursor = if truncated {
        visible.last().map(|r| r.created_at.to_string())
    } else {
        None
    };

    let items: Vec<Value> = visible
        .iter()
        .map(|r| {
            let display_name = r
                .task_name
                .clone()
                .unwrap_or_else(|| r.branch.clone());
            json!({
                "task_id": r.task_id,
                "name": display_name,
                "project": r.project_name,
                "branch": r.branch,
                "agent": r.agent_type,
                "created_at": r.created_at,
            })
        })
        .collect();

    let payload = json!({
        "items": items,
        "next_cursor": next_cursor,
        "truncated": truncated,
    });

    serde_json::to_string(&payload).map_err(internal)
}

fn tool_schema_read_task_output() -> Value {
    json!({
        "name": "verun_read_task_output",
        "description": "Read the most recent agent output from a sibling Verun task so you can see what another agent is working on or said. Returns the tail of the task's most recent session up to `tail_bytes` (default 16384, max 65536) in chronological order. Each line is the raw recorded output - some are plain agent text, some are JSON-encoded structured events (look for `\"type\":\"verun_items\"` and parse if you need structured access). If `more_available` is true, call again with `cursor` set to `next_cursor` to fetch older lines. Pass `session_id` only if you need a specific session; otherwise the most recent session is used.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Task ID returned by verun_list_tasks."
                },
                "session_id": {
                    "type": "string",
                    "description": "Optional. Specific session to read. Defaults to the task's most recent session."
                },
                "tail_bytes": {
                    "type": "integer",
                    "default": 16384,
                    "minimum": 1024,
                    "maximum": 65536
                },
                "cursor": {
                    "type": "string",
                    "description": "Opaque pagination cursor from a previous response's next_cursor (fetches older lines). Pass through verbatim."
                }
            },
            "required": ["task_id"]
        }
    })
}

async fn tool_read_task_output(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let task_id = args
        .get("task_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "verun_read_task_output: 'task_id' is required.".into(),
        })?;

    let task = db::get_task(&ctx.pool, task_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: format!(
                "Task '{task_id}' not found. Use verun_list_tasks to find valid IDs."
            ),
        })?;

    let session = if let Some(session_id) = args.get("session_id").and_then(|v| v.as_str()) {
        let s = db::get_session(&ctx.pool, session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!("Session '{session_id}' not found."),
            })?;
        if s.task_id != task.id {
            return Err(JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!(
                    "Session '{}' belongs to a different task than '{}'.",
                    s.id, task.id
                ),
            });
        }
        s
    } else {
        db::latest_session_for_task(&ctx.pool, task_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!("Task '{task_id}' has no sessions yet."),
            })?
    };

    let tail_bytes = args
        .get("tail_bytes")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .clamp(MIN_TAIL_BYTES, MAX_TAIL_BYTES);

    let cursor: Option<i64> = args
        .get("cursor")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let tail = db::tail_session_output(&ctx.pool, &session.id, tail_bytes, cursor)
        .await
        .map_err(internal)?;

    let display_name = task
        .name
        .clone()
        .unwrap_or_else(|| task.branch.clone());

    let payload = json!({
        "task_id": task.id,
        "task_name": display_name,
        "session_id": session.id,
        "agent": session.agent_type,
        "session_status": session.status,
        "lines": tail.lines.iter().map(|l| &l.line).collect::<Vec<_>>(),
        "bytes": tail.bytes,
        "more_available": tail.more_available,
        "next_cursor": tail.next_cursor.map(|c| c.to_string()),
    });

    serde_json::to_string(&payload).map_err(internal)
}

fn tool_schema_send_message() -> Value {
    json!({
        "name": "verun_send_message",
        "description": "Send a user-style message to a sibling Verun task's running agent. The text is delivered as if a human typed it into that task's chat - useful for coordinating with another agent (asking it to do something, sharing context, or following up after reviewing its output via verun_read_task_output). By default the message goes to the task's most recent session; pass `session_id` to target a specific one (must belong to the named task). Returns immediately after queueing; use verun_read_task_output to observe the agent's response.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "ID of the target task. Use verun_list_tasks to discover sibling task IDs."
                },
                "session_id": {
                    "type": "string",
                    "description": "Optional. Target a specific session within the task. Defaults to the latest session."
                },
                "message": {
                    "type": "string",
                    "description": "The message text to deliver. Must be non-empty."
                }
            },
            "required": ["task_id", "message"]
        }
    })
}

async fn tool_send_message(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let task_id = args
        .get("task_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "verun_send_message: 'task_id' is required.".into(),
        })?;

    let message = args
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "verun_send_message: 'message' is required.".into(),
        })?;
    if message.trim().is_empty() {
        return Err(JsonRpcError {
            code: E_INVALID_PARAMS,
            message: "verun_send_message: 'message' must not be empty.".into(),
        });
    }

    let task = db::get_task(&ctx.pool, task_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: format!(
                "Task '{task_id}' not found. Use verun_list_tasks to find valid IDs."
            ),
        })?;

    let session = if let Some(session_id) = args.get("session_id").and_then(|v| v.as_str()) {
        let s = db::get_session(&ctx.pool, session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!("Session '{session_id}' not found."),
            })?;
        if s.task_id != task.id {
            return Err(JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!(
                    "Session '{}' does not belong to task '{}'.",
                    s.id, task.id
                ),
            });
        }
        s
    } else {
        db::latest_session_for_task(&ctx.pool, task_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: format!(
                    "Task '{task_id}' has no sessions yet - send a message via the Verun UI first to create one."
                ),
            })?
    };

    let actions = ctx.actions.as_ref().ok_or_else(|| JsonRpcError {
        code: E_INTERNAL,
        message: "verun_send_message: server is not configured to perform side-effect actions.".into(),
    })?;

    let (reply_tx, reply_rx) = oneshot::channel();
    actions
        .send(McpAction::SendUserMessage {
            session_id: session.id.clone(),
            message: message.to_string(),
            reply: reply_tx,
        })
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_send_message: action queue closed: {e}"),
        })?;

    let result = reply_rx.await.map_err(|e| JsonRpcError {
        code: E_INTERNAL,
        message: format!("verun_send_message: worker dropped reply: {e}"),
    })?;
    result.map_err(|e| JsonRpcError {
        code: E_INTERNAL,
        message: e,
    })?;

    let display_name = task
        .name
        .clone()
        .unwrap_or_else(|| task.branch.clone());

    let payload = json!({
        "task_id": task.id,
        "task_name": display_name,
        "session_id": session.id,
        "delivered": true,
    });
    serde_json::to_string(&payload).map_err(internal)
}

fn tool_schema_spawn_task() -> Value {
    json!({
        "name": "verun_spawn_task",
        "description": "Create a new sibling Verun task with its own git worktree, branch, and first agent session. Useful for delegating work to a fresh agent without losing your current context. By default the new task lives in the caller's project, runs Claude, and branches off the project's default base branch. Pass `initial_message` to bootstrap the agent with a starting prompt - the new agent boots and immediately receives the message as if a human typed it. Returns the new task_id, generated branch name, session_id, and agent type so you can read its output via verun_read_task_output or follow up with verun_send_message.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Optional. Project to create the task in. Defaults to the caller's current project."
                },
                "base_branch": {
                    "type": "string",
                    "description": "Optional. Branch to fork from. Defaults to the project's configured base branch."
                },
                "agent_type": {
                    "type": "string",
                    "enum": ["claude", "codex", "cursor", "gemini", "opencode"],
                    "default": "claude",
                    "description": "Which agent CLI runs in the new session."
                },
                "initial_message": {
                    "type": "string",
                    "description": "Optional. If provided, this message is delivered to the new agent as soon as it boots. Must be non-empty if set."
                }
            }
        }
    })
}

async fn tool_spawn_task(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let project_id = match args.get("project_id").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => {
            let caller = ctx.caller_task_id.as_deref().ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: "verun_spawn_task: 'project_id' is required when there is no caller task to infer one from.".into(),
            })?;
            db::get_task(&ctx.pool, caller)
                .await
                .map_err(internal)?
                .ok_or_else(|| JsonRpcError {
                    code: E_INVALID_PARAMS,
                    message: format!("verun_spawn_task: caller task '{caller}' not found."),
                })?
                .project_id
        }
    };

    db::get_project(&ctx.pool, &project_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: format!("Project '{project_id}' not found."),
        })?;

    let agent_type = args
        .get("agent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("claude")
        .to_string();
    if !matches!(
        agent_type.as_str(),
        "claude" | "codex" | "cursor" | "gemini" | "opencode"
    ) {
        return Err(JsonRpcError {
            code: E_INVALID_PARAMS,
            message: format!(
                "verun_spawn_task: unknown agent_type '{agent_type}'. Valid values: claude, codex, cursor, gemini, opencode."
            ),
        });
    }

    let base_branch = args
        .get("base_branch")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let initial_message = match args.get("initial_message").and_then(|v| v.as_str()) {
        Some(m) if m.trim().is_empty() => {
            return Err(JsonRpcError {
                code: E_INVALID_PARAMS,
                message: "verun_spawn_task: 'initial_message' must not be empty when provided."
                    .into(),
            });
        }
        Some(m) => Some(m.to_string()),
        None => None,
    };

    let actions = ctx.actions.as_ref().ok_or_else(|| JsonRpcError {
        code: E_INTERNAL,
        message: "verun_spawn_task: server is not configured to perform side-effect actions."
            .into(),
    })?;

    let (reply_tx, reply_rx) = oneshot::channel();
    actions
        .send(McpAction::SpawnTask {
            project_id,
            base_branch,
            agent_type,
            initial_message,
            reply: reply_tx,
        })
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_spawn_task: action queue closed: {e}"),
        })?;

    let outcome = reply_rx
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_spawn_task: worker dropped reply: {e}"),
        })?
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: e,
        })?;

    let payload = json!({
        "task_id": outcome.task_id,
        "branch": outcome.branch,
        "session_id": outcome.session_id,
        "agent": outcome.agent_type,
        "initial_message_delivered": outcome.initial_message_delivered,
    });
    serde_json::to_string(&payload).map_err(internal)
}

fn tool_schema_app_start() -> Value {
    json!({
        "name": "verun_app_start",
        "description": "Start the project's configured start command (the 'Dev Server') for a Verun task in a fresh terminal. Idempotent: if a start command is already running for the task, returns its terminal_id with already_running=true instead of spawning a duplicate. The command runs inside the task's worktree with Verun's per-task env vars (VERUN_PORT_OFFSET, VERUN_TASK_ID, etc.). Use verun_app_logs to read the output and verun_app_stop to kill it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Optional. The task whose dev server to start. Defaults to the caller's task."
                }
            }
        }
    })
}

fn tool_schema_app_stop() -> Value {
    json!({
        "name": "verun_app_stop",
        "description": "Kill the running start command (Dev Server) for a Verun task, if any. Returns stopped=false (and a null terminal_id) when nothing was running, so the call is safe to make speculatively.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Optional. Defaults to the caller's task."
                }
            }
        }
    })
}

fn tool_schema_app_logs() -> Value {
    json!({
        "name": "verun_app_logs",
        "description": "Read the most recent stdout/stderr from a task's running start command (Dev Server). Returns the last `tail_bytes` of buffered terminal output (default 16 KiB, clamped 1 KiB-64 KiB). When the dev server isn't running, returns running=false with empty output. Useful for verifying the app booted, reading framework warnings, or grabbing a stack trace after a crash.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Optional. Defaults to the caller's task."
                },
                "tail_bytes": {
                    "type": "integer",
                    "default": 16384,
                    "minimum": 1024,
                    "maximum": 65536
                }
            }
        }
    })
}

async fn resolve_task_id(ctx: &McpContext, args: &Value) -> Result<String, JsonRpcError> {
    let raw = args
        .get("task_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let task_id = match raw {
        Some(t) => t,
        None => ctx
            .caller_task_id
            .clone()
            .ok_or_else(|| JsonRpcError {
                code: E_INVALID_PARAMS,
                message: "task_id is required when there is no caller task to infer one from."
                    .into(),
            })?,
    };
    db::get_task(&ctx.pool, &task_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| JsonRpcError {
            code: E_INVALID_PARAMS,
            message: format!(
                "Task '{task_id}' not found. Use verun_list_tasks to find valid IDs."
            ),
        })?;
    Ok(task_id)
}

async fn tool_app_start(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let task_id = resolve_task_id(ctx, &args).await?;

    let actions = ctx.actions.as_ref().ok_or_else(|| JsonRpcError {
        code: E_INTERNAL,
        message: "verun_app_start: server is not configured to perform side-effect actions."
            .into(),
    })?;

    let (reply_tx, reply_rx) = oneshot::channel();
    actions
        .send(McpAction::AppStart {
            task_id,
            reply: reply_tx,
        })
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_start: action queue closed: {e}"),
        })?;
    let outcome = reply_rx
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_start: worker dropped reply: {e}"),
        })?
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: e,
        })?;

    let payload = json!({
        "task_id": outcome.task_id,
        "terminal_id": outcome.terminal_id,
        "command": outcome.command,
        "already_running": outcome.already_running,
    });
    serde_json::to_string(&payload).map_err(internal)
}

async fn tool_app_stop(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let task_id = resolve_task_id(ctx, &args).await?;

    let actions = ctx.actions.as_ref().ok_or_else(|| JsonRpcError {
        code: E_INTERNAL,
        message: "verun_app_stop: server is not configured to perform side-effect actions."
            .into(),
    })?;

    let (reply_tx, reply_rx) = oneshot::channel();
    actions
        .send(McpAction::AppStop {
            task_id,
            reply: reply_tx,
        })
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_stop: action queue closed: {e}"),
        })?;
    let outcome = reply_rx
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_stop: worker dropped reply: {e}"),
        })?
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: e,
        })?;

    let payload = json!({
        "task_id": outcome.task_id,
        "stopped": outcome.stopped,
        "terminal_id": outcome.terminal_id,
    });
    serde_json::to_string(&payload).map_err(internal)
}

async fn tool_app_logs(ctx: &McpContext, args: Value) -> Result<String, JsonRpcError> {
    let task_id = resolve_task_id(ctx, &args).await?;
    let tail_bytes = args
        .get("tail_bytes")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .clamp(MIN_TAIL_BYTES, MAX_TAIL_BYTES);

    let actions = ctx.actions.as_ref().ok_or_else(|| JsonRpcError {
        code: E_INTERNAL,
        message: "verun_app_logs: server is not configured to perform side-effect actions."
            .into(),
    })?;

    let (reply_tx, reply_rx) = oneshot::channel();
    actions
        .send(McpAction::AppLogs {
            task_id,
            tail_bytes,
            reply: reply_tx,
        })
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_logs: action queue closed: {e}"),
        })?;
    let outcome = reply_rx
        .await
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: format!("verun_app_logs: worker dropped reply: {e}"),
        })?
        .map_err(|e| JsonRpcError {
            code: E_INTERNAL,
            message: e,
        })?;

    let payload = json!({
        "task_id": outcome.task_id,
        "terminal_id": outcome.terminal_id,
        "running": outcome.running,
        "output": outcome.output,
        "bytes": outcome.bytes,
    });
    serde_json::to_string(&payload).map_err(internal)
}

fn internal<E: std::fmt::Display>(e: E) -> JsonRpcError {
    JsonRpcError {
        code: E_INTERNAL,
        message: e.to_string(),
    }
}

/// First line on a new connection: identifies which task is calling. The
/// stdio relay reads `VERUN_TASK_ID` from its env and writes this frame on
/// the agent's behalf so the host knows whose project to scope to.
#[derive(Debug, Default, Deserialize)]
struct IdentityFrame {
    #[serde(default)]
    task_id: Option<String>,
}

/// Bind a Unix domain socket at `path` and serve MCP JSON-RPC. Each
/// connection sends one identity frame, then a stream of JSON-RPC requests.
/// Framing is ndjson - one JSON value per line, terminated by `\n`.
///
/// `actions` is an optional sender into the in-app worker that performs
/// side-effecting verbs (send-message, spawn-task, app start/stop). Pass
/// `None` for read-only deployments or when running tests that only
/// exercise the DB-backed read tools.
pub async fn serve_socket(
    pool: SqlitePool,
    path: PathBuf,
    actions: Option<mpsc::Sender<McpAction>>,
) -> std::io::Result<()> {
    // bind() fails if the path already exists; remove a stale socket from a
    // prior crash. The tempdir / app_data_dir already constrains the path.
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let pool = pool.clone();
                let actions = actions.clone();
                tokio::spawn(handle_connection(pool, stream, actions));
            }
            Err(e) => {
                eprintln!("[verun-mcp] accept error: {e}");
            }
        }
    }
}

/// In-app worker that pulls `McpAction`s off the channel and performs them
/// against Verun's Tauri-managed runtime state. Spawned by `lib.rs` once the
/// app's `manage()` calls have landed; the matching sender is plumbed into
/// `serve_socket` via `McpContext::actions`.
pub async fn run_action_worker(app: tauri::AppHandle, mut rx: mpsc::Receiver<McpAction>) {
    while let Some(action) = rx.recv().await {
        match action {
            McpAction::SendUserMessage {
                session_id,
                message,
                reply,
            } => {
                let result = perform_send_user_message(&app, &session_id, &message).await;
                let _ = reply.send(result);
            }
            McpAction::SpawnTask {
                project_id,
                base_branch,
                agent_type,
                initial_message,
                reply,
            } => {
                let result = perform_spawn_task(
                    &app,
                    project_id,
                    base_branch,
                    agent_type,
                    initial_message,
                )
                .await;
                let _ = reply.send(result);
            }
            McpAction::AppStart { task_id, reply } => {
                let result = perform_app_start(&app, &task_id).await;
                let _ = reply.send(result);
            }
            McpAction::AppStop { task_id, reply } => {
                let result = perform_app_stop(&app, &task_id).await;
                let _ = reply.send(result);
            }
            McpAction::AppLogs {
                task_id,
                tail_bytes,
                reply,
            } => {
                let result = perform_app_logs(&app, &task_id, tail_bytes).await;
                let _ = reply.send(result);
            }
        }
    }
}

async fn perform_send_user_message(
    app: &tauri::AppHandle,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let db_tx = app.state::<crate::db::DbWriteTx>();
    let active = app.state::<crate::task::ActiveMap>();
    let pending = app.state::<crate::task::PendingApprovals>();
    let pending_meta = app.state::<crate::task::PendingApprovalMeta>();
    let pending_ctrl = app.state::<crate::task::PendingControlResponses>();

    let session = db::get_session(pool.inner(), session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    let task = db::get_task(pool.inner(), &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;

    let (trust_result, repo_result) = tokio::join!(
        db::get_trust_level(pool.inner(), &session.task_id),
        db::get_repo_path_for_task(pool.inner(), &session.task_id),
    );
    let trust_level = crate::policy::TrustLevel::from_str(&trust_result?);
    let repo_path = repo_result?;

    crate::task::send_message(
        app.clone(),
        db_tx.inner(),
        active.inner().clone(),
        pending.inner().clone(),
        pending_meta.inner().clone(),
        pending_ctrl.inner().clone(),
        crate::task::SendMessageParams {
            session_id: session.id.clone(),
            task_id: session.task_id.clone(),
            project_id: task.project_id,
            worktree_path: task.worktree_path,
            repo_path,
            port_offset: task.port_offset,
            trust_level,
            message: message.to_string(),
            resume_session_id: session.resume_session_id,
            attachments: Vec::new(),
            model: None,
            plan_mode: false,
            thinking_mode: false,
            fast_mode: false,
            task_name: task.name,
            agent_type: session.agent_type,
            external: true,
        },
    )
    .await
}

async fn perform_spawn_task(
    app: &tauri::AppHandle,
    project_id: String,
    base_branch: Option<String>,
    agent_type: String,
    initial_message: Option<String>,
) -> Result<SpawnTaskOutcome, String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let db_tx = app.state::<crate::db::DbWriteTx>();
    let pty_map = app.state::<crate::pty::ActivePtyMap>();
    let hook_pty_map = app.state::<crate::task::HookPtyMap>();
    let setup_in_progress = app.state::<crate::task::SetupInProgress>();

    let project = db::get_project(pool.inner(), &project_id)
        .await?
        .ok_or_else(|| format!("Project {project_id} not found"))?;
    let port_offset = db::next_port_offset(pool.inner(), &project_id).await?;
    let branch = base_branch.unwrap_or(project.base_branch);
    // Hold on to the project's repo_path for the optional initial_message
    // path below - looking it up via `db::get_repo_path_for_task` would
    // race the InsertTask write that's still draining through the queue.
    let repo_path = project.repo_path.clone();

    let (task, session) = crate::task::create_task(
        app,
        db_tx.inner(),
        pty_map.inner(),
        hook_pty_map.inner(),
        setup_in_progress.inner(),
        crate::task::CreateTaskParams {
            project_id: project_id.clone(),
            repo_path: project.repo_path,
            base_branch: branch,
            setup_hook: project.setup_hook,
            port_offset,
            from_task_window: false,
            agent_type: agent_type.clone(),
            source_window: String::new(),
        },
    )
    .await?;

    let mut delivered = false;
    if let Some(msg) = initial_message {
        // Construct SendMessageParams from the in-memory task/session that
        // create_task just returned. Going through perform_send_user_message
        // would `db::get_session` / `db::get_repo_path_for_task` against rows
        // still queued on the async DB writer and fail with "no project found
        // for task". A fresh task has no trust_level row, so the default
        // ("normal") matches what get_trust_level would return anyway.
        let active = app.state::<crate::task::ActiveMap>();
        let pending = app.state::<crate::task::PendingApprovals>();
        let pending_meta = app.state::<crate::task::PendingApprovalMeta>();
        let pending_ctrl = app.state::<crate::task::PendingControlResponses>();
        let result = crate::task::send_message(
            app.clone(),
            db_tx.inner(),
            active.inner().clone(),
            pending.inner().clone(),
            pending_meta.inner().clone(),
            pending_ctrl.inner().clone(),
            crate::task::SendMessageParams {
                session_id: session.id.clone(),
                task_id: task.id.clone(),
                project_id: project_id.clone(),
                worktree_path: task.worktree_path.clone(),
                repo_path,
                port_offset,
                trust_level: crate::policy::TrustLevel::from_str("normal"),
                message: msg,
                resume_session_id: None,
                attachments: Vec::new(),
                model: None,
                plan_mode: false,
                thinking_mode: false,
                fast_mode: false,
                task_name: task.name.clone(),
                agent_type: agent_type.clone(),
                external: true,
            },
        )
        .await;
        match result {
            Ok(()) => delivered = true,
            Err(e) => eprintln!("[verun-mcp] spawn_task: initial_message failed: {e}"),
        }
    }

    Ok(SpawnTaskOutcome {
        task_id: task.id,
        branch: task.branch,
        session_id: session.id,
        agent_type,
        initial_message_delivered: delivered,
    })
}

async fn perform_app_start(
    app: &tauri::AppHandle,
    task_id: &str,
) -> Result<AppStartOutcome, String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let pty_map = app.state::<crate::pty::ActivePtyMap>();

    let task = db::get_task(pool.inner(), task_id)
        .await?
        .ok_or_else(|| format!("Task '{task_id}' not found."))?;
    let project = db::get_project(pool.inner(), &task.project_id)
        .await?
        .ok_or_else(|| format!("Project '{}' not found.", task.project_id))?;

    let command = project.start_command.trim().to_string();
    if command.is_empty() {
        return Err(format!(
            "Project '{}' has no start command configured. Set one in Project Settings -> Start Command.",
            task.project_id
        ));
    }

    if let Some(running) = find_start_command_pty(pty_map.inner(), task_id) {
        return Ok(AppStartOutcome {
            task_id: task.id,
            terminal_id: running,
            command,
            already_running: true,
        });
    }

    let repo_path = db::get_repo_path_for_task(pool.inner(), task_id).await?;
    let env_vars = crate::worktree::verun_env_vars(task.port_offset, &repo_path);
    let map = pty_map.inner().clone();
    let app_handle = app.clone();
    let worktree_path = task.worktree_path.clone();
    let task_id_owned = task.id.clone();
    let cmd_for_spawn = command.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::pty::spawn_pty(
            app_handle,
            map,
            task_id_owned,
            worktree_path,
            24,
            120,
            Some(cmd_for_spawn),
            env_vars,
            true,
            Some("Dev Server".into()),
            true,
            None,
        )
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;

    Ok(AppStartOutcome {
        task_id: task.id,
        terminal_id: result.terminal_id,
        command,
        already_running: false,
    })
}

async fn perform_app_stop(
    app: &tauri::AppHandle,
    task_id: &str,
) -> Result<AppStopOutcome, String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let pty_map = app.state::<crate::pty::ActivePtyMap>();

    db::get_task(pool.inner(), task_id)
        .await?
        .ok_or_else(|| format!("Task '{task_id}' not found."))?;

    let terminal_id = match find_start_command_pty(pty_map.inner(), task_id) {
        Some(id) => id,
        None => {
            return Ok(AppStopOutcome {
                task_id: task_id.to_string(),
                stopped: false,
                terminal_id: None,
            });
        }
    };

    let map = pty_map.inner().clone();
    let tid = terminal_id.clone();
    tokio::task::spawn_blocking(move || crate::pty::close_pty(&map, &tid))
        .await
        .map_err(|e| format!("Join error: {e}"))??;

    Ok(AppStopOutcome {
        task_id: task_id.to_string(),
        stopped: true,
        terminal_id: Some(terminal_id),
    })
}

async fn perform_app_logs(
    app: &tauri::AppHandle,
    task_id: &str,
    tail_bytes: i64,
) -> Result<AppLogsOutcome, String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let pty_map = app.state::<crate::pty::ActivePtyMap>();

    db::get_task(pool.inner(), task_id)
        .await?
        .ok_or_else(|| format!("Task '{task_id}' not found."))?;

    let entries = crate::pty::list_for_task(pty_map.inner(), task_id);
    let entry = entries.into_iter().find(|e| e.is_start_command);

    let entry = match entry {
        Some(e) => e,
        None => {
            return Ok(AppLogsOutcome {
                task_id: task_id.to_string(),
                terminal_id: None,
                running: false,
                output: String::new(),
                bytes: 0,
            });
        }
    };

    let buf = entry.buffered_output;
    let take = (tail_bytes as usize).min(buf.len());
    let start = buf.len().saturating_sub(take);
    let output = if let Some(slice_start) = nearest_char_boundary(&buf, start) {
        buf[slice_start..].to_string()
    } else {
        buf
    };
    let bytes = output.len() as i64;

    Ok(AppLogsOutcome {
        task_id: task_id.to_string(),
        terminal_id: Some(entry.terminal_id),
        running: true,
        output,
        bytes,
    })
}

/// Walk forward from `from` until we land on a UTF-8 char boundary so the
/// returned slice is valid str. Returns None only if `from` exceeds the
/// string length (caller passes a saturating sub so this shouldn't happen).
fn nearest_char_boundary(s: &str, from: usize) -> Option<usize> {
    if from > s.len() {
        return None;
    }
    let mut i = from;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    Some(i)
}

fn find_start_command_pty(map: &crate::pty::ActivePtyMap, task_id: &str) -> Option<String> {
    map.iter()
        .find(|e| e.value().task_id == task_id && e.value().is_start_command)
        .map(|e| e.key().clone())
}

/// Write `<worktree>/.mcp.json` so Claude Code launches our relay as the
/// `verun` MCP server with the right env vars baked in. If the file
/// already exists (e.g. the project root commits one), parse + merge so
/// pre-existing servers survive; only the `verun` entry is overwritten.
pub fn write_mcp_config(
    worktree_path: &Path,
    task_id: &str,
    socket_path: &Path,
    relay_binary: &Path,
) -> std::io::Result<()> {
    let path = worktree_path.join(".mcp.json");
    let mut root: Value = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }

    let obj = root.as_object_mut().expect("root is object");
    let servers = obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers.as_object_mut().expect("servers is object").insert(
        "verun".to_string(),
        json!({
            "command": relay_binary.to_string_lossy(),
            "args": [],
            "env": {
                "VERUN_TASK_ID": task_id,
                "VERUN_MCP_SOCKET": socket_path.to_string_lossy(),
            }
        }),
    );

    let mut pretty = serde_json::to_string_pretty(&root).map_err(std::io::Error::other)?;
    pretty.push('\n');
    std::fs::write(&path, pretty)?;

    // Pre-approve our server in `.claude/settings.local.json` so Claude Code
    // doesn't prompt for trust on first launch. Best-effort: failure here
    // just means the user gets a one-time approval prompt.
    let _ = pre_approve_verun_in_claude_settings(worktree_path);

    // Hide our generated files from `git status` for this worktree by
    // appending to .git/info/exclude. No-op if the project already commits
    // them (gitignore rules don't apply to tracked files). Best-effort: a
    // missing or unwritable git dir shouldn't fail task creation.
    let _ = ensure_mcp_excluded(worktree_path);
    Ok(())
}

/// Add `verun` to `.claude/settings.local.json::enabledMcpjsonServers` so
/// Claude Code auto-trusts it. Project-scope `.mcp.json` servers default
/// to untrusted; pre-approving here lets new tasks "just work" without a
/// per-task user gesture. Merges into an existing settings file (and
/// recovers gracefully from garbage).
fn pre_approve_verun_in_claude_settings(worktree_path: &Path) -> std::io::Result<()> {
    let dir = worktree_path.join(".claude");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("settings.local.json");

    let mut root: Value = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("root is object");

    let entry = obj
        .entry("enabledMcpjsonServers".to_string())
        .or_insert_with(|| json!([]));
    if !entry.is_array() {
        *entry = json!([]);
    }
    let arr = entry.as_array_mut().expect("entry is array");
    if !arr.iter().any(|v| v.as_str() == Some("verun")) {
        arr.push(json!("verun"));
    }

    let mut pretty = serde_json::to_string_pretty(&root).map_err(std::io::Error::other)?;
    pretty.push('\n');
    std::fs::write(&path, pretty)
}

/// Idempotently add `.mcp.json` to the repo's `.git/info/exclude` so our
/// injected file doesn't pollute the user's `git status`. `info/exclude`
/// lives in the *common* git dir - per-worktree `info/` directories are
/// not consulted by git for ignore rules - so for a linked worktree we
/// walk from `<main>/.git/worktrees/<n>` back up to `<main>/.git`.
fn ensure_mcp_excluded(worktree_path: &Path) -> std::io::Result<()> {
    let git_path = worktree_path.join(".git");
    if !git_path.exists() {
        return Ok(());
    }
    let linked_git_dir = if git_path.is_file() {
        let contents = std::fs::read_to_string(&git_path)?;
        let line = contents
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))
            .ok_or_else(|| std::io::Error::other("gitfile has no gitdir line"))?;
        let raw = PathBuf::from(line.trim());
        if raw.is_absolute() {
            raw
        } else {
            worktree_path.join(raw)
        }
    } else {
        git_path
    };

    // For a linked worktree, walk `<main>/.git/worktrees/<name>` back up to
    // `<main>/.git`. For a regular checkout, `linked_git_dir` already is the
    // common dir.
    let common_git_dir = linked_git_dir
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "worktrees"))
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .unwrap_or(linked_git_dir);

    let info_dir = common_git_dir.join("info");
    std::fs::create_dir_all(&info_dir)?;
    let exclude_path = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let want = [".mcp.json", ".claude/settings.local.json"];
    let mut content = existing.clone();
    let mut changed = false;
    for entry in want {
        if existing.lines().any(|l| l.trim() == entry) {
            continue;
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(entry);
        content.push('\n');
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    std::fs::write(&exclude_path, content)
}

/// Canonical Unix socket path for the in-app MCP host. macOS caps
/// `sockaddr_un.sun_path` at 104 bytes, so the obvious choice
/// (`<app_data>/mcp.sock`) blows past the limit on the default install
/// (`~/Library/Application Support/com.softwaresavants.verun.dev.<branch>/`
/// alone is ~98 chars). Hash the app data dir, drop the result in
/// `$TMPDIR`, and pass that through `VERUN_MCP_SOCKET` so the host and
/// relay agree without depending on the long path.
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(app_data_dir.to_string_lossy().as_bytes());
    let short = format!("{hash:x}");
    std::env::temp_dir().join(format!("verun-{}.sock", &short[..12]))
}

/// Resolve the relay binary path: sibling of the running executable. In
/// dev that's `target/debug/verun-mcp-relay`; in the bundled .app it's
/// `Contents/MacOS/verun-mcp-relay` (must be packaged alongside). On
/// Windows we look for `verun-mcp-relay.exe`.
pub fn relay_binary_path() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("current_exe has no parent"))?;
    let name = if cfg!(windows) {
        "verun-mcp-relay.exe"
    } else {
        "verun-mcp-relay"
    };
    Ok(dir.join(name))
}

/// stdio<->Unix-socket relay launched per Claude Code session.
/// Connects to `socket_path`, writes the identity frame derived from
/// `task_id`, then bidirectionally pipes ndjson between the caller's
/// `stdin`/`stdout` and the host. Returns once either direction closes.
pub async fn run_relay<R, W>(
    socket_path: PathBuf,
    task_id: Option<String>,
    mut stdin: R,
    mut stdout: W,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let stream = UnixStream::connect(&socket_path).await?;
    let (mut sock_rx, mut sock_tx) = stream.into_split();

    let identity = json!({ "task_id": task_id });
    let mut frame = serde_json::to_vec(&identity).map_err(std::io::Error::other)?;
    frame.push(b'\n');
    sock_tx.write_all(&frame).await?;

    // When stdin EOFs we half-close the socket's write side; the server then
    // sees EOF on its read half, finishes any in-flight response, and closes
    // its side. That closes our `sock_rx` and the reader future returns.
    // Using `join!` (not `select!`) ensures we drain late responses instead
    // of cancelling them when stdin happens to EOF first.
    let writer = async move {
        let _ = tokio::io::copy(&mut stdin, &mut sock_tx).await;
        let _ = sock_tx.shutdown().await;
    };
    let reader = async move {
        let _ = tokio::io::copy(&mut sock_rx, &mut stdout).await;
    };
    tokio::join!(writer, reader);
    Ok(())
}

async fn handle_connection(
    pool: SqlitePool,
    stream: UnixStream,
    actions: Option<mpsc::Sender<McpAction>>,
) {
    let (rx, mut tx) = stream.into_split();
    let mut reader = BufReader::new(rx);
    let mut line = String::new();

    let n = match reader.read_line(&mut line).await {
        Ok(n) => n,
        Err(_) => return,
    };
    if n == 0 {
        return;
    }
    let identity: IdentityFrame = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return,
    };

    let ctx = McpContext {
        pool,
        caller_task_id: identity.task_id,
        actions,
    };

    loop {
        line.clear();
        let n = match reader.read_line(&mut line).await {
            Ok(n) => n,
            Err(_) => return,
        };
        if n == 0 {
            return;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(req) => dispatch(&ctx, req).await,
            Err(e) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: None,
                result: None,
                error: Some(JsonRpcError {
                    code: E_PARSE_ERROR,
                    message: format!("Parse error: {e}"),
                }),
            },
        };
        let mut payload = match serde_json::to_vec(&response) {
            Ok(p) => p,
            Err(_) => return,
        };
        payload.push(b'\n');
        if tx.write_all(&payload).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations, process_write, DbWrite, Project, Session, Task};

    async fn pool_with_schema() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for m in migrations() {
            sqlx::query(m.sql).execute(&pool).await.unwrap();
        }
        pool
    }

    fn project(id: &str, name: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            repo_path: format!("/tmp/{id}"),
            base_branch: "main".into(),
            setup_hook: String::new(),
            destroy_hook: String::new(),
            start_command: String::new(),
            auto_start: false,
            created_at: 1000,
            default_agent_type: "claude".into(),
        }
    }

    fn session(id: &str, task_id: &str, started_at: i64) -> Session {
        Session {
            id: id.into(),
            task_id: task_id.into(),
            name: None,
            resume_session_id: None,
            status: "running".into(),
            started_at,
            ended_at: None,
            total_cost: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            parent_session_id: None,
            forked_at_message_uuid: None,
            agent_type: "claude".into(),
            model: None,
            closed_at: None,
        }
    }

    async fn insert_output(pool: &SqlitePool, session_id: &str, lines: &[&str]) {
        let lines: Vec<(String, i64)> =
            lines.iter().map(|l| ((*l).to_string(), 1000)).collect();
        process_write(
            pool,
            DbWrite::InsertOutputLines {
                session_id: session_id.into(),
                lines,
            },
        )
        .await
        .unwrap();
    }

    fn task(id: &str, project_id: &str, branch: &str, created_at: i64) -> Task {
        Task {
            id: id.into(),
            project_id: project_id.into(),
            name: None,
            worktree_path: format!("/tmp/{project_id}/.verun/worktrees/{branch}"),
            branch: branch.into(),
            created_at,
            merge_base_sha: None,
            port_offset: 0,
            archived: false,
            archived_at: None,
            last_commit_message: None,
            parent_task_id: None,
            agent_type: "claude".into(),
            last_pushed_sha: None,
        }
    }

    fn call_list_tasks(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_list_tasks", "arguments": args }),
        }
    }

    fn extract_payload(resp: &JsonRpcResponse) -> Value {
        let result = resp.result.as_ref().expect("expected success result");
        let text = result["content"][0]["text"]
            .as_str()
            .expect("content[0].text not a string");
        serde_json::from_str(text).expect("text is not valid JSON")
    }

    #[tokio::test]
    async fn list_tasks_default_scopes_to_callers_project() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-b", "p-1", "beta", 2000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-c", "p-2", "gamma", 3000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };

        let resp = dispatch(&ctx, call_list_tasks(json!({}))).await;
        let payload = extract_payload(&resp);

        let items = payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "should only see p-1 tasks");
        let ids: Vec<&str> = items
            .iter()
            .map(|i| i["task_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["t-b", "t-a"]);
        assert_eq!(items[0]["project"], "App One");
        assert_eq!(items[0]["name"], "beta"); // falls back to branch when name is None
        assert_eq!(payload["truncated"], false);
    }

    #[tokio::test]
    async fn list_tasks_all_projects_returns_everything() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-c", "p-2", "gamma", 3000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };

        let resp = dispatch(&ctx, call_list_tasks(json!({ "all_projects": true }))).await;
        let payload = extract_payload(&resp);
        assert_eq!(payload["items"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn list_tasks_paginates_with_cursor_and_signals_truncation() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        for (id, branch, ts) in [
            ("t-1", "one", 1000),
            ("t-2", "two", 2000),
            ("t-3", "three", 3000),
        ] {
            process_write(&pool, DbWrite::InsertTask(task(id, "p-1", branch, ts)))
                .await
                .unwrap();
        }

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-1".into()),
            actions: None,
        };

        let resp1 = dispatch(&ctx, call_list_tasks(json!({ "limit": 2 }))).await;
        let p1 = extract_payload(&resp1);
        assert_eq!(p1["items"].as_array().unwrap().len(), 2);
        assert_eq!(p1["truncated"], true);
        let cursor = p1["next_cursor"].as_str().unwrap().to_string();
        assert_eq!(cursor, "2000");

        let resp2 = dispatch(
            &ctx,
            call_list_tasks(json!({ "limit": 2, "cursor": cursor })),
        )
        .await;
        let p2 = extract_payload(&resp2);
        let items = p2["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["task_id"], "t-1");
        assert_eq!(p2["truncated"], false);
        assert!(p2["next_cursor"].is_null());
    }

    #[tokio::test]
    async fn list_tasks_without_caller_and_default_scope_returns_helpful_error() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };

        let resp = dispatch(&ctx, call_list_tasks(json!({}))).await;
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.contains("all_projects=true"),
            "error message should suggest all_projects=true: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn unknown_tool_returns_method_not_found() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_does_not_exist", "arguments": {} }),
        };
        let resp = dispatch(&ctx, req).await;
        assert!(resp.result.is_none());
        assert_eq!(resp.error.unwrap().code, E_METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn initialize_advertises_protocol_and_server_info() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "initialize".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let result = resp.result.unwrap();
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
    }

    #[tokio::test]
    async fn ping_returns_empty_object_result() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(7)),
            method: "ping".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        assert_eq!(resp.id, Some(json!(7)));
        assert_eq!(resp.result.unwrap(), json!({}));
    }

    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "resources/list".into(), // not implemented
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_METHOD_NOT_FOUND);
        assert!(err.message.contains("resources/list"));
    }

    #[tokio::test]
    async fn tools_call_without_name_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "arguments": {} }), // no "name"
        };
        let resp = dispatch(&ctx, req).await;
        assert_eq!(resp.error.unwrap().code, E_INVALID_PARAMS);
    }

    #[tokio::test]
    async fn tools_call_without_arguments_defaults_to_empty_args() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        // Note: no "arguments" field at all - exercises the unwrap_or_else fallback
        // and the all_projects=false default in tool_list_tasks.
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_list_tasks" }),
        };
        let resp = dispatch(&ctx, req).await;
        let payload = extract_payload(&resp);
        assert_eq!(payload["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn list_tasks_caller_task_missing_returns_helpful_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-ghost".into()),
            actions: None,
        };
        let resp = dispatch(&ctx, call_list_tasks(json!({}))).await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.contains("t-ghost"),
            "error should name the missing task: {}",
            err.message
        );
        assert!(err.message.contains("all_projects=true"));
    }

    #[tokio::test]
    async fn list_tasks_clamps_limit_below_one_and_above_max() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        for (id, branch, ts) in [("t-1", "one", 1000), ("t-2", "two", 2000)] {
            process_write(&pool, DbWrite::InsertTask(task(id, "p-1", branch, ts)))
                .await
                .unwrap();
        }

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-1".into()),
            actions: None,
        };

        // limit=0 clamps to 1
        let resp = dispatch(&ctx, call_list_tasks(json!({ "limit": 0 }))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["items"].as_array().unwrap().len(), 1);
        assert_eq!(p["truncated"], true); // there's another task

        // limit way above MAX_LIST_LIMIT clamps but still works
        let resp = dispatch(&ctx, call_list_tasks(json!({ "limit": 999_999 }))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["items"].as_array().unwrap().len(), 2);
        assert_eq!(p["truncated"], false);
    }

    #[tokio::test]
    async fn list_tasks_silently_ignores_unparseable_cursor() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_list_tasks(json!({ "cursor": "not-a-number" })),
        )
        .await;
        let p = extract_payload(&resp);
        // Garbage cursor is treated as "no cursor" - we get the full result rather
        // than failing the whole request.
        assert_eq!(p["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn list_tasks_prefers_task_name_over_branch_when_set() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        let mut t = task("t-a", "p-1", "alpha-branch", 1000);
        t.name = Some("Fix Auth Bug".into());
        process_write(&pool, DbWrite::InsertTask(t)).await.unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(&ctx, call_list_tasks(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["items"][0]["name"], "Fix Auth Bug");
        assert_eq!(p["items"][0]["branch"], "alpha-branch");
    }

    #[tokio::test]
    async fn smoke_typical_mcp_session_prints_full_protocol_trace() {
        // This test doubles as a manual demo: run with `cargo test smoke_typical
        // -- --nocapture` to see exactly what an MCP client would see going
        // through initialize -> tools/list -> tools/call.
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "Verun")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "fragile-stalestate-29", 1000)))
            .await
            .unwrap();
        let mut t_named = task("t-b", "p-1", "frosty-bagel-42", 2000);
        t_named.name = Some("Add MCP server".into());
        process_write(&pool, DbWrite::InsertTask(t_named)).await.unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };

        for (label, method, params) in [
            ("initialize", "initialize", json!({})),
            ("tools/list", "tools/list", json!({})),
            (
                "tools/call verun_list_tasks",
                "tools/call",
                json!({ "name": "verun_list_tasks", "arguments": {} }),
            ),
        ] {
            let req = JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: Some(json!(1)),
                method: method.into(),
                params,
            };
            let resp = dispatch(&ctx, req).await;
            let resp_json = serde_json::to_string_pretty(&resp).unwrap();
            eprintln!("\n--- {label} ---\n{resp_json}");
            assert!(resp.error.is_none(), "{label} should succeed");
        }
    }

    #[tokio::test]
    async fn tools_list_includes_verun_list_tasks() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let tools = resp.result.unwrap()["tools"].as_array().cloned().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "verun_list_tasks"));
    }

    async fn wait_for_socket(path: &std::path::Path) {
        for _ in 0..100 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("socket {path:?} never bound");
    }

    async fn read_json_line(
        reader: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
    ) -> Value {
        let mut buf = String::new();
        let n = reader.read_line(&mut buf).await.unwrap();
        assert!(n > 0, "expected a response line, got EOF");
        serde_json::from_str(&buf).unwrap()
    }

    #[tokio::test]
    async fn socket_handshake_then_initialize_returns_protocol_version() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");

        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"{}\n").await.unwrap();
        tx.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
            .await
            .unwrap();

        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(resp["id"], 1);

        server.abort();
    }

    #[tokio::test]
    async fn socket_identity_scopes_list_tasks_to_callers_project() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-c", "p-2", "gamma", 2000)))
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"{\"task_id\":\"t-a\"}\n").await.unwrap();
        tx.write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\
              \"params\":{\"name\":\"verun_list_tasks\",\"arguments\":{}}}\n",
        )
        .await
        .unwrap();

        let resp = read_json_line(&mut reader).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["items"].as_array().unwrap().len(), 1);
        assert_eq!(payload["items"][0]["task_id"], "t-a");

        server.abort();
    }

    #[tokio::test]
    async fn socket_anonymous_identity_errors_on_default_scope_but_allows_all_projects() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"{}\n").await.unwrap(); // anonymous identity

        // Default scope should fail with helpful guidance.
        tx.write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\
              \"params\":{\"name\":\"verun_list_tasks\",\"arguments\":{}}}\n",
        )
        .await
        .unwrap();
        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["error"]["code"], E_INVALID_PARAMS);
        assert!(resp["error"]["message"]
            .as_str()
            .unwrap()
            .contains("all_projects=true"));

        // Same connection: all_projects=true succeeds.
        tx.write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\
              \"params\":{\"name\":\"verun_list_tasks\",\"arguments\":{\"all_projects\":true}}}\n",
        )
        .await
        .unwrap();
        let resp = read_json_line(&mut reader).await;
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["items"].as_array().unwrap().len(), 1);

        server.abort();
    }

    #[tokio::test]
    async fn socket_malformed_json_returns_parse_error_then_continues() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"{}\n").await.unwrap();
        tx.write_all(b"this is not json\n").await.unwrap();
        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["error"]["code"], E_PARSE_ERROR);
        assert!(resp["id"].is_null());

        // Connection survives the parse error.
        tx.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["id"], 7);
        assert_eq!(resp["result"], json!({}));

        server.abort();
    }

    #[tokio::test]
    async fn socket_blank_lines_between_requests_are_ignored() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"{}\n").await.unwrap();
        tx.write_all(b"\n\n").await.unwrap(); // empty heartbeat lines
        tx.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
            .await
            .unwrap();

        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["id"], 3);
        assert_eq!(resp["result"], json!({}));

        server.abort();
    }

    #[tokio::test]
    async fn socket_invalid_identity_frame_drops_connection() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);

        tx.write_all(b"not json at all\n").await.unwrap();
        // Server should drop the connection - read_line returns 0 bytes.
        let mut buf = String::new();
        let n = reader.read_line(&mut buf).await.unwrap();
        assert_eq!(n, 0, "expected EOF after invalid identity frame, got {buf:?}");

        server.abort();
    }

    #[tokio::test]
    async fn socket_immediate_eof_during_identity_does_not_panic() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        // Connect then immediately close before sending anything.
        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        drop(stream);

        // Server should still accept new connections after this.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let (rx, mut tx) = stream.into_split();
        let mut reader = BufReader::new(rx);
        tx.write_all(b"{}\n").await.unwrap();
        tx.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let resp = read_json_line(&mut reader).await;
        assert_eq!(resp["id"], 1);

        server.abort();
    }

    #[test]
    fn write_mcp_config_creates_fresh_file_with_verun_entry() {
        let dir = tempfile::tempdir().unwrap();
        let socket = std::path::Path::new("/tmp/v.sock");
        let relay = std::path::Path::new("/usr/local/bin/verun-mcp-relay");
        write_mcp_config(dir.path(), "task-42", socket, relay).unwrap();

        let path = dir.path().join(".mcp.json");
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        let server = &v["mcpServers"]["verun"];
        assert_eq!(server["command"], "/usr/local/bin/verun-mcp-relay");
        assert_eq!(server["args"], json!([]));
        assert_eq!(server["env"]["VERUN_TASK_ID"], "task-42");
        assert_eq!(server["env"]["VERUN_MCP_SOCKET"], "/tmp/v.sock");
        assert!(raw.ends_with('\n'), "file should end with newline");
    }

    #[test]
    fn write_mcp_config_preserves_other_servers_in_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        std::fs::write(
            &path,
            r#"{
  "mcpServers": {
    "context7": { "command": "/opt/context7", "args": [] }
  }
}"#,
        )
        .unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["context7"]["command"], "/opt/context7");
        assert_eq!(v["mcpServers"]["verun"]["command"], "/relay");
        assert_eq!(v["mcpServers"]["verun"]["env"]["VERUN_TASK_ID"], "t-1");
    }

    #[test]
    fn write_mcp_config_overwrites_existing_verun_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        std::fs::write(
            &path,
            r#"{
  "mcpServers": {
    "verun": { "command": "/old/path", "args": [], "env": { "VERUN_TASK_ID": "old" } }
  }
}"#,
        )
        .unwrap();

        write_mcp_config(
            dir.path(),
            "new-task",
            std::path::Path::new("/new-sock"),
            std::path::Path::new("/new-relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["verun"]["command"], "/new-relay");
        assert_eq!(v["mcpServers"]["verun"]["env"]["VERUN_TASK_ID"], "new-task");
        assert_eq!(
            v["mcpServers"]["verun"]["env"]["VERUN_MCP_SOCKET"],
            "/new-sock"
        );
    }

    #[test]
    fn write_mcp_config_recovers_when_existing_file_is_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        std::fs::write(&path, "not json at all{{").unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["verun"]["command"], "/relay");
    }

    #[test]
    fn write_mcp_config_recovers_when_root_is_array_not_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        std::fs::write(&path, r#"["not", "an", "object"]"#).unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["verun"]["command"], "/relay");
    }

    #[test]
    fn write_mcp_config_recovers_when_mcpservers_field_is_not_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        std::fs::write(&path, r#"{"mcpServers": "broken"}"#).unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["verun"]["command"], "/relay");
    }

    #[test]
    fn write_mcp_config_appends_to_git_info_exclude_for_dir_gitdir() {
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let exclude = std::fs::read_to_string(info.join("exclude")).unwrap();
        assert!(exclude.lines().any(|l| l.trim() == ".mcp.json"));
    }

    #[test]
    fn write_mcp_config_appends_to_common_git_info_exclude_for_gitfile_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let main_repo = dir.path().join("main");
        let worktree = dir.path().join("wt");
        let worktree_gitdir = main_repo.join(".git/worktrees/wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&worktree_gitdir).unwrap();
        // Linked worktrees use .git as a *file* with `gitdir: <path>`.
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", worktree_gitdir.display()),
        )
        .unwrap();

        write_mcp_config(
            &worktree,
            "t-2",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        // Git only consults info/exclude in the *common* git dir, not the
        // per-worktree one - so we must write to <main>/.git/info/exclude.
        let common_exclude =
            std::fs::read_to_string(main_repo.join(".git/info/exclude")).unwrap();
        assert!(common_exclude.lines().any(|l| l.trim() == ".mcp.json"));
        // Per-worktree info/ should NOT have been used.
        assert!(!worktree_gitdir.join("info/exclude").exists());
    }

    #[test]
    fn write_mcp_config_does_not_duplicate_exclude_entry() {
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), "# user notes\n.mcp.json\n").unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let exclude = std::fs::read_to_string(info.join("exclude")).unwrap();
        let count = exclude.lines().filter(|l| l.trim() == ".mcp.json").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn write_mcp_config_no_op_when_no_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        // No .git inside the worktree.
        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();
        // .mcp.json was still written successfully.
        assert!(dir.path().join(".mcp.json").exists());
    }

    #[test]
    fn write_mcp_config_pre_approves_verun_in_claude_settings() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();
        let settings_path = dir.path().join(".claude/settings.local.json");
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
        let enabled = v["enabledMcpjsonServers"].as_array().unwrap();
        assert!(enabled.iter().any(|s| s.as_str() == Some("verun")));
    }

    #[test]
    fn write_mcp_config_merges_into_existing_claude_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&settings_dir).unwrap();
        // User already has settings with another enabled server + an unrelated
        // top-level field; both must survive.
        std::fs::write(
            settings_dir.join("settings.local.json"),
            r#"{"enabledMcpjsonServers":["other"],"theme":"dark"}"#,
        )
        .unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(settings_dir.join("settings.local.json")).unwrap(),
        )
        .unwrap();
        let enabled = v["enabledMcpjsonServers"].as_array().unwrap();
        let names: Vec<&str> = enabled.iter().filter_map(|s| s.as_str()).collect();
        assert!(names.contains(&"other"));
        assert!(names.contains(&"verun"));
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn write_mcp_config_does_not_duplicate_verun_in_claude_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&settings_dir).unwrap();
        std::fs::write(
            settings_dir.join("settings.local.json"),
            r#"{"enabledMcpjsonServers":["verun"]}"#,
        )
        .unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(settings_dir.join("settings.local.json")).unwrap(),
        )
        .unwrap();
        let enabled = v["enabledMcpjsonServers"].as_array().unwrap();
        let count = enabled
            .iter()
            .filter(|s| s.as_str() == Some("verun"))
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn write_mcp_config_recovers_when_claude_settings_is_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let settings_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&settings_dir).unwrap();
        std::fs::write(settings_dir.join("settings.local.json"), "not json").unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(settings_dir.join("settings.local.json")).unwrap(),
        )
        .unwrap();
        assert!(v["enabledMcpjsonServers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s.as_str() == Some("verun")));
    }

    #[test]
    fn write_mcp_config_excludes_claude_settings_local_too() {
        let dir = tempfile::tempdir().unwrap();
        let info = dir.path().join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();

        write_mcp_config(
            dir.path(),
            "t-1",
            std::path::Path::new("/sock"),
            std::path::Path::new("/relay"),
        )
        .unwrap();

        let exclude = std::fs::read_to_string(info.join("exclude")).unwrap();
        assert!(exclude
            .lines()
            .any(|l| l.trim() == ".claude/settings.local.json"));
    }

    #[test]
    fn socket_path_stays_under_macos_104_byte_limit() {
        // Default install puts the app data dir under ~/Library/Application Support/
        // and tacks on a per-worktree identifier; this is a realistic worst case.
        let long = std::path::Path::new(
            "/Users/abdulrahman/Library/Application Support/com.softwaresavants.verun.dev.fragile-stalestate-29",
        );
        let p = socket_path(long);
        assert!(
            p.to_string_lossy().len() < 104,
            "got {} chars: {}",
            p.to_string_lossy().len(),
            p.display()
        );
    }

    #[test]
    fn socket_path_is_deterministic_per_app_data_dir() {
        let a = std::path::Path::new("/some/dir/a");
        let b = std::path::Path::new("/some/dir/b");
        assert_eq!(socket_path(a), socket_path(a));
        assert_ne!(socket_path(a), socket_path(b));
    }

    #[test]
    fn relay_binary_path_is_sibling_of_current_exe() {
        let resolved = relay_binary_path().unwrap();
        let exe = std::env::current_exe().unwrap();
        assert_eq!(resolved.parent(), exe.parent());
        let expected = if cfg!(windows) {
            "verun-mcp-relay.exe"
        } else {
            "verun-mcp-relay"
        };
        assert_eq!(resolved.file_name().unwrap(), expected);
    }

    #[tokio::test]
    async fn relay_pipes_stdin_to_socket_and_socket_to_stdout() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        // Stdin: a single ping request. The relay prefixes the identity frame
        // for us based on the env-derived task_id, so the agent never has to
        // know the protocol.
        let stdin: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"ping\"}\n";

        // Drive the relay with a bounded timeout: once the host has sent the
        // ping response back, the relay's stdin->socket copy stays open
        // indefinitely (Cursor over a slice never EOFs into a write loop),
        // so the timeout is what eventually returns.
        let relay = tokio::spawn({
            let socket = socket.clone();
            async move {
                let stdin = std::io::Cursor::new(stdin);
                let mut stdout_buf: Vec<u8> = Vec::new();
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    run_relay(socket, Some("t-a".into()), stdin, &mut stdout_buf),
                )
                .await;
                stdout_buf
            }
        });
        let stdout = relay.await.unwrap();

        // The relay should have forwarded the ping response back to stdout.
        let line = stdout
            .split(|b| *b == b'\n')
            .find(|s| !s.is_empty())
            .expect("expected at least one response line");
        let resp: Value = serde_json::from_slice(line).unwrap();
        assert_eq!(resp["id"], 42);
        assert_eq!(resp["result"], json!({}));

        server.abort();
    }

    #[tokio::test]
    async fn relay_passes_task_id_so_default_scope_works() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-b", "p-1", "beta", 2000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-c", "p-2", "gamma", 3000)))
            .await
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");
        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });
        wait_for_socket(&socket).await;

        let stdin: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\
                             \"params\":{\"name\":\"verun_list_tasks\",\"arguments\":{}}}\n";
        let stdout = tokio::spawn({
            let socket = socket.clone();
            async move {
                let mut buf = Vec::new();
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    run_relay(
                        socket,
                        Some("t-a".into()),
                        std::io::Cursor::new(stdin),
                        &mut buf,
                    ),
                )
                .await;
                buf
            }
        })
        .await
        .unwrap();

        let line = stdout
            .split(|b| *b == b'\n')
            .find(|s| !s.is_empty())
            .expect("relay produced no output");
        let resp: Value = serde_json::from_slice(line).unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        // Only p-1 tasks should be visible because identity scoped us to t-a.
        let ids: Vec<&str> = payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["task_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["t-b", "t-a"]);

        server.abort();
    }

    #[tokio::test]
    async fn relay_returns_io_error_when_socket_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-there.sock");
        let stdin: &[u8] = b"";
        let mut stdout: Vec<u8> = Vec::new();
        let err = run_relay(missing, None, std::io::Cursor::new(stdin), &mut stdout)
            .await
            .unwrap_err();
        assert!(
            matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused),
            "unexpected error kind: {:?}",
            err.kind()
        );
    }

    fn call_read_task_output(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_read_task_output", "arguments": args }),
        }
    }

    #[tokio::test]
    async fn read_task_output_returns_chrono_lines_for_latest_session() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-old", "t-a", 100)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-new", "t-a", 200)))
            .await
            .unwrap();
        insert_output(&pool, "s-old", &["old-line-1"]).await;
        insert_output(&pool, "s-new", &["alpha", "beta", "gamma"]).await;

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "t-a" })),
        )
        .await;
        let payload = extract_payload(&resp);

        assert_eq!(payload["session_id"], "s-new");
        let lines: Vec<&str> = payload["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(lines, vec!["alpha", "beta", "gamma"]);
        assert_eq!(payload["more_available"], false);
    }

    #[tokio::test]
    async fn read_task_output_explicit_session_must_belong_to_task() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-b", "p-1", "beta", 2000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-1", "t-b", 100)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "t-a", "session_id": "s-1" })),
        )
        .await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("different task"));
    }

    #[tokio::test]
    async fn read_task_output_unknown_task_returns_helpful_error() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "ghost" })),
        )
        .await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("verun_list_tasks"));
    }

    #[tokio::test]
    async fn read_task_output_task_with_no_sessions_returns_helpful_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "t-a" })),
        )
        .await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("no sessions"));
    }

    #[tokio::test]
    async fn read_task_output_unknown_session_returns_helpful_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "t-a", "session_id": "ghost-sess" })),
        )
        .await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("ghost-sess"));
    }

    #[tokio::test]
    async fn read_task_output_missing_task_id_arg_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(&ctx, call_read_task_output(json!({}))).await;
        let err = resp.error.unwrap();
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("task_id"));
    }

    #[tokio::test]
    async fn read_task_output_paginates_via_cursor_when_byte_budget_exceeded() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();

        // 5 lines of ~500 chars each = ~2500 bytes total. With a tail_bytes
        // budget of 1024, we should get the newest 2 lines and need to
        // paginate to fetch older ones.
        let big = "x".repeat(500);
        let lines: Vec<&str> = (0..5).map(|_| big.as_str()).collect();
        insert_output(&pool, "s-a", &lines).await;

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };

        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({
                "task_id": "t-a",
                "tail_bytes": 1024,
            })),
        )
        .await;
        let p1 = extract_payload(&resp);
        assert_eq!(p1["more_available"], true);
        let cursor = p1["next_cursor"].as_str().unwrap().to_string();
        let first_count = p1["lines"].as_array().unwrap().len();
        assert!((1..=3).contains(&first_count), "got {first_count}");

        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({
                "task_id": "t-a",
                "tail_bytes": 1024,
                "cursor": cursor,
            })),
        )
        .await;
        let p2 = extract_payload(&resp);
        assert!(
            !p2["lines"].as_array().unwrap().is_empty(),
            "second page should still have lines"
        );
    }

    #[tokio::test]
    async fn read_task_output_clamps_tail_bytes_above_max() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();
        insert_output(&pool, "s-a", &["only-line"]).await;

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({
                "task_id": "t-a",
                "tail_bytes": 999_999_999_i64,
            })),
        )
        .await;
        let p = extract_payload(&resp);
        // The clamp shouldn't error - just use MAX_TAIL_BYTES under the hood.
        assert_eq!(p["lines"].as_array().unwrap().len(), 1);
        assert_eq!(p["more_available"], false);
    }

    #[tokio::test]
    async fn read_task_output_includes_task_metadata_for_display() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        let mut t = task("t-a", "p-1", "alpha-branch", 1000);
        t.name = Some("Fix Auth".into());
        process_write(&pool, DbWrite::InsertTask(t)).await.unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();
        insert_output(&pool, "s-a", &["hello"]).await;

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_read_task_output(json!({ "task_id": "t-a" })),
        )
        .await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-a");
        assert_eq!(p["task_name"], "Fix Auth");
        assert_eq!(p["session_id"], "s-a");
        assert_eq!(p["agent"], "claude");
        assert_eq!(p["session_status"], "running");
    }

    #[tokio::test]
    async fn tools_list_includes_verun_read_task_output() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let tools = resp.result.unwrap()["tools"].as_array().cloned().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "verun_read_task_output"));
    }

    fn call_send_message(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_send_message", "arguments": args }),
        }
    }

    type CapturedCalls = std::sync::Arc<tokio::sync::Mutex<Vec<(String, String)>>>;

    /// Spin up a worker that consumes McpAction::SendUserMessage from `rx`,
    /// records each (session_id, message) pair, and responds with `reply_with`.
    /// Returns the captured-calls vector (clone the Arc to inspect from the
    /// test) and a sender ready to plug into `McpContext::actions`.
    fn spawn_capture_worker(
        reply_with: Result<(), String>,
    ) -> (mpsc::Sender<McpAction>, CapturedCalls) {
        let (tx, mut rx) = mpsc::channel::<McpAction>(8);
        let captured: CapturedCalls =
            std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<(String, String)>::new()));
        let captured_for_worker = captured.clone();
        tokio::spawn(async move {
            while let Some(action) = rx.recv().await {
                match action {
                    McpAction::SendUserMessage {
                        session_id,
                        message,
                        reply,
                    } => {
                        captured_for_worker
                            .lock()
                            .await
                            .push((session_id, message));
                        let _ = reply.send(reply_with.clone());
                    }
                    McpAction::SpawnTask { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                    McpAction::AppStart { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                    McpAction::AppStop { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                    McpAction::AppLogs { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                }
            }
        });
        (tx, captured)
    }

    #[tokio::test]
    async fn send_message_routes_to_latest_session_of_task() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-old", "t-a", 100)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-new", "t-a", 200)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-a", "message": "hi sibling" })),
        )
        .await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-a");
        assert_eq!(p["session_id"], "s-new");
        assert_eq!(p["delivered"], true);

        let calls = captured.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "s-new");
        assert_eq!(calls[0].1, "hi sibling");
    }

    #[tokio::test]
    async fn send_message_with_explicit_session_routes_to_that_session() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-old", "t-a", 100)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-new", "t-a", 200)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({
                "task_id": "t-a",
                "session_id": "s-old",
                "message": "use the older one",
            })),
        )
        .await;
        let p = extract_payload(&resp);
        assert_eq!(p["session_id"], "s-old");

        let calls = captured.lock().await;
        assert_eq!(calls[0].0, "s-old");
    }

    #[tokio::test]
    async fn send_message_explicit_session_must_belong_to_task() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-b", "p-1", "beta", 2000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-b", "t-b", 200)))
            .await
            .unwrap();

        let (tx, _captured) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({
                "task_id": "t-a",
                "session_id": "s-b",
                "message": "wrong task",
            })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.contains("does not belong"),
            "got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn send_message_unknown_task_returns_helpful_error() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-ghost", "message": "hi" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("t-ghost"));
    }

    #[tokio::test]
    async fn send_message_task_with_no_sessions_returns_helpful_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-a", "message": "hi" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.to_lowercase().contains("no session")
                || err.message.to_lowercase().contains("no active session"),
            "got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn send_message_unknown_session_returns_helpful_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({
                "task_id": "t-a",
                "session_id": "s-missing",
                "message": "hi",
            })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("s-missing"));
    }

    #[tokio::test]
    async fn send_message_missing_task_id_arg_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_send_message(json!({ "message": "hi" }))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("task_id"));
    }

    #[tokio::test]
    async fn send_message_missing_message_arg_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_send_message(json!({ "task_id": "t-a" }))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("message"));
    }

    #[tokio::test]
    async fn send_message_empty_message_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_worker(Ok(()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-a", "message": "   " })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.to_lowercase().contains("empty") || err.message.contains("message"));
    }

    #[tokio::test]
    async fn send_message_without_actions_channel_returns_internal_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: None,
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-a", "message": "hi" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INTERNAL);
    }

    #[tokio::test]
    async fn send_message_worker_error_propagates_as_internal() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::CreateSession(session("s-a", "t-a", 100)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_worker(Err("agent stdin closed".into()));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_send_message(json!({ "task_id": "t-a", "message": "hi" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INTERNAL);
        assert!(err.message.contains("agent stdin closed"));
    }

    #[tokio::test]
    async fn tools_list_includes_verun_send_message() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let tools = resp.result.unwrap()["tools"].as_array().cloned().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "verun_send_message"));
    }

    fn call_spawn_task(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_spawn_task", "arguments": args }),
        }
    }

    #[derive(Clone, Debug)]
    struct CapturedSpawn {
        project_id: String,
        base_branch: Option<String>,
        agent_type: String,
        initial_message: Option<String>,
    }

    type CapturedSpawns = std::sync::Arc<tokio::sync::Mutex<Vec<CapturedSpawn>>>;

    /// Worker that records every SpawnTask request and returns a synthesized
    /// outcome so we can assert the tool's handling without exercising real
    /// git/worktree machinery. The worker also handles SendUserMessage as a
    /// no-op so tests that mix actions (initial_message follow-up) work.
    fn spawn_capture_spawn_worker(
        outcome: SpawnTaskOutcome,
    ) -> (mpsc::Sender<McpAction>, CapturedSpawns) {
        let (tx, mut rx) = mpsc::channel::<McpAction>(8);
        let captured: CapturedSpawns = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let captured_for_worker = captured.clone();
        tokio::spawn(async move {
            while let Some(action) = rx.recv().await {
                match action {
                    McpAction::SpawnTask {
                        project_id,
                        base_branch,
                        agent_type,
                        initial_message,
                        reply,
                    } => {
                        captured_for_worker.lock().await.push(CapturedSpawn {
                            project_id,
                            base_branch,
                            agent_type,
                            initial_message,
                        });
                        let _ = reply.send(Ok(outcome.clone()));
                    }
                    McpAction::SendUserMessage { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    McpAction::AppStart { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                    McpAction::AppStop { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                    McpAction::AppLogs { reply, .. } => {
                        let _ = reply.send(Err("not supported by this test worker".into()));
                    }
                }
            }
        });
        (tx, captured)
    }

    fn outcome(task_id: &str, session_id: &str) -> SpawnTaskOutcome {
        SpawnTaskOutcome {
            task_id: task_id.into(),
            branch: format!("auto/{task_id}"),
            session_id: session_id.into(),
            agent_type: "claude".into(),
            initial_message_delivered: false,
        }
    }

    #[tokio::test]
    async fn spawn_task_defaults_to_callers_project_when_no_project_id_given() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_spawn_task(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-new");
        assert_eq!(p["session_id"], "s-new");

        let calls = captured.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].project_id, "p-1");
        assert_eq!(calls[0].agent_type, "claude");
        assert!(calls[0].base_branch.is_none());
        assert!(calls[0].initial_message.is_none());
    }

    #[tokio::test]
    async fn spawn_task_with_explicit_project_id_uses_that_project() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertProject(project("p-2", "App Two")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let _ = dispatch(&ctx, call_spawn_task(json!({ "project_id": "p-2" }))).await;
        let calls = captured.lock().await;
        assert_eq!(calls[0].project_id, "p-2");
    }

    #[tokio::test]
    async fn spawn_task_with_no_caller_and_no_project_id_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_spawn_task(json!({}))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.to_lowercase().contains("project"),
            "got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn spawn_task_unknown_project_id_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (tx, _) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_spawn_task(json!({ "project_id": "p-ghost" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("p-ghost"));
    }

    #[tokio::test]
    async fn spawn_task_passes_explicit_agent_type_through() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let _ = dispatch(&ctx, call_spawn_task(json!({ "agent_type": "codex" }))).await;
        let calls = captured.lock().await;
        assert_eq!(calls[0].agent_type, "codex");
    }

    #[tokio::test]
    async fn spawn_task_rejects_unknown_agent_type() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_spawn_task(json!({ "agent_type": "super-bogus" })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("super-bogus"));
    }

    #[tokio::test]
    async fn spawn_task_passes_base_branch_through() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, captured) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let _ = dispatch(
            &ctx,
            call_spawn_task(json!({ "base_branch": "develop" })),
        )
        .await;
        let calls = captured.lock().await;
        assert_eq!(calls[0].base_branch.as_deref(), Some("develop"));
    }

    #[tokio::test]
    async fn spawn_task_with_initial_message_passes_it_to_worker() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let mut o = outcome("t-new", "s-new");
        o.initial_message_delivered = true;
        let (tx, captured) = spawn_capture_spawn_worker(o);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_spawn_task(json!({ "initial_message": "do the thing" })),
        )
        .await;
        let p = extract_payload(&resp);
        assert_eq!(p["initial_message_delivered"], true);

        let calls = captured.lock().await;
        assert_eq!(calls[0].initial_message.as_deref(), Some("do the thing"));
    }

    #[tokio::test]
    async fn spawn_task_with_blank_initial_message_returns_invalid_params() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_spawn_worker(outcome("t-new", "s-new"));
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(
            &ctx,
            call_spawn_task(json!({ "initial_message": "  " })),
        )
        .await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(
            err.message.to_lowercase().contains("empty")
                || err.message.contains("initial_message")
        );
    }

    #[tokio::test]
    async fn spawn_task_without_actions_channel_returns_internal_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(&ctx, call_spawn_task(json!({}))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INTERNAL);
    }

    #[tokio::test]
    async fn spawn_task_worker_error_propagates_as_internal() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, mut rx) = mpsc::channel::<McpAction>(4);
        tokio::spawn(async move {
            while let Some(a) = rx.recv().await {
                if let McpAction::SpawnTask { reply, .. } = a {
                    let _ = reply.send(Err("worktree exists".into()));
                }
            }
        });
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_spawn_task(json!({}))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INTERNAL);
        assert!(err.message.contains("worktree exists"));
    }

    #[tokio::test]
    async fn spawn_task_response_includes_outcome_metadata() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App One")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (tx, _) = spawn_capture_spawn_worker(SpawnTaskOutcome {
            task_id: "t-new".into(),
            branch: "fancy/branch".into(),
            session_id: "s-new".into(),
            agent_type: "codex".into(),
            initial_message_delivered: false,
        });
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_spawn_task(json!({ "agent_type": "codex" }))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-new");
        assert_eq!(p["branch"], "fancy/branch");
        assert_eq!(p["session_id"], "s-new");
        assert_eq!(p["agent"], "codex");
        assert_eq!(p["initial_message_delivered"], false);
    }

    #[tokio::test]
    async fn tools_list_includes_verun_spawn_task() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let tools = resp.result.unwrap()["tools"].as_array().cloned().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "verun_spawn_task"));
    }

    fn call_app_start(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_app_start", "arguments": args }),
        }
    }

    fn call_app_stop(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_app_stop", "arguments": args }),
        }
    }

    fn call_app_logs(args: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: json!({ "name": "verun_app_logs", "arguments": args }),
        }
    }

    #[derive(Clone, Debug, Default)]
    struct CapturedAppCalls {
        starts: Vec<String>,
        stops: Vec<String>,
        logs: Vec<(String, i64)>,
    }

    type CapturedApps = std::sync::Arc<tokio::sync::Mutex<CapturedAppCalls>>;

    /// Worker that records app_start/stop/logs args and replies with the
    /// supplied outcomes. Used to assert the tool layer's contract without a
    /// real PTY.
    fn spawn_capture_app_worker(
        start: AppStartOutcome,
        stop: AppStopOutcome,
        logs: AppLogsOutcome,
    ) -> (mpsc::Sender<McpAction>, CapturedApps) {
        let (tx, mut rx) = mpsc::channel::<McpAction>(8);
        let captured: CapturedApps =
            std::sync::Arc::new(tokio::sync::Mutex::new(CapturedAppCalls::default()));
        let captured_for_worker = captured.clone();
        tokio::spawn(async move {
            while let Some(action) = rx.recv().await {
                match action {
                    McpAction::AppStart { task_id, reply } => {
                        captured_for_worker.lock().await.starts.push(task_id);
                        let _ = reply.send(Ok(start.clone()));
                    }
                    McpAction::AppStop { task_id, reply } => {
                        captured_for_worker.lock().await.stops.push(task_id);
                        let _ = reply.send(Ok(stop.clone()));
                    }
                    McpAction::AppLogs {
                        task_id,
                        tail_bytes,
                        reply,
                    } => {
                        captured_for_worker
                            .lock()
                            .await
                            .logs
                            .push((task_id, tail_bytes));
                        let _ = reply.send(Ok(logs.clone()));
                    }
                    McpAction::SendUserMessage { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    McpAction::SpawnTask { reply, .. } => {
                        let _ = reply.send(Err("not supported".into()));
                    }
                }
            }
        });
        (tx, captured)
    }

    fn default_outcomes() -> (AppStartOutcome, AppStopOutcome, AppLogsOutcome) {
        (
            AppStartOutcome {
                task_id: "t-a".into(),
                terminal_id: "term-1".into(),
                command: "pnpm dev".into(),
                already_running: false,
            },
            AppStopOutcome {
                task_id: "t-a".into(),
                stopped: true,
                terminal_id: Some("term-1".into()),
            },
            AppLogsOutcome {
                task_id: "t-a".into(),
                terminal_id: Some("term-1".into()),
                running: true,
                output: "ready on http://localhost:3000\n".into(),
                bytes: 31,
            },
        )
    }

    // ---- verun_app_start ---------------------------------------------------

    #[tokio::test]
    async fn app_start_defaults_to_callers_task() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, stop, logs) = default_outcomes();
        let (tx, captured) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_start(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-a");
        assert_eq!(p["terminal_id"], "term-1");
        assert_eq!(p["command"], "pnpm dev");
        assert_eq!(p["already_running"], false);
        assert_eq!(captured.lock().await.starts, vec!["t-a".to_string()]);
    }

    #[tokio::test]
    async fn app_start_explicit_task_id_overrides_caller() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-b", "p-1", "beta", 2000)))
            .await
            .unwrap();

        let (start, stop, logs) = default_outcomes();
        let (tx, captured) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let _ = dispatch(&ctx, call_app_start(json!({ "task_id": "t-b" }))).await;
        assert_eq!(captured.lock().await.starts, vec!["t-b".to_string()]);
    }

    #[tokio::test]
    async fn app_start_unknown_task_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (start, stop, logs) = default_outcomes();
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_start(json!({ "task_id": "t-ghost" }))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("t-ghost"));
    }

    #[tokio::test]
    async fn app_start_no_caller_no_task_id_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (start, stop, logs) = default_outcomes();
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_start(json!({}))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.to_lowercase().contains("task"));
    }

    #[tokio::test]
    async fn app_start_without_actions_channel_returns_internal_error() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: None,
        };
        let resp = dispatch(&ctx, call_app_start(json!({}))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INTERNAL);
    }

    #[tokio::test]
    async fn app_start_already_running_propagates_flag() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (mut start, stop, logs) = default_outcomes();
        start.already_running = true;
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_start(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["already_running"], true);
    }

    // ---- verun_app_stop ----------------------------------------------------

    #[tokio::test]
    async fn app_stop_defaults_to_callers_task() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, stop, logs) = default_outcomes();
        let (tx, captured) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_stop(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-a");
        assert_eq!(p["stopped"], true);
        assert_eq!(p["terminal_id"], "term-1");
        assert_eq!(captured.lock().await.stops, vec!["t-a".to_string()]);
    }

    #[tokio::test]
    async fn app_stop_when_nothing_running_returns_stopped_false() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, mut stop, logs) = default_outcomes();
        stop.stopped = false;
        stop.terminal_id = None;
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_stop(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["stopped"], false);
        assert!(p["terminal_id"].is_null());
    }

    #[tokio::test]
    async fn app_stop_unknown_task_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (start, stop, logs) = default_outcomes();
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_stop(json!({ "task_id": "t-ghost" }))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("t-ghost"));
    }

    // ---- verun_app_logs ----------------------------------------------------

    #[tokio::test]
    async fn app_logs_defaults_to_callers_task_and_default_tail_bytes() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, stop, logs) = default_outcomes();
        let (tx, captured) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_logs(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["task_id"], "t-a");
        assert_eq!(p["running"], true);
        assert_eq!(p["terminal_id"], "term-1");
        assert!(p["output"].as_str().unwrap().contains("ready on"));
        assert_eq!(captured.lock().await.logs.len(), 1);
        let (tid, tb) = captured.lock().await.logs[0].clone();
        assert_eq!(tid, "t-a");
        assert_eq!(tb, DEFAULT_TAIL_BYTES);
    }

    #[tokio::test]
    async fn app_logs_clamps_tail_bytes_into_range() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, stop, logs) = default_outcomes();
        let (tx, captured) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let _ = dispatch(
            &ctx,
            call_app_logs(json!({ "tail_bytes": 999_999_999_i64 })),
        )
        .await;
        let _ = dispatch(&ctx, call_app_logs(json!({ "tail_bytes": 1 }))).await;
        let calls = captured.lock().await.logs.clone();
        assert_eq!(calls[0].1, MAX_TAIL_BYTES);
        assert_eq!(calls[1].1, MIN_TAIL_BYTES);
    }

    #[tokio::test]
    async fn app_logs_when_not_running_returns_running_false() {
        let pool = pool_with_schema().await;
        process_write(&pool, DbWrite::InsertProject(project("p-1", "App")))
            .await
            .unwrap();
        process_write(&pool, DbWrite::InsertTask(task("t-a", "p-1", "alpha", 1000)))
            .await
            .unwrap();

        let (start, stop, mut logs) = default_outcomes();
        logs.running = false;
        logs.terminal_id = None;
        logs.output = String::new();
        logs.bytes = 0;
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: Some("t-a".into()),
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_logs(json!({}))).await;
        let p = extract_payload(&resp);
        assert_eq!(p["running"], false);
        assert!(p["terminal_id"].is_null());
        assert_eq!(p["output"], "");
    }

    #[tokio::test]
    async fn app_logs_unknown_task_returns_invalid_params() {
        let pool = pool_with_schema().await;
        let (start, stop, logs) = default_outcomes();
        let (tx, _) = spawn_capture_app_worker(start, stop, logs);
        let ctx = McpContext {
            pool: pool.clone(),
            caller_task_id: None,
            actions: Some(tx),
        };
        let resp = dispatch(&ctx, call_app_logs(json!({ "task_id": "t-ghost" }))).await;
        let err = resp.error.expect("expected error");
        assert_eq!(err.code, E_INVALID_PARAMS);
        assert!(err.message.contains("t-ghost"));
    }

    #[tokio::test]
    async fn tools_list_includes_app_tools() {
        let pool = pool_with_schema().await;
        let ctx = McpContext {
            pool,
            caller_task_id: None,
            actions: None,
        };
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/list".into(),
            params: json!({}),
        };
        let resp = dispatch(&ctx, req).await;
        let tools = resp.result.unwrap()["tools"].as_array().cloned().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "verun_app_start"));
        assert!(tools.iter().any(|t| t["name"] == "verun_app_stop"));
        assert!(tools.iter().any(|t| t["name"] == "verun_app_logs"));
    }

    #[tokio::test]
    async fn socket_rebinds_when_stale_socket_file_exists() {
        let pool = pool_with_schema().await;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("v.sock");

        // Pre-create a stale file at the socket path - bind() would normally
        // fail with EADDRINUSE.
        std::fs::write(&socket, b"stale").unwrap();
        assert!(socket.exists());

        let pool_for_server = pool.clone();
        let socket_for_server = socket.clone();
        let server = tokio::spawn(async move {
            let _ = serve_socket(pool_for_server, socket_for_server, None).await;
        });

        // Give the listener time to bind.
        for _ in 0..100 {
            if tokio::net::UnixStream::connect(&socket).await.is_ok() {
                server.abort();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("server failed to rebind over stale socket");
    }
}
