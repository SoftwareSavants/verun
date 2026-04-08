use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// PTY handle & map
// ---------------------------------------------------------------------------

pub struct PtyHandle {
    pub task_id: String,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

/// terminal_id → active PTY handle
pub type ActivePtyMap = Arc<DashMap<String, PtyHandle>>;

pub fn new_active_pty_map() -> ActivePtyMap {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// Events emitted to frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitedEvent {
    pub terminal_id: String,
}

// ---------------------------------------------------------------------------
// PTY lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub terminal_id: String,
    pub shell_name: String,
}

/// Spawn a new PTY running the user's shell in the given working directory.
pub fn spawn_pty(
    app: AppHandle,
    map: ActivePtyMap,
    task_id: String,
    cwd: String,
    rows: u16,
    cols: u16,
) -> Result<SpawnResult, String> {
    let terminal_id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Determine the user's shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let shell_name = std::path::Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "shell".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell for $PATH, aliases, etc.
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Clone reader for the background thread
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Store the handle (master kept for resize)
    map.insert(
        terminal_id.clone(),
        PtyHandle {
            task_id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        },
    );

    // Spawn a dedicated OS thread for blocking read
    let tid = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "pty-output",
                        PtyOutputEvent {
                            terminal_id: tid.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app.emit("pty-exited", PtyExitedEvent { terminal_id: tid });
    });

    Ok(SpawnResult { terminal_id, shell_name })
}

/// Write user input to the PTY.
pub fn write_pty(map: &ActivePtyMap, terminal_id: &str, data: &[u8]) -> Result<(), String> {
    let handle = map
        .get(terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;
    let mut writer = handle
        .writer
        .lock()
        .map_err(|e| format!("Writer lock failed: {e}"))?;
    writer
        .write_all(data)
        .map_err(|e| format!("PTY write failed: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("PTY flush failed: {e}"))?;
    Ok(())
}

/// Resize the PTY.
pub fn resize_pty(map: &ActivePtyMap, terminal_id: &str, rows: u16, cols: u16) -> Result<(), String> {
    let handle = map
        .get(terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;
    let master = handle
        .master
        .lock()
        .map_err(|e| format!("Master lock failed: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("PTY resize failed: {e}"))?;
    Ok(())
}

fn kill_handle(handle: PtyHandle) {
    if let Ok(mut child) = handle.child.lock() {
        let _ = child.kill();
    }
}

/// Close a PTY: kill the child process and remove from the map.
pub fn close_pty(map: &ActivePtyMap, terminal_id: &str) -> Result<(), String> {
    if let Some((_, handle)) = map.remove(terminal_id) {
        kill_handle(handle);
    }
    Ok(())
}

/// Close all PTYs for a given task (used during task deletion).
pub fn close_all_for_task(map: &ActivePtyMap, task_id: &str) {
    let ids: Vec<String> = map
        .iter()
        .filter(|e| e.value().task_id == task_id)
        .map(|e| e.key().clone())
        .collect();
    for id in ids {
        if let Some((_, handle)) = map.remove(&id) {
            kill_handle(handle);
        }
    }
}
