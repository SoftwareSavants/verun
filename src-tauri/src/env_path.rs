// Capture and refresh the user's full shell PATH so spawned children
// (claude, lsp, git, gh, …) inherit nvm/homebrew/etc — even when the
// user installs a new version *while the app is running*.
//
// Strategy:
//   1. At startup, run `<SHELL> -lic "echo $PATH"` once and set it on
//      the process env. -lic = login + interactive + command, so .zshrc
//      / .bashrc are sourced (where nvm lives).
//   2. While running, watch two signals to know when to re-capture:
//        a) Window focus (frontend triggers via the manual reload command).
//        b) Integrated PTY idle: a debounce loop sees that the user
//           pressed Enter inside the integrated terminal and the PTY
//           output stream has been silent for 500ms — same heuristic
//           tmux uses when it doesn't have OSC 133 prompt markers.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// True when the user committed a command in the integrated terminal
/// since the last reload — i.e. PATH may have changed.
static PATH_DIRTY: AtomicBool = AtomicBool::new(false);

/// Millis since UNIX epoch of the most recent byte read from any PTY.
static LAST_PTY_OUTPUT_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Synchronously re-capture the user's PATH from their login+interactive
/// shell and set it on the process env. Idempotent and ~50ms.
pub fn reload_now() {
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-lic", "echo $PATH"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    std::env::set_var("PATH", &path);
                }
            }
        }
    }
}

/// Called from the integrated PTY's writer when the user's input contains
/// a command terminator (`\n`/`\r`). Marks PATH as potentially stale; the
/// idle watcher will reload once the PTY goes quiet.
pub fn mark_user_committed_command() {
    PATH_DIRTY.store(true, Ordering::Relaxed);
}

/// Called from the PTY reader thread on every chunk of output. Resets
/// the idle timer.
pub fn record_pty_output() {
    LAST_PTY_OUTPUT_MS.store(now_ms(), Ordering::Relaxed);
}

/// Spawn the background watcher that reloads PATH when the integrated
/// terminal looks idle after a user-committed command. Cheap when nothing
/// is happening — wakes once per 250ms, just checks two atomics.
pub fn start_idle_watcher() {
    std::thread::spawn(|| {
        let started_at = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            // Skip the first ~1s after startup so we don't fight the
            // initial sync reload.
            if started_at.elapsed() < Duration::from_secs(1) {
                continue;
            }
            if !PATH_DIRTY.load(Ordering::Relaxed) {
                continue;
            }
            let last_out = LAST_PTY_OUTPUT_MS.load(Ordering::Relaxed);
            let now = now_ms();
            // Idle if the PTY hasn't emitted any bytes for 500ms (and the
            // last_out=0 case — no output ever — also counts as idle).
            if last_out == 0 || now.saturating_sub(last_out) >= 500 {
                reload_now();
                PATH_DIRTY.store(false, Ordering::Relaxed);
            }
        }
    });
}
