//! Integration tests that spawn the actual verun-mcp-relay binary as a
//! subprocess. Verifies the env-var handshake and binary entry point.
//! `ping` is used as the round-trip test because it doesn't touch the DB,
//! so we don't need to expose internal db helpers from the lib crate.
//!
//! Unix only: relay/host both speak Unix domain sockets.

#![cfg(unix)]

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use verun_lib::mcp;

async fn empty_pool() -> SqlitePool {
    SqlitePool::connect("sqlite::memory:").await.unwrap()
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("socket {path:?} never bound");
}

#[tokio::test]
async fn relay_binary_reads_env_vars_and_round_trips_ping() {
    let pool = empty_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("v.sock");
    let pool_for_server = pool.clone();
    let socket_for_server = socket.clone();
    let server = tokio::spawn(async move {
        let _ = mcp::serve_socket(pool_for_server, socket_for_server, None).await;
    });
    wait_for_socket(&socket).await;

    let bin = env!("CARGO_BIN_EXE_verun-mcp-relay");
    let mut child = tokio::process::Command::new(bin)
        .env("VERUN_TASK_ID", "t-a")
        .env("VERUN_MCP_SOCKET", &socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn relay binary");

    let mut child_stdin = child.stdin.take().unwrap();
    let mut child_stdout = child.stdout.take().unwrap();

    child_stdin
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"ping\"}\n")
        .await
        .unwrap();
    drop(child_stdin); // EOF triggers half-close cascade through to relay exit

    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), child_stdout.read_to_end(&mut out))
        .await
        .expect("relay timed out")
        .unwrap();

    let status = child.wait().await.unwrap();
    assert!(status.success(), "relay exited non-zero: {status}");

    let line = out
        .split(|b| *b == b'\n')
        .find(|s| !s.is_empty())
        .expect("relay produced no output");
    let resp: Value = serde_json::from_slice(line).unwrap();
    assert_eq!(resp["id"], 99);
    assert_eq!(resp["result"], json!({}));

    server.abort();
}

#[tokio::test]
async fn relay_binary_exits_nonzero_when_socket_env_missing() {
    let bin = env!("CARGO_BIN_EXE_verun-mcp-relay");
    let mut child = tokio::process::Command::new(bin)
        .env_remove("VERUN_MCP_SOCKET")
        .env_remove("VERUN_TASK_ID")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let status = child.wait().await.unwrap();
    let mut buf = String::new();
    stderr.read_to_string(&mut buf).await.unwrap();
    assert!(!status.success(), "should have exited non-zero");
    assert!(
        buf.contains("VERUN_MCP_SOCKET"),
        "stderr should mention the missing env var: {buf}"
    );
}
