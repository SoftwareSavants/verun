//! Pure attribution algorithm for the activity monitor.
//!
//! Splits a process snapshot of Verun's process tree into per-task subtrees
//! (rooted at each live session PID) plus an "app" bucket for everything else
//! still under the Verun root. `SysinfoSource` is the live `ProcessSource`
//! that drives this on real systems; `ResourceSampler` spawns the periodic
//! tokio loop that emits `resource_usage` Tauri events. The sampler is spawned
//! in `lib.rs` and exposed via `set_resource_monitor_overlay_open` and
//! `get_resource_usage_now` IPC commands.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStat {
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStat {
    pub task_id: String,
    pub task_name: String,
    pub branch: String,
    pub pid: u32,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub total: ProcessStat,
    pub app: ProcessStat,
    pub tasks: Vec<TaskStat>,
    pub sampled_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ProcRow {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

pub trait ProcessSource {
    fn snapshot(&mut self) -> Vec<ProcRow>;
}

/// Pure function: turn a process snapshot + ActiveMap data into a Sample.
/// `active` is `(task_id, session_pid)` pairs. Multiple sessions per task are summed.
/// Sessions whose `session_pid` is missing from the snapshot (process died) are dropped.
pub fn attribute(
    snapshot: &[ProcRow],
    verun_pid: u32,
    active: &[(String, u32)],
    task_labels: &HashMap<String, crate::db::TaskLabel>,
    sampled_at_ms: i64,
) -> Sample {
    let by_pid: HashMap<u32, &ProcRow> = snapshot.iter().map(|r| (r.pid, r)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in snapshot {
        if let Some(p) = r.parent_pid {
            children.entry(p).or_default().push(r.pid);
        }
    }

    let descendants_inclusive = |root: u32| -> HashSet<u32> {
        let mut seen = HashSet::new();
        let mut stack = vec![root];
        while let Some(p) = stack.pop() {
            if !seen.insert(p) { continue; }
            if let Some(kids) = children.get(&p) {
                for &k in kids { stack.push(k); }
            }
        }
        seen
    };

    let mut attributed: HashSet<u32> = HashSet::new();
    let mut task_totals: HashMap<String, (u32, u64, f32)> = HashMap::new();

    for (task_id, session_pid) in active {
        if !by_pid.contains_key(session_pid) { continue; }
        let subtree = descendants_inclusive(*session_pid);
        let mut subtree_rss = 0u64;
        let mut subtree_cpu = 0f32;
        for pid in &subtree {
            if attributed.insert(*pid) {
                if let Some(row) = by_pid.get(pid) {
                    subtree_rss += row.rss_bytes;
                    subtree_cpu += row.cpu_pct;
                }
            }
        }
        let entry = task_totals
            .entry(task_id.clone())
            .or_insert((*session_pid, 0, 0.0));
        entry.1 += subtree_rss;
        entry.2 += subtree_cpu;
    }

    let verun_subtree = descendants_inclusive(verun_pid);
    let mut app_rss = 0u64;
    let mut app_cpu = 0f32;
    for pid in &verun_subtree {
        if attributed.contains(pid) { continue; }
        if let Some(row) = by_pid.get(pid) {
            app_rss += row.rss_bytes;
            app_cpu += row.cpu_pct;
        }
    }

    let mut tasks: Vec<TaskStat> = task_totals
        .into_iter()
        .map(|(task_id, (pid, rss, cpu))| {
            let (task_name, branch) = task_labels
                .get(&task_id)
                .map(|l| (l.name.clone(), l.branch.clone()))
                .unwrap_or_else(|| ("(unknown)".into(), String::new()));
            TaskStat {
                task_id,
                task_name,
                branch,
                pid,
                rss_bytes: rss,
                cpu_pct: cpu,
            }
        })
        .collect();
    tasks.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes));

    let total_rss = app_rss + tasks.iter().map(|t| t.rss_bytes).sum::<u64>();
    let total_cpu = app_cpu + tasks.iter().map(|t| t.cpu_pct).sum::<f32>();

    Sample {
        total: ProcessStat { rss_bytes: total_rss, cpu_pct: total_cpu },
        app: ProcessStat { rss_bytes: app_rss, cpu_pct: app_cpu },
        tasks,
        sampled_at_ms,
    }
}

pub struct SysinfoSource {
    sys: sysinfo::System,
}

impl SysinfoSource {
    pub fn new() -> Self {
        let mut sys = sysinfo::System::new();
        // First refresh primes the CPU baseline; subsequent snapshots compute deltas.
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::new().with_cpu().with_memory(),
        );
        Self { sys }
    }
}

impl Default for SysinfoSource {
    fn default() -> Self { Self::new() }
}

impl ProcessSource for SysinfoSource {
    fn snapshot(&mut self) -> Vec<ProcRow> {
        self.sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::new().with_cpu().with_memory(),
        );
        self.sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcRow {
                pid: pid.as_u32(),
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                rss_bytes: p.memory(),
                cpu_pct: p.cpu_usage(),
            })
            .collect()
    }
}

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct ResourceSampler {
    cadence: Arc<AtomicU64>,
    notify: Arc<tokio::sync::Notify>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Collect every `(task_id, pid)` we own across the running session,
/// LSP, and PTY/terminal trees. Each pair becomes a subtree root that
/// `attribute()` rolls up under the task. Multiple pairs per task merge.
fn task_root_pids(
    active: &crate::task::ActiveMap,
    lsp_map: &crate::lsp::LspMap,
    pty_map: &crate::pty::ActivePtyMap,
) -> Vec<(String, u32)> {
    let mut out: Vec<(String, u32)> = active
        .iter()
        .filter_map(|entry| {
            entry
                .value()
                .child
                .id()
                .map(|pid| (entry.value().task_id.clone(), pid))
        })
        .collect();
    out.extend(crate::lsp::pids_for_tasks(lsp_map));
    out.extend(crate::pty::pids_for_tasks(pty_map));
    out
}

impl ResourceSampler {
    /// Production constructor: spawns the sampling loop on the tauri async
    /// runtime. The loop fetches task labels from the DB directly via
    /// `crate::db::task_labels_for_ids` each tick, so no sync/async bridge
    /// closure is needed.
    pub fn spawn<S>(
        app: tauri::AppHandle,
        active: crate::task::ActiveMap,
        lsp_map: crate::lsp::LspMap,
        pty_map: crate::pty::ActivePtyMap,
        mut source: S,
        pool: sqlx::sqlite::SqlitePool,
    ) -> Self
    where
        S: ProcessSource + Send + 'static,
    {
        let cadence = Arc::new(AtomicU64::new(2000));
        let notify = Arc::new(tokio::sync::Notify::new());
        let cadence_clone = cadence.clone();
        let notify_clone = notify.clone();

        let handle = tauri::async_runtime::spawn(async move {
            let verun_pid = std::process::id();
            loop {
                let active_pairs = task_root_pids(&active, &lsp_map, &pty_map);

                let task_ids: Vec<String> =
                    active_pairs.iter().map(|(t, _)| t.clone()).collect();
                let labels = crate::db::task_labels_for_ids(&pool, &task_ids)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("[resource_monitor] task_labels_for_ids failed: {e}");
                        std::collections::HashMap::new()
                    });

                let snap = source.snapshot();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);

                let sample = attribute(&snap, verun_pid, &active_pairs, &labels, now_ms);

                use tauri::Emitter;
                let _ = app.emit("resource_usage", &sample);

                let wait_ms = cadence_clone.load(Ordering::Relaxed);
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms)) => {}
                    _ = notify_clone.notified() => {}
                }
            }
        });

        Self {
            cadence,
            notify,
            handle: Some(handle),
        }
    }

    pub fn set_overlay_open(&self, open: bool) {
        self.cadence
            .store(if open { 1000 } else { 2000 }, Ordering::Relaxed);
        self.notify.notify_one();
    }

    #[allow(dead_code)] // wired into IPC in a later phase
    pub fn cadence_ms(&self) -> u64 {
        self.cadence.load(Ordering::Relaxed)
    }

    /// Build a sampler without spawning the loop. Used only by unit tests
    /// that exercise cadence switching.
    #[cfg(test)]
    pub fn new_for_test() -> Self {
        Self {
            cadence: Arc::new(AtomicU64::new(2000)),
            notify: Arc::new(tokio::sync::Notify::new()),
            handle: None,
        }
    }
}

impl Drop for ResourceSampler {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

/// On-demand sample for the IPC `get_resource_usage_now` command. Used so the
/// overlay's first paint isn't blank for up to one tick.
///
/// Builds its own short-lived `SysinfoSource` (does NOT reuse the live sampler's),
/// awaits 100 ms between two refreshes so CPU% has a delta, then runs `attribute`.
/// Awaits the DB lookup for task names inline, returning a future that completes
/// once the sample is ready.
pub async fn sample_now(
    active: &crate::task::ActiveMap,
    lsp_map: &crate::lsp::LspMap,
    pty_map: &crate::pty::ActivePtyMap,
    pool: &sqlx::sqlite::SqlitePool,
) -> Sample {
    // SysinfoSource::new() already primes the CPU baseline; wait the
    // minimum interval before the second refresh so CPU% has a delta.
    let mut src = SysinfoSource::new();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let snap = src.snapshot();

    let active_pairs = task_root_pids(active, lsp_map, pty_map);
    let task_ids: Vec<String> = active_pairs.iter().map(|(t, _)| t.clone()).collect();
    let labels = crate::db::task_labels_for_ids(pool, &task_ids)
        .await
        .unwrap_or_else(|e| {
            eprintln!("[resource_monitor] task_labels_for_ids failed: {e}");
            std::collections::HashMap::new()
        });

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    attribute(&snap, std::process::id(), &active_pairs, &labels, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, parent: Option<u32>, rss: u64, cpu: f32) -> ProcRow {
        ProcRow { pid, parent_pid: parent, rss_bytes: rss, cpu_pct: cpu }
    }

    fn labels(pairs: &[(&str, &str, &str)]) -> HashMap<String, crate::db::TaskLabel> {
        pairs
            .iter()
            .map(|(id, name, branch)| {
                (
                    id.to_string(),
                    crate::db::TaskLabel {
                        name: name.to_string(),
                        branch: branch.to_string(),
                    },
                )
            })
            .collect()
    }

    /// Tree:
    ///   1 = Verun (rss=100, cpu=1)
    ///   ├ 2 = watcher (rss=20, cpu=0.5)        // not a session => Verun (app)
    ///   ├ 3 = session A (rss=200, cpu=10)      // task "ta"
    ///   │   └ 4 = mcp tool (rss=50, cpu=2)
    ///   └ 5 = session B (rss=300, cpu=20)      // task "tb"
    #[test]
    fn rolls_up_session_subtrees_and_excludes_them_from_app() {
        let snap = vec![
            row(1, None, 100, 1.0),
            row(2, Some(1), 20, 0.5),
            row(3, Some(1), 200, 10.0),
            row(4, Some(3), 50, 2.0),
            row(5, Some(1), 300, 20.0),
        ];
        let active = vec![("ta".into(), 3), ("tb".into(), 5)];
        let labels = labels(&[("ta", "Task A", "branch-a"), ("tb", "Task B", "branch-b")]);

        let s = attribute(&snap, 1, &active, &labels, 42);

        assert_eq!(s.app.rss_bytes, 100 + 20);
        assert!((s.app.cpu_pct - 1.5).abs() < 1e-3);

        let task_a = s.tasks.iter().find(|t| t.task_id == "ta").unwrap();
        assert_eq!(task_a.rss_bytes, 200 + 50);
        assert!((task_a.cpu_pct - 12.0).abs() < 1e-3);
        assert_eq!(task_a.branch, "branch-a");

        let task_b = s.tasks.iter().find(|t| t.task_id == "tb").unwrap();
        assert_eq!(task_b.rss_bytes, 300);
        assert_eq!(task_b.branch, "branch-b");

        assert_eq!(s.total.rss_bytes, 100 + 20 + 200 + 50 + 300);
        assert_eq!(s.sampled_at_ms, 42);
    }

    #[test]
    fn dead_session_pid_is_excluded() {
        let snap = vec![row(1, None, 100, 0.0)];
        let active = vec![("ta".into(), 999)];
        let labels = labels(&[("ta", "Task A", "branch-a")]);

        let s = attribute(&snap, 1, &active, &labels, 0);

        assert_eq!(s.tasks.len(), 0);
        assert_eq!(s.app.rss_bytes, 100);
        assert_eq!(s.total.rss_bytes, 100);
    }

    #[test]
    fn multiple_sessions_for_one_task_are_summed() {
        let snap = vec![
            row(1, None, 0, 0.0),
            row(10, Some(1), 100, 5.0),
            row(11, Some(1), 200, 10.0),
        ];
        let active = vec![("ta".into(), 10), ("ta".into(), 11)];
        let labels = labels(&[("ta", "Task A", "branch-a")]);

        let s = attribute(&snap, 1, &active, &labels, 0);

        assert_eq!(s.tasks.len(), 1);
        assert_eq!(s.tasks[0].rss_bytes, 300);
        assert!((s.tasks[0].cpu_pct - 15.0).abs() < 1e-3);
    }

    #[test]
    fn empty_active_map_yields_no_tasks_and_total_eq_app() {
        let snap = vec![row(1, None, 100, 5.0), row(2, Some(1), 50, 1.0)];
        let labels = HashMap::new();

        let s = attribute(&snap, 1, &[], &labels, 0);

        assert!(s.tasks.is_empty());
        assert_eq!(s.app.rss_bytes, 150);
        assert_eq!(s.total.rss_bytes, 150);
    }

    #[test]
    fn tasks_sorted_by_rss_desc() {
        let snap = vec![
            row(1, None, 0, 0.0),
            row(10, Some(1), 100, 0.0),
            row(20, Some(1), 500, 0.0),
            row(30, Some(1), 250, 0.0),
        ];
        let active = vec![
            ("small".into(), 10),
            ("big".into(), 20),
            ("mid".into(), 30),
        ];
        let labels = labels(&[
            ("small", "S", "br-s"),
            ("big", "B", "br-b"),
            ("mid", "M", "br-m"),
        ]);

        let s = attribute(&snap, 1, &active, &labels, 0);

        let ids: Vec<_> = s.tasks.iter().map(|t| t.task_id.as_str()).collect();
        assert_eq!(ids, vec!["big", "mid", "small"]);
    }

    #[test]
    fn unknown_task_id_falls_back_to_placeholder_name_and_empty_branch() {
        let snap = vec![row(1, None, 0, 0.0), row(2, Some(1), 10, 0.0)];
        let active = vec![("unknown_id".into(), 2)];
        let labels = HashMap::new();

        let s = attribute(&snap, 1, &active, &labels, 0);

        assert_eq!(s.tasks.len(), 1);
        assert_eq!(s.tasks[0].task_name, "(unknown)");
        assert_eq!(s.tasks[0].branch, "");
    }

    #[test]
    fn sysinfo_source_returns_self_pid() {
        let mut src = SysinfoSource::new();
        let snap = src.snapshot();
        let self_pid = std::process::id();
        let me = snap.iter().find(|r| r.pid == self_pid)
            .expect("self process must be in the snapshot");
        assert!(me.rss_bytes > 0, "self process RSS should be > 0");
    }

    #[test]
    fn sampler_cadence_defaults_to_idle() {
        let s = ResourceSampler::new_for_test();
        assert_eq!(s.cadence_ms(), 2000);
    }

    #[test]
    fn sampler_cadence_switches_on_overlay_open() {
        let s = ResourceSampler::new_for_test();
        s.set_overlay_open(true);
        assert_eq!(s.cadence_ms(), 1000);
        s.set_overlay_open(false);
        assert_eq!(s.cadence_ms(), 2000);
    }
}
