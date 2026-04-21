use crate::env_path;
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Maximum bytes of raw PTY output retained per terminal for scrollback replay
/// on attach (e.g. when a task is opened in a new window). 256 KB holds ~2500
/// lines of typical text at 100 chars/line - more than enough for a typical
/// terminal viewport.
pub const REPLAY_BUFFER_CAP: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// PTY handle & map
// ---------------------------------------------------------------------------

/// Bounded chunk-keyed ring buffer of raw PTY output. Chunks are preserved
/// whole (never split in the middle of a multibyte char) so `snapshot` always
/// returns valid UTF-8. The newest chunk is never evicted, so a single chunk
/// larger than `cap` is still surfaced on snapshot.
pub struct PtyBuffer {
    chunks: VecDeque<String>,
    byte_len: usize,
    cap: usize,
    /// Monotonically increasing count of total bytes ever written, regardless
    /// of what's still in the buffer. Used as a sequence number so clients can
    /// dedupe live events against a snapshot.
    total_written: u64,
}

impl PtyBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            byte_len: 0,
            cap,
            total_written: 0,
        }
    }

    pub fn append(&mut self, chunk: &str) {
        self.total_written = self.total_written.saturating_add(chunk.len() as u64);
        self.byte_len += chunk.len();
        self.chunks.push_back(chunk.to_string());
        while self.byte_len > self.cap && self.chunks.len() > 1 {
            if let Some(front) = self.chunks.pop_front() {
                self.byte_len -= front.len();
            }
        }
    }

    /// Returns (concatenated contents, total bytes ever written).
    pub fn snapshot(&self) -> (String, u64) {
        let mut out = String::with_capacity(self.byte_len);
        for c in &self.chunks {
            out.push_str(c);
        }
        (out, self.total_written)
    }

    pub fn total_written(&self) -> u64 {
        self.total_written
    }
}

pub struct PtyHandle {
    pub task_id: String,
    /// Display name shown in terminal tab (shell name, "Dev Server", "Setup", etc.)
    pub name: String,
    /// True when spawned as a project start command (auto-exits on completion).
    pub is_start_command: bool,
    /// "setup" or "destroy" when spawned as a lifecycle hook, else None.
    pub hook_type: Option<String>,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub buffer: Arc<Mutex<PtyBuffer>>,
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
    /// Total bytes ever written to this PTY (including this chunk). Clients use
    /// this to dedupe against an initial snapshot returned from `pty_list_for_task`.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyListEntry {
    pub terminal_id: String,
    pub task_id: String,
    pub name: String,
    pub is_start_command: bool,
    pub hook_type: Option<String>,
    /// Everything still in the replay buffer - typically the last ~256 KB of output.
    pub buffered_output: String,
    /// Seq (total bytes ever written) at the moment the snapshot was taken.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitedEvent {
    pub terminal_id: String,
    pub exit_code: Option<u32>,
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
/// If `initial_command` is provided, it will be written to the PTY immediately after spawn.
/// If `direct_command` is true, the command is run directly via `sh -c` instead of inside
/// a login shell — the PTY exits when the command exits (good for dev servers / start commands).
///
/// `name_override` sets the display name shown in the terminal tab. When `None`,
/// the shell's basename is used (e.g. "zsh"). `is_start_command` and `hook_type`
/// are persisted on the handle so `pty_list_for_task` can surface them when a
/// new window attaches.
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(
    app: AppHandle,
    map: ActivePtyMap,
    task_id: String,
    cwd: String,
    rows: u16,
    cols: u16,
    initial_command: Option<String>,
    env_vars: Vec<(String, String)>,
    direct_command: bool,
    name_override: Option<String>,
    is_start_command: bool,
    hook_type: Option<String>,
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
    #[cfg(not(target_os = "windows"))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    #[cfg(target_os = "windows")]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());

    let shell_name = std::path::Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "shell".to_string());

    // When direct_command is true, run the command directly via the shell — the PTY
    // process IS the command, so when it exits (Ctrl+C, crash, etc.) the PTY exits too.
    let (cmd, write_initial) = if direct_command {
        if let Some(ref command) = initial_command {
            let mut c = CommandBuilder::new(&shell);
            #[cfg(not(target_os = "windows"))]
            {
                // -lic: login + interactive + command — sources .zshrc/.bashrc
                // so nvm/fnm/etc set the correct Node version
                c.args(["-lic", command]);
            }
            #[cfg(target_os = "windows")]
            {
                c.args(["-c", command]);
            }
            c.cwd(&cwd);
            c.env("TERM", "xterm-256color");
            for (k, v) in &env_vars {
                c.env(k, v);
            }
            (c, false) // don't write to stdin — command is an arg
        } else {
            // No command, fall back to interactive shell
            let mut c = CommandBuilder::new(&shell);
            #[cfg(not(target_os = "windows"))]
            c.arg("-l");
            c.cwd(&cwd);
            c.env("TERM", "xterm-256color");
            for (k, v) in &env_vars {
                c.env(k, v);
            }
            (c, false)
        }
    } else {
        let mut c = CommandBuilder::new(&shell);
        #[cfg(not(target_os = "windows"))]
        c.arg("-l"); // login shell for $PATH, aliases, etc.
        c.cwd(&cwd);
        c.env("TERM", "xterm-256color");
        for (k, v) in &env_vars {
            c.env(k, v);
        }
        (c, initial_command.is_some())
    };

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

    let display_name = name_override.unwrap_or_else(|| shell_name.clone());
    let buffer = Arc::new(Mutex::new(PtyBuffer::new(REPLAY_BUFFER_CAP)));

    // Store the handle (master kept for resize)
    map.insert(
        terminal_id.clone(),
        PtyHandle {
            task_id,
            name: display_name,
            is_start_command,
            hook_type,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            buffer: buffer.clone(),
        },
    );

    // Write initial command to stdin (only for non-direct mode)
    if write_initial {
        if let Some(ref cmd) = initial_command {
            if !cmd.is_empty() {
                if let Some(handle) = map.get(&terminal_id) {
                    if let Ok(mut w) = handle.writer.lock() {
                        let _ = w.write_all(format!("{cmd}\n").as_bytes());
                        let _ = w.flush();
                    }
                }
            }
        }
    }

    // Spawn a dedicated OS thread for blocking read
    let tid = terminal_id.clone();
    let exit_map = map.clone();
    let reader_buffer = buffer;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    env_path::record_pty_output();
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let seq = match reader_buffer.lock() {
                        Ok(mut b) => {
                            b.append(&data);
                            b.total_written()
                        }
                        Err(_) => 0,
                    };
                    let _ = app.emit(
                        "pty-output",
                        PtyOutputEvent {
                            terminal_id: tid.clone(),
                            data,
                            seq,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Capture exit code from the child process before emitting pty-exited
        let exit_code = if let Some(handle) = exit_map.get(&tid) {
            handle
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok())
                .map(|status| status.exit_code())
        } else {
            None
        };
        let _ = app.emit(
            "pty-exited",
            PtyExitedEvent {
                terminal_id: tid,
                exit_code,
            },
        );
    });

    Ok(SpawnResult {
        terminal_id,
        shell_name,
    })
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
    // Mark the user as having committed a command if their input contains a
    // newline / carriage return — the idle watcher will reload PATH once the
    // PTY output stream goes quiet.
    if data.iter().any(|&b| b == b'\n' || b == b'\r') {
        env_path::mark_user_committed_command();
    }
    Ok(())
}

/// Resize the PTY.
pub fn resize_pty(
    map: &ActivePtyMap,
    terminal_id: &str,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
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

/// Return metadata + replay buffer for every PTY currently running for a given task.
/// Callers on a freshly-opened window use this to rebuild their terminal list and
/// replay scrollback into their xterm instances.
pub fn list_for_task(map: &ActivePtyMap, task_id: &str) -> Vec<PtyListEntry> {
    let mut entries: Vec<PtyListEntry> = map
        .iter()
        .filter(|e| e.value().task_id == task_id)
        .map(|e| {
            let handle = e.value();
            let (buffered_output, seq) = handle
                .buffer
                .lock()
                .map(|b| b.snapshot())
                .unwrap_or_else(|_| (String::new(), 0));
            PtyListEntry {
                terminal_id: e.key().clone(),
                task_id: handle.task_id.clone(),
                name: handle.name.clone(),
                is_start_command: handle.is_start_command,
                hook_type: handle.hook_type.clone(),
                buffered_output,
                seq,
            }
        })
        .collect();
    // Stable ordering: hooks first (setup then destroy), then start command, then shells.
    // Within each group, keep DashMap's iteration order (arbitrary but consistent per run).
    entries.sort_by_key(|e| match (e.hook_type.as_deref(), e.is_start_command) {
        (Some("setup"), _) => 0,
        (Some(_), _) => 2,
        (None, true) => 1,
        (None, false) => 3,
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_retains_full_content_below_cap() {
        let mut buf = PtyBuffer::new(1024);
        buf.append("hello ");
        buf.append("world");
        let (snap, seq) = buf.snapshot();
        assert_eq!(snap, "hello world");
        assert_eq!(seq, 11);
    }

    #[test]
    fn buffer_evicts_oldest_chunks_when_over_cap() {
        let mut buf = PtyBuffer::new(10);
        buf.append("aaaa"); // 4
        buf.append("bbbb"); // 8
        buf.append("cccc"); // over cap -> evict "aaaa"
        let (snap, seq) = buf.snapshot();
        assert_eq!(snap, "bbbbcccc");
        assert_eq!(seq, 12, "seq counts total bytes ever written");
    }

    #[test]
    fn buffer_preserves_single_oversize_chunk() {
        // Eviction should never drop the newest chunk, even if it alone exceeds cap,
        // so clients always see the latest output.
        let mut buf = PtyBuffer::new(4);
        buf.append("ab");
        buf.append("cdefghij");
        let (snap, _) = buf.snapshot();
        assert_eq!(snap, "cdefghij");
    }

    #[test]
    fn buffer_preserves_multibyte_utf8() {
        // Chunks are kept whole, so a multibyte char can never be split at the
        // eviction boundary.
        let mut buf = PtyBuffer::new(6);
        buf.append("日本"); // 6 bytes
        buf.append("語"); // 3 bytes -> over cap, evict 日本
        let (snap, _) = buf.snapshot();
        assert_eq!(snap, "語");
    }

    #[test]
    fn total_written_advances_past_evicted_bytes() {
        let mut buf = PtyBuffer::new(4);
        buf.append("aa"); // 2
        buf.append("bb"); // 4
        buf.append("cc"); // 6 → evict "aa"
        assert_eq!(buf.total_written(), 6);
    }
}
