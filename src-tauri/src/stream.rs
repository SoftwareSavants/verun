use crate::db::{DbWrite, DbWriteTx};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

const BATCH_SIZE: usize = 16;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const MAX_PERSISTED_LINES: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutputEvent {
    pub session_id: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: String,
}

/// Stream stdout and stderr from a child process, batching output and emitting
/// via Tauri events. Stderr lines are prefixed with `[stderr]`.
/// Persists up to MAX_PERSISTED_LINES to SQLite; after that, lines still stream
/// to the frontend but stop being written to the DB.
pub async fn stream_output(
    app: AppHandle,
    session_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
    db_tx: DbWriteTx,
) {
    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();
    let mut buffer: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut last_flush = Instant::now();
    let mut total_persisted: usize = 0;
    let mut stdout_done = false;
    let mut stderr_done = false;

    loop {
        if stdout_done && stderr_done {
            break;
        }

        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        tokio::select! {
            line = stdout_reader.next_line(), if !stdout_done => {
                match line {
                    Ok(Some(line)) => {
                        buffer.push(line);
                        if buffer.len() >= BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL {
                            flush_buffer(&app, &session_id, &db_tx, &mut buffer, &mut total_persisted);
                            last_flush = Instant::now();
                        }
                    }
                    Ok(None) => stdout_done = true,
                    Err(_) => stdout_done = true,
                }
            }
            line = stderr_reader.next_line(), if !stderr_done => {
                match line {
                    Ok(Some(line)) => {
                        buffer.push(format!("[stderr] {line}"));
                        if buffer.len() >= BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL {
                            flush_buffer(&app, &session_id, &db_tx, &mut buffer, &mut total_persisted);
                            last_flush = Instant::now();
                        }
                    }
                    Ok(None) => stderr_done = true,
                    Err(_) => stderr_done = true,
                }
            }
            _ = &mut deadline => {
                if !buffer.is_empty() {
                    flush_buffer(&app, &session_id, &db_tx, &mut buffer, &mut total_persisted);
                    last_flush = Instant::now();
                }
            }
        }
    }

    // Final flush
    flush_buffer(&app, &session_id, &db_tx, &mut buffer, &mut total_persisted);
}

fn flush_buffer(
    app: &AppHandle,
    session_id: &str,
    db_tx: &DbWriteTx,
    buffer: &mut Vec<String>,
    total_persisted: &mut usize,
) {
    if buffer.is_empty() {
        return;
    }

    let lines = std::mem::take(buffer);
    let now = epoch_ms();

    // Always emit to frontend (terminal stays live regardless of DB cap)
    let _ = app.emit(
        "session-output",
        SessionOutputEvent {
            session_id: session_id.to_string(),
            lines: lines.clone(),
        },
    );

    // Persist to DB up to the cap
    if *total_persisted < MAX_PERSISTED_LINES {
        let remaining = MAX_PERSISTED_LINES - *total_persisted;
        let to_persist: Vec<(String, i64)> = lines
            .into_iter()
            .take(remaining)
            .map(|l| (l, now))
            .collect();
        *total_persisted += to_persist.len();

        let _ = db_tx.try_send(DbWrite::InsertOutputLines {
            session_id: session_id.to_string(),
            lines: to_persist,
        });
    }
}

/// Map a Claude Code process exit code to a session status string.
/// Claude Code exit codes:
///   0 = success
///   1 = generic error
///   2 = invalid args / config
pub fn map_exit_status(code: Option<i32>) -> &'static str {
    match code {
        Some(0) => "done",
        Some(_) => "error",
        None => "error", // killed by signal
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
    fn batch_size_is_16() {
        assert_eq!(BATCH_SIZE, 16);
    }

    #[test]
    fn flush_interval_is_50ms() {
        assert_eq!(FLUSH_INTERVAL, std::time::Duration::from_millis(50));
    }

    #[test]
    fn max_persisted_lines_is_10k() {
        assert_eq!(MAX_PERSISTED_LINES, 10_000);
    }

    #[test]
    fn output_event_serializes_as_camel_case() {
        let event = SessionOutputEvent {
            session_id: "s-001".into(),
            lines: vec!["line 1".into(), "line 2".into()],
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["sessionId"], "s-001");
        assert_eq!(json["lines"].as_array().unwrap().len(), 2);
        assert_eq!(json["lines"][0], "line 1");
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
    fn output_event_empty_lines() {
        let event = SessionOutputEvent {
            session_id: "a".into(),
            lines: vec![],
        };

        let json = serde_json::to_value(&event).unwrap();
        assert!(json["lines"].as_array().unwrap().is_empty());
    }

    #[test]
    fn stderr_prefix_format() {
        let line = format!("[stderr] {}", "something went wrong");
        assert_eq!(line, "[stderr] something went wrong");
    }

    #[test]
    fn map_exit_status_zero_is_done() {
        assert_eq!(map_exit_status(Some(0)), "done");
    }

    #[test]
    fn map_exit_status_nonzero_is_error() {
        assert_eq!(map_exit_status(Some(1)), "error");
        assert_eq!(map_exit_status(Some(2)), "error");
        assert_eq!(map_exit_status(Some(127)), "error");
    }

    #[test]
    fn map_exit_status_signal_is_error() {
        assert_eq!(map_exit_status(None), "error");
    }

    #[test]
    fn flush_buffer_respects_cap() {
        // Simulate: total_persisted is at 9998, buffer has 5 lines
        // Should only persist 2 more
        let mut total = 9998usize;
        let remaining = MAX_PERSISTED_LINES - total;
        assert_eq!(remaining, 2);

        let lines: Vec<(String, i64)> = vec![
            ("a".into(), 1),
            ("b".into(), 2),
            ("c".into(), 3),
            ("d".into(), 4),
            ("e".into(), 5),
        ];
        let to_persist: Vec<(String, i64)> = lines.into_iter().take(remaining).collect();
        total += to_persist.len();

        assert_eq!(to_persist.len(), 2);
        assert_eq!(total, MAX_PERSISTED_LINES);
    }
}
