//! # Codex app-server JSON-RPC transport
//!
//! Newline-delimited JSON-RPC 2.0 over a child process's stdio. Matches the
//! wire shape t3code ships in `packages/effect-codex-app-server/src/protocol.ts`
//! (upstream Codex protocol ref: `dbfe855f4fd0f5dcdf079882652a8efe622b0595`).
//!
//! The writer side stays in `task.rs` (it already owns the `Arc<Mutex<ChildStdin>>`);
//! this module owns:
//!
//!  1. Message classification — request / response / notification.
//!  2. A reader task that pulls lines off stdout and routes them:
//!     - Responses → resolve the `oneshot` registered under the request id.
//!     - Notifications → emit a [`CodexRpcEvent::Notification`].
//!     - Server-originated requests → emit a [`CodexRpcEvent::ServerRequest`]
//!       so the orchestrator can route approvals through `PendingApprovals`.
//!  3. The `PendingRpcResponses` correlation map.
//!
//! Recoverable `thread/resume` errors (per t3code's
//! `RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS`) are exposed via
//! [`is_recoverable_thread_resume_error`] so callers can fall back to
//! `thread/start`.

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};

/// JSON-RPC error payload (`{code, message, data?}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
            data: None,
        }
    }
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON-RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for JsonRpcError {}

/// Sink for every classified message the reader produces.
#[derive(Debug, Clone)]
pub enum CodexRpcEvent {
    /// Server → client notification (`{method, params}` with no id).
    Notification { method: String, params: Value },
    /// Server-originated request the client must answer. `id` is passed
    /// through verbatim so `encode_rpc_review_decision_response` can echo it.
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    /// The reader saw EOF or a transport error. After this event is emitted,
    /// every pending request is failed with [`JsonRpcError::transport`].
    ReaderClosed { reason: Option<String> },
    /// A line could not be parsed as JSON-RPC. Non-fatal; reader continues.
    ParseError { line: String, detail: String },
}

/// `request_id → oneshot sender waiting for the server's response`.
pub type PendingRpcResponses =
    Arc<DashMap<i64, oneshot::Sender<Result<Value, JsonRpcError>>>>;

pub fn new_pending_rpc_responses() -> PendingRpcResponses {
    Arc::new(DashMap::new())
}

/// Reserve a slot for request `id` and return the receiver the caller will
/// await. The reader resolves the matching sender when the response arrives.
pub fn register_pending(
    pending: &PendingRpcResponses,
    id: i64,
) -> oneshot::Receiver<Result<Value, JsonRpcError>> {
    let (tx, rx) = oneshot::channel();
    pending.insert(id, tx);
    rx
}

/// Classify a single line without any side effects. Useful for tests and for
/// splitting the reader from the routing logic.
///
/// Returns `None` for blank lines.
pub fn classify_line(line: &str) -> Option<Result<ClassifiedMessage, ClassifyError>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => return Some(Err(ClassifyError::NotJson(e.to_string()))),
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            return Some(Err(ClassifyError::NotObject));
        }
    };

    let has_method = obj.get("method").and_then(|m| m.as_str()).is_some();
    let id_field = obj.get("id").cloned();

    match (has_method, id_field) {
        (true, Some(id)) if !id.is_null() => Some(Ok(ClassifiedMessage::ServerRequest {
            id,
            method: obj["method"].as_str().unwrap_or_default().to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        })),
        (true, _) => Some(Ok(ClassifiedMessage::Notification {
            method: obj["method"].as_str().unwrap_or_default().to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        })),
        (false, Some(id)) if !id.is_null() => {
            let int_id = id.as_i64();
            if let Some(err) = obj.get("error") {
                let decoded: Result<JsonRpcError, _> = serde_json::from_value(err.clone());
                Some(Ok(ClassifiedMessage::Response {
                    id: int_id,
                    raw_id: id,
                    result: Err(match decoded {
                        Ok(e) => e,
                        Err(_) => JsonRpcError {
                            code: -32603,
                            message: "Malformed error payload".into(),
                            data: Some(err.clone()),
                        },
                    }),
                }))
            } else {
                let result = obj.get("result").cloned().unwrap_or(Value::Null);
                Some(Ok(ClassifiedMessage::Response {
                    id: int_id,
                    raw_id: id,
                    result: Ok(result),
                }))
            }
        }
        _ => Some(Err(ClassifyError::UnknownShape)),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClassifiedMessage {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Response {
        id: Option<i64>,
        raw_id: Value,
        result: Result<Value, JsonRpcError>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClassifyError {
    NotJson(String),
    NotObject,
    UnknownShape,
}

/// Route a single classified message: resolve a pending oneshot for
/// responses, fan out notifications / server requests through `events`.
pub fn route_message(
    msg: ClassifiedMessage,
    pending: &PendingRpcResponses,
    events: &mpsc::UnboundedSender<CodexRpcEvent>,
) {
    match msg {
        ClassifiedMessage::Notification { method, params } => {
            let _ = events.send(CodexRpcEvent::Notification { method, params });
        }
        ClassifiedMessage::ServerRequest { id, method, params } => {
            let _ = events.send(CodexRpcEvent::ServerRequest { id, method, params });
        }
        ClassifiedMessage::Response {
            id: Some(numeric_id),
            result,
            ..
        } => {
            if let Some((_, tx)) = pending.remove(&numeric_id) {
                let _ = tx.send(result);
            }
        }
        ClassifiedMessage::Response { id: None, .. } => {
            // Non-integer ids don't map to anything we issued. Drop silently
            // — we only ever send numeric ids.
        }
    }
}

/// Spawn a reader task that classifies each line and forwards events. When
/// stdout closes or errors, every outstanding pending response is failed and
/// a `ReaderClosed` event is emitted.
pub fn spawn_reader<R>(
    stdout: R,
    pending: PendingRpcResponses,
    events: mpsc::UnboundedSender<CodexRpcEvent>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match classify_line(&line) {
                    Some(Ok(msg)) => route_message(msg, &pending, &events),
                    Some(Err(err)) => {
                        let _ = events.send(CodexRpcEvent::ParseError {
                            line: line.clone(),
                            detail: format!("{err:?}"),
                        });
                    }
                    None => {}
                },
                Ok(None) => {
                    fail_all_pending(&pending, "Codex app-server stdout closed");
                    let _ = events.send(CodexRpcEvent::ReaderClosed { reason: None });
                    break;
                }
                Err(e) => {
                    let reason = format!("Codex app-server stdout error: {e}");
                    fail_all_pending(&pending, &reason);
                    let _ = events.send(CodexRpcEvent::ReaderClosed {
                        reason: Some(reason),
                    });
                    break;
                }
            }
        }
    })
}

fn fail_all_pending(pending: &PendingRpcResponses, reason: &str) {
    let ids: Vec<i64> = pending.iter().map(|e| *e.key()).collect();
    for id in ids {
        if let Some((_, tx)) = pending.remove(&id) {
            let _ = tx.send(Err(JsonRpcError::transport(reason.to_string())));
        }
    }
}

/// Write raw bytes to stdin, best-effort. Returns an error if stdin has
/// already been closed (e.g. after a graceful shutdown).
pub async fn write_frame(
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    bytes: &[u8],
) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    let writer = guard
        .as_mut()
        .ok_or_else(|| "Codex app-server stdin is closed".to_string())?;
    writer
        .write_all(bytes)
        .await
        .map_err(|e| format!("write codex rpc frame: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush codex rpc frame: {e}"))?;
    Ok(())
}

/// Allocate a fresh request id from the supplied counter. Matches the
/// behaviour of t3code's `nextRequestId`.
pub fn next_request_id(counter: &AtomicI64) -> i64 {
    counter.fetch_add(1, Ordering::SeqCst)
}

/// Register a pending slot for `request_id`, write `bytes` to `stdin`, then
/// await the matching response. Returns the response payload or the
/// server's JSON-RPC error.
pub async fn call(
    stdin: &Arc<TokioMutex<Option<ChildStdin>>>,
    pending: &PendingRpcResponses,
    request_id: i64,
    bytes: &[u8],
) -> Result<Value, JsonRpcError> {
    let rx = register_pending(pending, request_id);
    if let Err(e) = write_frame(stdin, bytes).await {
        pending.remove(&request_id);
        return Err(JsonRpcError::transport(e));
    }
    match rx.await {
        Ok(res) => res,
        Err(_) => Err(JsonRpcError::transport(
            "pending response dropped before reply",
        )),
    }
}

/// Recoverable `thread/resume` error detection — ported from t3code
/// (`isRecoverableThreadResumeError`). When true, the caller should fall
/// back to `thread/start` instead of surfacing the error.
pub fn is_recoverable_thread_resume_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    if !lower.contains("thread") {
        return false;
    }
    const RECOVERABLE: &[&str] = &[
        "not found",
        "missing thread",
        "no such thread",
        "unknown thread",
        "does not exist",
        "no rollout",
    ];
    RECOVERABLE.iter().any(|snippet| lower.contains(snippet))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{duplex, AsyncWriteExt};

    #[test]
    fn blank_line_is_ignored() {
        assert!(classify_line("").is_none());
        assert!(classify_line("   \n").is_none());
    }

    #[test]
    fn classifies_notification() {
        let msg = classify_line(r#"{"method":"thread/started","params":{"thread":{"id":"t"}}}"#)
            .unwrap()
            .unwrap();
        match msg {
            ClassifiedMessage::Notification { method, params } => {
                assert_eq!(method, "thread/started");
                assert_eq!(params["thread"]["id"], "t");
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn classifies_server_request() {
        let line = r#"{"id":42,"method":"applyPatchApproval","params":{"patch":"..."}}"#;
        let msg = classify_line(line).unwrap().unwrap();
        match msg {
            ClassifiedMessage::ServerRequest { id, method, params } => {
                assert_eq!(id, json!(42));
                assert_eq!(method, "applyPatchApproval");
                assert_eq!(params["patch"], "...");
            }
            other => panic!("expected server request, got {other:?}"),
        }
    }

    #[test]
    fn classifies_response_ok() {
        let line = r#"{"id":7,"result":{"thread":{"id":"t-1"}}}"#;
        let msg = classify_line(line).unwrap().unwrap();
        match msg {
            ClassifiedMessage::Response {
                id, result, ..
            } => {
                assert_eq!(id, Some(7));
                let val = result.unwrap();
                assert_eq!(val["thread"]["id"], "t-1");
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn classifies_response_error() {
        let line = r#"{"id":8,"error":{"code":-32000,"message":"thread not found"}}"#;
        let msg = classify_line(line).unwrap().unwrap();
        match msg {
            ClassifiedMessage::Response { id, result, .. } => {
                assert_eq!(id, Some(8));
                let err = result.unwrap_err();
                assert_eq!(err.code, -32000);
                assert_eq!(err.message, "thread not found");
            }
            other => panic!("expected error response, got {other:?}"),
        }
    }

    #[test]
    fn parse_error_is_returned_without_panicking() {
        let out = classify_line("not json").unwrap();
        assert!(matches!(out, Err(ClassifyError::NotJson(_))));
    }

    #[tokio::test]
    async fn route_resolves_pending_oneshot() {
        let pending = new_pending_rpc_responses();
        let rx = register_pending(&pending, 5);
        let (tx, _rx_events) = mpsc::unbounded_channel();
        route_message(
            ClassifiedMessage::Response {
                id: Some(5),
                raw_id: json!(5),
                result: Ok(json!({"ok": true})),
            },
            &pending,
            &tx,
        );
        let got = rx.await.unwrap().unwrap();
        assert_eq!(got["ok"], true);
        assert!(pending.is_empty());
    }

    #[test]
    fn route_emits_notification() {
        let pending = new_pending_rpc_responses();
        let (tx, mut rx) = mpsc::unbounded_channel();
        route_message(
            ClassifiedMessage::Notification {
                method: "turn/completed".into(),
                params: json!({"turn": {"id": "t1"}}),
            },
            &pending,
            &tx,
        );
        let ev = rx.try_recv().expect("event");
        match ev {
            CodexRpcEvent::Notification { method, .. } => assert_eq!(method, "turn/completed"),
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn route_emits_server_request() {
        let pending = new_pending_rpc_responses();
        let (tx, mut rx) = mpsc::unbounded_channel();
        route_message(
            ClassifiedMessage::ServerRequest {
                id: json!(42),
                method: "applyPatchApproval".into(),
                params: json!({"patch":"..."}),
            },
            &pending,
            &tx,
        );
        let ev = rx.try_recv().expect("event");
        match ev {
            CodexRpcEvent::ServerRequest { id, method, .. } => {
                assert_eq!(id, json!(42));
                assert_eq!(method, "applyPatchApproval");
            }
            other => panic!("expected server request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reader_roundtrips_response_through_duplex_pair() {
        // Client writes a request; we fake the server by writing the response
        // on the other half of the duplex.
        let (client_stdout, mut server_stdin) = duplex(1024);
        let pending = new_pending_rpc_responses();
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let rx = register_pending(&pending, 1);

        let _reader = spawn_reader(client_stdout, pending.clone(), events_tx);

        let line = b"{\"id\":1,\"result\":{\"codexHome\":\"/tmp\"}}\n";
        server_stdin.write_all(line).await.unwrap();
        server_stdin.flush().await.unwrap();

        let result = rx.await.unwrap().unwrap();
        assert_eq!(result["codexHome"], "/tmp");
        // No stray events — only a response was written.
        assert!(events_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn reader_routes_server_request_through_events() {
        let (client_stdout, mut server_stdin) = duplex(1024);
        let pending = new_pending_rpc_responses();
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let _reader = spawn_reader(client_stdout, pending, events_tx);

        let line = br#"{"id":7,"method":"applyPatchApproval","params":{"patch":"+1"}}"#;
        server_stdin.write_all(line).await.unwrap();
        server_stdin.write_all(b"\n").await.unwrap();
        server_stdin.flush().await.unwrap();

        let ev = events_rx.recv().await.expect("event");
        match ev {
            CodexRpcEvent::ServerRequest { id, method, .. } => {
                assert_eq!(id, json!(7));
                assert_eq!(method, "applyPatchApproval");
            }
            other => panic!("expected server request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reader_fails_pending_on_eof() {
        let (client_stdout, server_stdin) = duplex(1024);
        let pending = new_pending_rpc_responses();
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let rx = register_pending(&pending, 9);
        let _reader = spawn_reader(client_stdout, pending, events_tx);

        drop(server_stdin);

        let err = rx.await.unwrap().unwrap_err();
        assert!(err.message.contains("closed"), "got {err:?}");
        let ev = events_rx.recv().await.unwrap();
        assert!(matches!(ev, CodexRpcEvent::ReaderClosed { .. }));
    }

    #[test]
    fn is_recoverable_thread_resume_error_matches_snippets() {
        assert!(is_recoverable_thread_resume_error("thread t-1 not found"));
        assert!(is_recoverable_thread_resume_error(
            "Error: Thread does not exist"
        ));
        assert!(is_recoverable_thread_resume_error("No such thread: t-99"));
        assert!(is_recoverable_thread_resume_error(
            "Unknown thread for the given id"
        ));
        assert!(is_recoverable_thread_resume_error(
            "missing thread in state store"
        ));
        assert!(!is_recoverable_thread_resume_error(
            "network connection refused"
        ));
        // Non-thread errors are never recoverable, even if they contain a
        // matching keyword.
        assert!(!is_recoverable_thread_resume_error("file not found"));
    }
}
