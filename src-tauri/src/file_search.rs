use dashmap::DashMap;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

// Mirrors TsgoCheckHandle: flip cancelled, abort the tokio task, background
// walker/sink threads observe the flag and wind down.
pub struct SearchHandle {
    cancelled: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

pub type SearchMap = Arc<DashMap<String, SearchHandle>>;

pub fn new_search_map() -> SearchMap {
    Arc::new(DashMap::new())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOpts {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line_number: u64,
    pub line_text: String,
    pub match_spans: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultEvent {
    task_id: String,
    matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDoneEvent {
    task_id: String,
    duration_ms: u64,
    total_matches: u32,
    total_files: u32,
    truncated: bool,
}

// Keep the UI fast: one batched event per tick, bounded payload, bounded walk.
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const MAX_BATCH: usize = 200;
const MAX_TOTAL_MATCHES: u32 = 1000;
const MAX_TOTAL_FILES: u32 = 500;
const MAX_MATCHES_PER_FILE: u32 = 50;
// Cap line text so a minified bundle match doesn't send MBs over IPC.
const MAX_LINE_LEN: usize = 400;

pub async fn start(
    map: SearchMap,
    app: AppHandle,
    task_id: String,
    worktree_path: String,
    query: String,
    opts: SearchOpts,
) -> Result<(), String> {
    // Cancel previous run first so any in-flight emit hits the flag before
    // a stale chunk paints on top of the new query.
    if let Some((_, prev)) = map.remove(&task_id) {
        prev.cancelled.store(true, Ordering::Relaxed);
        prev.join.abort();
    }

    if query.len() < 2 {
        // Too-short queries would walk the world for no signal — silently
        // finish with empty results so the UI clears cleanly.
        let _ = app.emit(
            "workspace-search-done",
            SearchDoneEvent {
                task_id: task_id.clone(),
                duration_ms: 0,
                total_matches: 0,
                total_files: 0,
                truncated: false,
            },
        );
        return Ok(());
    }

    let matcher = build_matcher(&query, &opts)?;

    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = Arc::clone(&cancelled);
    let tid = task_id.clone();
    let app_for_task = app.clone();

    let join = tokio::spawn(async move {
        let started = Instant::now();
        let worktree = PathBuf::from(&worktree_path);
        let total_matches = Arc::new(AtomicU32::new(0));
        let total_files = Arc::new(AtomicU32::new(0));
        let truncated = Arc::new(AtomicBool::new(false));

        let blocking_cancelled = Arc::clone(&task_cancelled);
        let blocking_app = app_for_task.clone();
        let blocking_tid = tid.clone();
        let blocking_worktree = worktree.clone();
        let blocking_matcher = matcher.clone();
        let blocking_opts = opts.clone();
        let blocking_matches = Arc::clone(&total_matches);
        let blocking_files = Arc::clone(&total_files);
        let blocking_truncated = Arc::clone(&truncated);

        let blocking = tokio::task::spawn_blocking(move || {
            run_walker(
                blocking_app,
                blocking_tid,
                blocking_worktree,
                blocking_matcher,
                blocking_opts,
                blocking_cancelled,
                blocking_matches,
                blocking_files,
                blocking_truncated,
            );
        });

        let _ = blocking.await;

        if task_cancelled.load(Ordering::Relaxed) {
            return;
        }

        let _ = app_for_task.emit(
            "workspace-search-done",
            SearchDoneEvent {
                task_id: tid,
                duration_ms: started.elapsed().as_millis() as u64,
                total_matches: total_matches.load(Ordering::Relaxed),
                total_files: total_files.load(Ordering::Relaxed),
                truncated: truncated.load(Ordering::Relaxed),
            },
        );
    });

    map.insert(task_id, SearchHandle { cancelled, join });
    Ok(())
}

pub fn cancel(map: &SearchMap, task_id: &str) {
    if let Some((_, prev)) = map.remove(task_id) {
        prev.cancelled.store(true, Ordering::Relaxed);
        prev.join.abort();
    }
}

fn build_matcher(query: &str, opts: &SearchOpts) -> Result<RegexMatcher, String> {
    let mut pattern = if opts.regex {
        query.to_string()
    } else {
        regex_escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .build(&pattern)
        .map_err(|e| format!("Invalid regex: {e}"))
}

// Hand-rolled escape — grep-regex re-exports `regex` internally but not its
// `escape` helper, and pulling the full `regex` crate just for one function
// isn't worth the compile time.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
            | '#' | '&' | '-' | '~' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn run_walker(
    app: AppHandle,
    task_id: String,
    worktree: PathBuf,
    matcher: RegexMatcher,
    opts: SearchOpts,
    cancelled: Arc<AtomicBool>,
    total_matches: Arc<AtomicU32>,
    total_files: Arc<AtomicU32>,
    truncated: Arc<AtomicBool>,
) {
    let (tx, rx) = mpsc::channel::<SearchMatch>();

    // Batcher thread: flush every FLUSH_INTERVAL or MAX_BATCH, whichever hits
    // first. Mirrors stream.rs flush_buffer cadence so the UI animates
    // smoothly instead of getting one event per match.
    let batcher_cancelled = Arc::clone(&cancelled);
    let batcher_app = app.clone();
    let batcher_tid = task_id.clone();
    let batcher = std::thread::spawn(move || {
        let mut buf: Vec<SearchMatch> = Vec::new();
        let mut last_flush = Instant::now();
        loop {
            let remaining = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
            let timeout = if remaining.is_zero() {
                Duration::from_millis(1)
            } else {
                remaining
            };
            match rx.recv_timeout(timeout) {
                Ok(m) => {
                    buf.push(m);
                    if buf.len() >= MAX_BATCH {
                        flush(&batcher_app, &batcher_tid, &mut buf, &batcher_cancelled);
                        last_flush = Instant::now();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    flush(&batcher_app, &batcher_tid, &mut buf, &batcher_cancelled);
                    last_flush = Instant::now();
                }
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&batcher_app, &batcher_tid, &mut buf, &batcher_cancelled);
                    break;
                }
            }
        }
    });

    // Overrides: includes as allow-patterns, excludes as deny-patterns (ignore
    // crate takes a `!` prefix for negation, same shape as .gitignore).
    let overrides = {
        let mut ob = OverrideBuilder::new(&worktree);
        for inc in &opts.includes {
            let trimmed = inc.trim();
            if !trimmed.is_empty() {
                let _ = ob.add(trimmed);
            }
        }
        for exc in &opts.excludes {
            let trimmed = exc.trim();
            if !trimmed.is_empty() {
                let _ = ob.add(&format!("!{trimmed}"));
            }
        }
        ob.build().ok()
    };

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);

    let mut builder = WalkBuilder::new(&worktree);
    builder
        .threads(threads)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .hidden(true);
    if let Some(ov) = overrides {
        builder.overrides(ov);
    }
    let walker = builder.build_parallel();

    walker.run(|| {
        let tx = tx.clone();
        let matcher = matcher.clone();
        let cancelled = Arc::clone(&cancelled);
        let worktree = worktree.clone();
        let total_matches = Arc::clone(&total_matches);
        let total_files = Arc::clone(&total_files);
        let truncated = Arc::clone(&truncated);
        let mut searcher: Searcher = SearcherBuilder::new().line_number(true).build();

        Box::new(move |result| {
            if cancelled.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let entry = match result {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }

            if total_files.load(Ordering::Relaxed) >= MAX_TOTAL_FILES
                || total_matches.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES
            {
                truncated.store(true, Ordering::Relaxed);
                cancelled.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let path = entry.path();
            let rel = path
                .strip_prefix(&worktree)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();

            let mut sink = MatchSink {
                path: rel,
                matcher: &matcher,
                tx: &tx,
                cancelled: Arc::clone(&cancelled),
                total_matches: Arc::clone(&total_matches),
                truncated: Arc::clone(&truncated),
                per_file_count: 0,
                produced_match: false,
            };
            let _ = searcher.search_path(&matcher, path, &mut sink);
            if sink.produced_match {
                total_files.fetch_add(1, Ordering::Relaxed);
            }
            WalkState::Continue
        })
    });

    drop(tx);
    let _ = batcher.join();
}

fn flush(app: &AppHandle, task_id: &str, buf: &mut Vec<SearchMatch>, cancelled: &AtomicBool) {
    if buf.is_empty() {
        return;
    }
    if cancelled.load(Ordering::Relaxed) {
        buf.clear();
        return;
    }
    let _ = app.emit(
        "workspace-search-result",
        SearchResultEvent {
            task_id: task_id.to_string(),
            matches: std::mem::take(buf),
        },
    );
}

struct MatchSink<'a> {
    path: String,
    matcher: &'a RegexMatcher,
    tx: &'a mpsc::Sender<SearchMatch>,
    cancelled: Arc<AtomicBool>,
    total_matches: Arc<AtomicU32>,
    truncated: Arc<AtomicBool>,
    per_file_count: u32,
    produced_match: bool,
}

impl<'a> Sink for MatchSink<'a> {
    type Error = std::io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch) -> Result<bool, std::io::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }

        let prev = self.total_matches.fetch_add(1, Ordering::Relaxed);
        if prev + 1 >= MAX_TOTAL_MATCHES {
            self.truncated.store(true, Ordering::Relaxed);
            self.cancelled.store(true, Ordering::Relaxed);
        }

        let bytes = mat.bytes();
        let line_text = String::from_utf8_lossy(bytes);
        let trimmed = line_text.trim_end_matches(['\r', '\n']);
        let (short, _truncated_line) = truncate_line(trimmed, MAX_LINE_LEN);

        let mut spans: Vec<(u32, u32)> = Vec::new();
        let _ = self.matcher.find_iter(bytes, |m| {
            let start = m.start().min(short.len());
            let end = m.end().min(short.len());
            if end > start {
                spans.push((start as u32, end as u32));
            }
            true
        });

        let out = SearchMatch {
            path: self.path.clone(),
            line_number: mat.line_number().unwrap_or(0),
            line_text: short,
            match_spans: spans,
        };

        if self.tx.send(out).is_err() {
            return Ok(false);
        }
        self.produced_match = true;
        self.per_file_count = self.per_file_count.saturating_add(1);
        if self.per_file_count >= MAX_MATCHES_PER_FILE {
            return Ok(false);
        }
        Ok(true)
    }
}

// Truncate on char boundary so we never slice mid-codepoint. Returns the
// shortened string and whether truncation happened.
fn truncate_line(s: &str, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_handles_regex_metachars() {
        assert_eq!(regex_escape("a.b*c"), r"a\.b\*c");
        assert_eq!(regex_escape("(x)"), r"\(x\)");
        assert_eq!(regex_escape("plain"), "plain");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let (s, t) = truncate_line("héllo world", 5);
        assert!(t);
        assert!(s.is_char_boundary(s.len()));
        assert!(s.len() <= 5);
    }

    #[test]
    fn build_matcher_literal_is_case_insensitive_by_default() {
        let m = build_matcher(
            "TODO",
            &SearchOpts {
                ..Default::default()
            },
        )
        .unwrap();
        assert!(m.is_match(b"todo").unwrap());
        assert!(m.is_match(b"TODO").unwrap());
    }

    #[test]
    fn build_matcher_case_sensitive() {
        let m = build_matcher(
            "TODO",
            &SearchOpts {
                case_sensitive: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!m.is_match(b"todo").unwrap());
        assert!(m.is_match(b"TODO").unwrap());
    }

    #[test]
    fn build_matcher_whole_word() {
        let m = build_matcher(
            "todo",
            &SearchOpts {
                whole_word: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(m.is_match(b"a todo here").unwrap());
        assert!(!m.is_match(b"todolist").unwrap());
    }

    #[test]
    fn build_matcher_regex_mode_accepts_metachars() {
        let m = build_matcher(
            r"to\w+",
            &SearchOpts {
                regex: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(m.is_match(b"token here").unwrap());
    }

    #[test]
    fn build_matcher_literal_does_not_treat_metachars_as_regex() {
        let m = build_matcher(
            "a.b",
            &SearchOpts {
                case_sensitive: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(m.is_match(b"a.b").unwrap());
        assert!(!m.is_match(b"aXb").unwrap());
    }

    #[test]
    fn search_end_to_end_finds_matches_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.txt"), "hello WORLD\nsecond line\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "nothing interesting\n").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "hello WORLD\n").unwrap();

        let matcher = build_matcher("WORLD", &SearchOpts::default()).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let total_matches = Arc::new(AtomicU32::new(0));
        let total_files = Arc::new(AtomicU32::new(0));
        let truncated = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<SearchMatch>();

        let worktree = dir.path().to_path_buf();
        let walker_matcher = matcher.clone();
        let walker_cancelled = Arc::clone(&cancelled);
        let walker_total_matches = Arc::clone(&total_matches);
        let walker_total_files = Arc::clone(&total_files);
        let walker_truncated = Arc::clone(&truncated);

        let mut builder = WalkBuilder::new(&worktree);
        builder
            .threads(1)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(false)
            .hidden(true)
            .require_git(false);
        let walker = builder.build_parallel();

        walker.run(|| {
            let tx = tx.clone();
            let matcher = walker_matcher.clone();
            let cancelled = Arc::clone(&walker_cancelled);
            let total_matches = Arc::clone(&walker_total_matches);
            let total_files = Arc::clone(&walker_total_files);
            let truncated = Arc::clone(&walker_truncated);
            let worktree = worktree.clone();
            let mut searcher: Searcher = SearcherBuilder::new().line_number(true).build();
            Box::new(move |result| {
                let Ok(entry) = result else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let path = entry.path();
                let rel = path
                    .strip_prefix(&worktree)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned();
                let mut sink = MatchSink {
                    path: rel,
                    matcher: &matcher,
                    tx: &tx,
                    cancelled: Arc::clone(&cancelled),
                    total_matches: Arc::clone(&total_matches),
                    truncated: Arc::clone(&truncated),
                    per_file_count: 0,
                    produced_match: false,
                };
                let _ = searcher.search_path(&matcher, path, &mut sink);
                if sink.produced_match {
                    total_files.fetch_add(1, Ordering::Relaxed);
                }
                WalkState::Continue
            })
        });
        drop(tx);

        let mut found: Vec<SearchMatch> = rx.iter().collect();
        found.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(found.len(), 1, "gitignored file must not be searched");
        assert_eq!(found[0].path, "keep.txt");
        assert_eq!(found[0].line_number, 1);
        assert!(!found[0].match_spans.is_empty());
        assert_eq!(total_files.load(Ordering::Relaxed), 1);
    }
}
