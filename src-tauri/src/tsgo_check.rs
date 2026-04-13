use dashmap::DashMap;
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;

// One in-flight typecheck per task. Subsequent runs flip the previous run's
// cancelled flag to true and abort its JoinHandle — the aborted task drops
// its owned Child, and `kill_on_drop(true)` terminates the subprocess.
//
// The cancelled flag is created BEFORE spawning so the background task has
// its own Arc clone from the start. That avoids a race where a fast-failing
// subprocess could reach the "am I still current?" check before run_check
// had finished inserting the handle into the map.
pub struct TsgoCheckHandle {
    cancelled: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

pub type TsgoCheckMap = Arc<DashMap<String, TsgoCheckHandle>>;

pub fn new_tsgo_check_map() -> TsgoCheckMap {
    Arc::new(DashMap::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsgoProblem {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsgoCheckResult {
    pub task_id: String,
    pub problems: Vec<TsgoProblem>,
    pub duration_ms: u64,
    pub ok: bool,
}

/// Parse a single line of `tsc --pretty false` output.
///
/// Format: `path/to/file.ts(line,col): error TS####: message`
///
/// Returns None for continuation lines, blank lines, and any line that
/// doesn't match the shape — those are safely ignored.
fn parse_tsc_line(line: &str) -> Option<TsgoProblem> {
    // Find "):" (end of the line/col coordinate block) and the matching "("
    // before it. We scan for "(" from the right of `close_idx` so paths that
    // contain "(" themselves (Next.js routing groups: app/(home)/page.tsx)
    // don't confuse us.
    let close_idx = line.find("):")?;
    let coords_open = line[..close_idx].rfind('(')?;
    let coords = &line[coords_open + 1..close_idx];
    let (line_str, col_str) = coords.split_once(',')?;
    let line_num: u32 = line_str.parse().ok()?;
    let col_num: u32 = col_str.parse().ok()?;

    let path = line[..coords_open].trim().to_string();
    if path.is_empty() {
        return None;
    }

    let rest = line[close_idx + 2..].trim_start();
    let (severity, after_severity) = if let Some(r) = rest.strip_prefix("error ") {
        ("error", r)
    } else if let Some(r) = rest.strip_prefix("warning ") {
        ("warning", r)
    } else if let Some(r) = rest.strip_prefix("info ") {
        ("info", r)
    } else {
        return None;
    };

    let (code, message) = after_severity.split_once(": ")?;
    Some(TsgoProblem {
        file: path,
        line: line_num,
        column: col_num,
        severity: severity.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    })
}

fn parse_tsc_output(output: &str) -> Vec<TsgoProblem> {
    output.lines().filter_map(parse_tsc_line).collect()
}

pub async fn run_check(
    map: &TsgoCheckMap,
    app: AppHandle,
    binary: std::path::PathBuf,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    // Cancel any previous run for this task before starting a new one. We
    // flip the previous run's flag first so that if it happens to be mid-emit
    // right now, the abort-at-next-await arrives before a stale result lands
    // on the Problems panel.
    if let Some((_, prev)) = map.remove(&task_id) {
        prev.cancelled.store(true, Ordering::Relaxed);
        prev.join.abort();
    }

    // The cancelled flag is created BEFORE spawn so the background task
    // owns its own clone from the start. Inserting into the map after spawn
    // is therefore race-free — the task never looks in the map.
    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = Arc::clone(&cancelled);

    let mut child = Command::new(&binary)
        .arg("--noEmit")
        .arg("--pretty")
        .arg("false")
        .current_dir(&worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn tsgo check: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture tsgo check stdout")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture tsgo check stderr")?;

    let tid = task_id.clone();
    let started = std::time::Instant::now();

    let join = tokio::spawn(async move {
        // Child is owned by this task — no mutex anywhere. Drain both
        // streams concurrently so a verbose stderr can't starve stdout.
        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();
        let (_, _) = tokio::join!(
            stdout.read_to_end(&mut stdout_buf),
            stderr.read_to_end(&mut stderr_buf),
        );
        let exit = child.wait().await;

        // Cancellation is cooperative in tokio: `abort()` delivers at the
        // next await, so a mid-emit task may still complete its emit after
        // being cancelled. Check the flag and drop the result ourselves.
        if task_cancelled.load(Ordering::Relaxed) {
            return;
        }

        let output = String::from_utf8_lossy(&stdout_buf);
        let problems = parse_tsc_output(&output);

        // tsc/tsgo exits with 0 (no errors) or 2 (errors found). Anything
        // else means a fatal failure — a missing binary, a panic, or being
        // killed. Surface that via `ok: false` and log stderr so the Rust
        // console has something to look at during debugging.
        let ok = exit
            .as_ref()
            .map(|status| matches!(status.code(), Some(0) | Some(2)))
            .unwrap_or(false);
        if !ok {
            let stderr_str = String::from_utf8_lossy(&stderr_buf);
            let trimmed = stderr_str.trim();
            if !trimmed.is_empty() {
                eprintln!("[tsgo_check] task={tid} failed: {trimmed}");
            } else if let Ok(status) = exit {
                eprintln!("[tsgo_check] task={tid} failed with status {status}");
            }
        }

        let _ = app.emit(
            "tsgo-check-result",
            TsgoCheckResult {
                task_id: tid,
                problems,
                duration_ms: started.elapsed().as_millis() as u64,
                ok,
            },
        );
    });

    map.insert(task_id, TsgoCheckHandle { cancelled, join });
    Ok(())
}

pub fn cancel(map: &TsgoCheckMap, task_id: &str) {
    if let Some((_, handle)) = map.remove(task_id) {
        handle.cancelled.store(true, Ordering::Relaxed);
        handle.join.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_error() {
        let p = parse_tsc_line("src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.").unwrap();
        assert_eq!(p.file, "src/foo.ts");
        assert_eq!(p.line, 10);
        assert_eq!(p.column, 5);
        assert_eq!(p.severity, "error");
        assert_eq!(p.code, "TS2322");
        assert_eq!(p.message, "Type 'string' is not assignable to type 'number'.");
    }

    #[test]
    fn parses_path_with_parentheses() {
        // Next.js routing groups put literal parens in paths.
        let p = parse_tsc_line(
            "apps/fumadocs/src/app/(home)/layout.tsx(3,29): error TS2307: Cannot find module '@/lib/layout.shared' or its corresponding type declarations.",
        )
        .unwrap();
        assert_eq!(p.file, "apps/fumadocs/src/app/(home)/layout.tsx");
        assert_eq!(p.line, 3);
        assert_eq!(p.column, 29);
        assert_eq!(p.code, "TS2307");
    }

    #[test]
    fn parses_path_with_brackets() {
        let p = parse_tsc_line(
            "apps/fumadocs/src/app/docs/[[...slug]]/page.tsx(13,34): error TS2307: Cannot find module.",
        )
        .unwrap();
        assert_eq!(p.file, "apps/fumadocs/src/app/docs/[[...slug]]/page.tsx");
        assert_eq!(p.line, 13);
    }

    #[test]
    fn ignores_continuation_and_blank_lines() {
        assert!(parse_tsc_line("").is_none());
        assert!(parse_tsc_line("  type X = string").is_none());
        assert!(parse_tsc_line("    ~~~~~~").is_none());
        assert!(parse_tsc_line("Found 5 errors in 2 files.").is_none());
    }

    #[test]
    fn parses_multiple_lines_into_vec() {
        let out = "src/a.ts(1,1): error TS1: bad
src/b.ts(2,2): error TS2: also bad
random noise line
src/c.ts(3,3): error TS3: still bad
";
        let v = parse_tsc_output(out);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].file, "src/a.ts");
        assert_eq!(v[1].file, "src/b.ts");
        assert_eq!(v[2].file, "src/c.ts");
    }
}
