use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStdout;

const BATCH_SIZE: usize = 16;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Serialize)]
pub struct AgentOutputEvent {
    pub agent_id: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusEvent {
    pub agent_id: String,
    pub status: String,
}

/// Stream stdout from a child process, batching output and emitting via Tauri events.
/// Batches up to BATCH_SIZE lines or flushes every FLUSH_INTERVAL, whichever comes first.
pub async fn stream_output(
    app: AppHandle,
    agent_id: String,
    stdout: ChildStdout,
) {
    let mut reader = BufReader::new(stdout).lines();
    let mut buffer: Vec<String> = Vec::with_capacity(BATCH_SIZE);
    let mut last_flush = Instant::now();

    loop {
        let timeout = tokio::time::timeout(FLUSH_INTERVAL, reader.next_line()).await;

        match timeout {
            Ok(Ok(Some(line))) => {
                buffer.push(line);
                if buffer.len() >= BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL {
                    let _ = app.emit("agent-output", AgentOutputEvent {
                        agent_id: agent_id.clone(),
                        lines: std::mem::take(&mut buffer),
                    });
                    last_flush = Instant::now();
                }
            }
            Ok(Ok(None)) => {
                // EOF — flush remaining and exit
                if !buffer.is_empty() {
                    let _ = app.emit("agent-output", AgentOutputEvent {
                        agent_id: agent_id.clone(),
                        lines: std::mem::take(&mut buffer),
                    });
                }
                // Emit done status
                let _ = app.emit("agent-status", AgentStatusEvent {
                    agent_id: agent_id.clone(),
                    status: "done".to_string(),
                });
                break;
            }
            Ok(Err(_e)) => {
                // Read error — flush and emit error status
                if !buffer.is_empty() {
                    let _ = app.emit("agent-output", AgentOutputEvent {
                        agent_id: agent_id.clone(),
                        lines: std::mem::take(&mut buffer),
                    });
                }
                let _ = app.emit("agent-status", AgentStatusEvent {
                    agent_id: agent_id.clone(),
                    status: "error".to_string(),
                });
                break;
            }
            Err(_) => {
                // Timeout — flush whatever we have
                if !buffer.is_empty() {
                    let _ = app.emit("agent-output", AgentOutputEvent {
                        agent_id: agent_id.clone(),
                        lines: std::mem::take(&mut buffer),
                    });
                    last_flush = Instant::now();
                }
            }
        }
    }
}
