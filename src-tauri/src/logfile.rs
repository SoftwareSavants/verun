//! A log file for the installed app. Everything Verun prints to stderr
//! (`eprintln!`, panics) lands in `~/Library/Logs/<bundle id>/verun.log`, so
//! a failure the user reports later can be read back instead of guessed at.

use std::path::{Path, PathBuf};

/// Past this size the log moves to `verun.1.log` at the next launch.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// How much of a short-lived terminal's last output goes in its exit line.
pub const EXIT_TAIL_BYTES: usize = 2048;

/// A terminal that ends this soon after starting most likely failed to start.
const EARLY_EXIT_MS: u128 = 10_000;

/// Keep one previous log: rename `path` to `<stem>.1.log` once it outgrows `max`.
pub fn rotate(path: &Path, max: u64) {
    if std::fs::metadata(path).map(|m| m.len() > max).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("1.log"));
    }
}

/// Send stderr to `dir/verun.log` for the rest of the process. Release builds
/// only: in dev the terminal running `tauri dev` is the log.
pub fn install(dir: &Path) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join("verun.log");
    rotate(&path, MAX_BYTES);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: dup2 onto stderr; the file stays open through the new fd.
        if unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
            return None;
        }
    }
    eprintln!(
        "\n[verun] ---- start v{} pid {} at unix {} ----",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    Some(path)
}

/// Terminal output as readable text: escape sequences and control bytes out.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters, then one final byte in @..~
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ST (ESC \)
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' | '\t' => out.push(c),
            '\r' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Keep the last `max` bytes of terminal output, cut on a character boundary.
pub fn keep_tail(tail: &mut String, chunk: &str, max: usize) {
    tail.push_str(chunk);
    if tail.len() > max {
        let mut cut = tail.len() - max;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

/// The log line for a terminal ending. A quick or failed exit carries what
/// the terminal last showed, since that is usually the error.
pub fn exit_report(terminal: &str, code: Option<u32>, lived_ms: u128, tail: &str) -> String {
    let mut line = format!("[verun][pty] {terminal} exited code={code:?} after {lived_ms}ms");
    if lived_ms < EARLY_EXIT_MS || code.is_some_and(|c| c != 0) {
        let text = strip_ansi(tail);
        let text = text.trim();
        if !text.is_empty() {
            line.push_str(":\n");
            line.push_str(text);
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_past_the_limit_moves_aside_and_a_small_one_stays() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("verun.log");
        std::fs::write(&log, "0123456789").unwrap();
        rotate(&log, 20);
        assert!(log.exists());
        rotate(&log, 5);
        assert!(!log.exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("verun.1.log")).unwrap(), "0123456789");
    }

    #[test]
    fn terminal_escapes_are_stripped_to_text() {
        let raw = "\u{1b}[31mError:\u{1b}[0m bad flag\r\n\u{1b}]0;title\u{7}next\u{1b}]8;;x\u{1b}\\link\u{8}";
        assert_eq!(strip_ansi(raw), "Error: bad flag\nnextlink");
    }

    #[test]
    fn the_tail_keeps_the_last_bytes_on_a_char_boundary() {
        let mut tail = String::new();
        keep_tail(&mut tail, "abc", 4);
        keep_tail(&mut tail, "دخل", 4);
        assert!(tail.len() <= 4);
        assert!(tail.ends_with('ل'));
    }

    #[test]
    fn an_early_or_failed_exit_logs_what_the_terminal_showed() {
        let early = exit_report("t1", Some(1), 800, "\u{1b}[31mError: session in use\u{1b}[0m\r\n");
        assert_eq!(early, "[verun][pty] t1 exited code=Some(1) after 800ms:\nError: session in use");
        let normal = exit_report("t2", Some(0), 600_000, "bye");
        assert_eq!(normal, "[verun][pty] t2 exited code=Some(0) after 600000ms");
        let crashed_late = exit_report("t3", Some(137), 600_000, "killed");
        assert!(crashed_late.ends_with(":\nkilled"));
    }
}
