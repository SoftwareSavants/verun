use dashmap::DashMap;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

// Bound concurrent tsgo subprocesses per task. On a 14-tsconfig monorepo
// each subprocess can briefly hold ~300 MB during its type-check pass, so
// running them all in parallel would spike memory for a few seconds. Four is
// enough to keep wall-clock reasonable without the stampede.
const MAX_CONCURRENT_CHECKS: usize = 4;

// Directories skipped while walking the worktree for tsconfig.json files.
// Build output and vendor dirs add noise without useful diagnostics.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    "target",
    ".cache",
    "out",
];

// One in-flight typecheck per task. Subsequent runs flip the previous run's
// cancelled flag to true and abort its JoinHandle — the aborted task drops
// each owned Child, and `kill_on_drop(true)` terminates the subprocesses.
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

/// Walk a worktree and collect every `tsconfig.json` — returned as paths
/// relative to `worktree` so tsgo's per-invocation cwd produces relative
/// diagnostic paths that Verun can resolve back to real files.
fn discover_tsconfigs(worktree: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    walk(worktree, worktree, &mut result);
    result
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // Skip build output, vendor dirs, and dotdirs in general (.git,
            // .claude, .vscode, etc. — none house TypeScript projects we care
            // about).
            if name.starts_with('.') || SKIP_DIRS.contains(&name) {
                continue;
            }
            walk(base, &path, out);
        } else if file_type.is_file() && name == "tsconfig.json" {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_path_buf());
            }
        }
    }
}

/// Spawn one `tsgo --noEmit --pretty false -p <tsconfig>` invocation and
/// parse its stdout. Failures produce an empty vec — a single project's
/// failure shouldn't tank the whole aggregated check.
async fn run_single(
    binary: &Path,
    worktree: &Path,
    tsconfig_rel: &Path,
) -> Vec<TsgoProblem> {
    let mut child = match Command::new(binary)
        .arg("--noEmit")
        .arg("--pretty")
        .arg("false")
        .arg("-p")
        .arg(tsconfig_rel)
        .current_dir(worktree)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[tsgo_check] failed to spawn for {tsconfig_rel:?}: {e}");
            return Vec::new();
        }
    };

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => return Vec::new(),
    };
    let mut buf = Vec::new();
    let _ = stdout.read_to_end(&mut buf).await;
    let _ = child.wait().await;
    parse_tsc_output(&String::from_utf8_lossy(&buf))
}

pub async fn run_check(
    map: &TsgoCheckMap,
    app: AppHandle,
    binary: PathBuf,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    // Cancel any previous run for this task. We flip the flag first so a
    // run that's mid-emit aborts before a stale result lands on the panel.
    if let Some((_, prev)) = map.remove(&task_id) {
        prev.cancelled.store(true, Ordering::Relaxed);
        prev.join.abort();
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = Arc::clone(&cancelled);
    let tid = task_id.clone();
    let started = std::time::Instant::now();

    let join = tokio::spawn(async move {
        let worktree = PathBuf::from(&worktree_path);
        let tsconfigs = discover_tsconfigs(&worktree);

        // No tsconfigs in the worktree → nothing to typecheck. Emit an
        // empty successful result so the Problems panel clears its loading
        // state instead of spinning forever.
        if tsconfigs.is_empty() {
            if task_cancelled.load(Ordering::Relaxed) {
                return;
            }
            let _ = app.emit(
                "tsgo-check-result",
                TsgoCheckResult {
                    task_id: tid,
                    problems: Vec::new(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    ok: true,
                },
            );
            return;
        }

        let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_CHECKS));
        let mut set: JoinSet<Vec<TsgoProblem>> = JoinSet::new();

        for tsconfig in tsconfigs {
            let binary = binary.clone();
            let worktree = worktree.clone();
            let sem = Arc::clone(&semaphore);
            let cancel_flag = Arc::clone(&task_cancelled);
            set.spawn(async move {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Vec::new();
                }
                let _permit = match sem.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return Vec::new(),
                };
                if cancel_flag.load(Ordering::Relaxed) {
                    return Vec::new();
                }
                run_single(&binary, &worktree, &tsconfig).await
            });
        }

        let mut all: Vec<TsgoProblem> = Vec::new();
        while let Some(result) = set.join_next().await {
            if task_cancelled.load(Ordering::Relaxed) {
                set.shutdown().await;
                return;
            }
            if let Ok(mut problems) = result {
                all.append(&mut problems);
            }
        }

        // Dedupe — two overlapping tsconfigs can report the same error on
        // the same file. Sort first, then collapse adjacent duplicates.
        all.sort_by(|a, b| {
            (
                a.file.as_str(),
                a.line,
                a.column,
                a.severity.as_str(),
                a.code.as_str(),
                a.message.as_str(),
            )
                .cmp(&(
                    b.file.as_str(),
                    b.line,
                    b.column,
                    b.severity.as_str(),
                    b.code.as_str(),
                    b.message.as_str(),
                ))
        });
        all.dedup_by(|a, b| {
            a.file == b.file
                && a.line == b.line
                && a.column == b.column
                && a.severity == b.severity
                && a.code == b.code
                && a.message == b.message
        });

        if task_cancelled.load(Ordering::Relaxed) {
            return;
        }
        let _ = app.emit(
            "tsgo-check-result",
            TsgoCheckResult {
                task_id: tid,
                problems: all,
                duration_ms: started.elapsed().as_millis() as u64,
                ok: true,
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

    #[test]
    fn discover_tsconfigs_skips_node_modules_and_hidden() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("tsgo_check_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(tmp.join("packages/ui")).unwrap();
        fs::write(tmp.join("packages/ui/tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(tmp.join("node_modules/foo")).unwrap();
        fs::write(tmp.join("node_modules/foo/tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(tmp.join(".next/types")).unwrap();
        fs::write(tmp.join(".next/types/tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(tmp.join("dist")).unwrap();
        fs::write(tmp.join("dist/tsconfig.json"), "{}").unwrap();

        let mut found = discover_tsconfigs(&tmp);
        found.sort();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], PathBuf::from("packages/ui/tsconfig.json"));
        assert_eq!(found[1], PathBuf::from("tsconfig.json"));

        fs::remove_dir_all(&tmp).unwrap();
    }
}
