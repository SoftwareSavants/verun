use dashmap::DashMap;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

// ---------------------------------------------------------------------------
// LSP handle & map
// ---------------------------------------------------------------------------

pub struct LspHandle {
    pub stdin: Arc<TokioMutex<ChildStdin>>,
    pub child: Arc<TokioMutex<Child>>,
}

/// task_id → active LSP server handle
pub type LspMap = Arc<DashMap<String, LspHandle>>;

pub fn new_lsp_map() -> LspMap {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Events emitted to frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspMessageEvent {
    pub task_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExitEvent {
    pub task_id: String,
}

// ---------------------------------------------------------------------------
// Content-Length framing
// ---------------------------------------------------------------------------

/// Read one LSP message from stdout (Content-Length framed).
async fn read_lsp_message(reader: &mut BufReader<ChildStdout>) -> Option<String> {
    let mut content_length: usize = 0;

    // Read headers until empty line
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 {
            return None; // EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break; // End of headers
        }
        if let Some(len) = trimmed.strip_prefix("Content-Length: ") {
            content_length = len.parse().ok()?;
        }
        // Ignore other headers (Content-Type, etc.)
    }

    if content_length == 0 {
        return None;
    }

    // Read exactly content_length bytes
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).await.ok()?;
    String::from_utf8(body).ok()
}

/// Frame a JSON message with Content-Length header for writing to stdin.
fn frame_lsp_message(json: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", json.len(), json).into_bytes()
}

// ---------------------------------------------------------------------------
// Resolve bundled LSP binary
// ---------------------------------------------------------------------------

// tsgo ships as a per-arch native binary inside
// @typescript/native-preview-<os>-<arch>. npm installs only the subpackage
// matching the host arch, so we select the right directory at compile time.
// Verun is macOS-only per CLAUDE.md; Apple Silicon and Intel are the two
// arches that can show up on a developer machine today.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TSGO_PLATFORM_DIR: &str = "native-preview-darwin-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TSGO_PLATFORM_DIR: &str = "native-preview-darwin-x64";
// Fallback just so the code compiles on non-macOS hosts during development —
// it won't actually resolve a valid binary, but it keeps `cargo check` happy.
#[cfg(not(target_os = "macos"))]
const TSGO_PLATFORM_DIR: &str = "native-preview-unsupported";

fn tsgo_rel_path() -> [&'static str; 5] {
    [
        "node_modules",
        "@typescript",
        TSGO_PLATFORM_DIR,
        "lib",
        "tsgo",
    ]
}

pub fn resolve_lsp_binary(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let rel = tsgo_rel_path();
    if let Ok(resource_dir) = app.path().resource_dir() {
        let mut bundled = resource_dir.join("resources").join("lsp");
        for seg in rel.iter() {
            bundled = bundled.join(seg);
        }
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let mut dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("lsp");
    for seg in rel.iter() {
        dev_path = dev_path.join(seg);
    }
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err("tsgo binary not found. Reinstall Verun or run `pnpm install` to fetch @typescript/native-preview.".into())
}

// ---------------------------------------------------------------------------
// Spawn & manage
// ---------------------------------------------------------------------------

pub async fn start_server(
    lsp_map: &LspMap,
    app: AppHandle,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    // Already running for this task
    if lsp_map.contains_key(&task_id) {
        return Ok(());
    }

    let lsp_bin = resolve_lsp_binary(&app)?;

    let mut child = tokio::process::Command::new(&lsp_bin)
        .arg("--lsp")
        .arg("--stdio")
        .current_dir(&worktree_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn tsgo: {e}"))?;

    let stdin = child.stdin.take().ok_or("Failed to capture LSP stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture LSP stdout")?;

    let stdin = Arc::new(TokioMutex::new(stdin));
    let child = Arc::new(TokioMutex::new(child));

    lsp_map.insert(
        task_id.clone(),
        LspHandle {
            stdin: Arc::clone(&stdin),
            child: Arc::clone(&child),
        },
    );

    // Background task: read LSP messages from stdout and emit events
    let tid = task_id.clone();
    let map_ref = Arc::clone(lsp_map);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        while let Some(message) = read_lsp_message(&mut reader).await {
            let _ = app.emit(
                "lsp-message",
                LspMessageEvent {
                    task_id: tid.clone(),
                    message,
                },
            );
        }
        // Process exited — clean up and notify the frontend so it can show a
        // toast. `stop_server` pre-removes from the map, so if the entry is
        // still present here it means the child exited on its own (crash).
        if map_ref.remove(&tid).is_some() {
            let _ = app.emit("lsp-exit", LspExitEvent { task_id: tid });
        }
    });

    Ok(())
}

pub async fn send_message(lsp_map: &LspMap, task_id: &str, message: &str) -> Result<(), String> {
    let handle = lsp_map
        .get(task_id)
        .ok_or_else(|| format!("No LSP server for task {task_id}"))?;

    let framed = frame_lsp_message(message);
    let mut stdin = handle.stdin.lock().await;
    stdin
        .write_all(&framed)
        .await
        .map_err(|e| format!("Failed to write to LSP stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush LSP stdin: {e}"))?;

    Ok(())
}

pub async fn stop_server(lsp_map: &LspMap, task_id: &str) {
    if let Some((_, handle)) = lsp_map.remove(task_id) {
        let mut child = handle.child.lock().await;
        let _ = child.kill().await;
    }
}
