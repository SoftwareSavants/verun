//! Pure attribution algorithm for the activity monitor.
//!
//! Splits a process snapshot of Verun's process tree into per-task subtrees
//! (rooted at each live session PID) plus an "app" bucket for everything else
//! still under the Verun root. The `SysinfoSource` and `ResourceSampler` that
//! feed and drive this module land in subsequent tasks; until then the public
//! surface carries `#[allow(dead_code)]`.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[allow(dead_code)] // wired in by the resource sampler in a later phase
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProcessStat {
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[allow(dead_code)] // wired in by the resource sampler in a later phase
#[derive(Debug, Clone, Serialize)]
pub struct TaskStat {
    pub task_id: String,
    pub task_name: String,
    pub pid: u32,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[allow(dead_code)] // wired in by the resource sampler in a later phase
#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub total: ProcessStat,
    pub app: ProcessStat,
    pub tasks: Vec<TaskStat>,
    pub sampled_at_ms: i64,
}

#[allow(dead_code)] // produced by sysinfo source / consumed by attribute() in a later phase
#[derive(Debug, Clone)]
pub struct ProcRow {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[allow(dead_code)] // implemented by SysinfoSource in a later phase
pub trait ProcessSource {
    fn snapshot(&mut self) -> Vec<ProcRow>;
}

/// Pure function: turn a process snapshot + ActiveMap data into a Sample.
/// `active` is `(task_id, session_pid)` pairs. Multiple sessions per task are summed.
/// Sessions whose `session_pid` is missing from the snapshot (process died) are dropped.
#[allow(dead_code)] // wired in by the resource sampler in a later phase
pub fn attribute(
    snapshot: &[ProcRow],
    verun_pid: u32,
    active: &[(String, u32)],
    task_names: &HashMap<String, String>,
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
        .map(|(task_id, (pid, rss, cpu))| TaskStat {
            task_name: task_names
                .get(&task_id)
                .cloned()
                .unwrap_or_else(|| "(unknown)".into()),
            task_id,
            pid,
            rss_bytes: rss,
            cpu_pct: cpu,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, parent: Option<u32>, rss: u64, cpu: f32) -> ProcRow {
        ProcRow { pid, parent_pid: parent, rss_bytes: rss, cpu_pct: cpu }
    }

    fn names(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
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
        let names = names(&[("ta", "Task A"), ("tb", "Task B")]);

        let s = attribute(&snap, 1, &active, &names, 42);

        assert_eq!(s.app.rss_bytes, 100 + 20);
        assert!((s.app.cpu_pct - 1.5).abs() < 1e-3);

        let task_a = s.tasks.iter().find(|t| t.task_id == "ta").unwrap();
        assert_eq!(task_a.rss_bytes, 200 + 50);
        assert!((task_a.cpu_pct - 12.0).abs() < 1e-3);

        let task_b = s.tasks.iter().find(|t| t.task_id == "tb").unwrap();
        assert_eq!(task_b.rss_bytes, 300);

        assert_eq!(s.total.rss_bytes, 100 + 20 + 200 + 50 + 300);
        assert_eq!(s.sampled_at_ms, 42);
    }

    #[test]
    fn dead_session_pid_is_excluded() {
        let snap = vec![row(1, None, 100, 0.0)];
        let active = vec![("ta".into(), 999)];
        let names = names(&[("ta", "Task A")]);

        let s = attribute(&snap, 1, &active, &names, 0);

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
        let names = names(&[("ta", "Task A")]);

        let s = attribute(&snap, 1, &active, &names, 0);

        assert_eq!(s.tasks.len(), 1);
        assert_eq!(s.tasks[0].rss_bytes, 300);
        assert!((s.tasks[0].cpu_pct - 15.0).abs() < 1e-3);
    }

    #[test]
    fn empty_active_map_yields_no_tasks_and_total_eq_app() {
        let snap = vec![row(1, None, 100, 5.0), row(2, Some(1), 50, 1.0)];
        let names = HashMap::new();

        let s = attribute(&snap, 1, &[], &names, 0);

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
        let names = names(&[("small", "S"), ("big", "B"), ("mid", "M")]);

        let s = attribute(&snap, 1, &active, &names, 0);

        let ids: Vec<_> = s.tasks.iter().map(|t| t.task_id.as_str()).collect();
        assert_eq!(ids, vec!["big", "mid", "small"]);
    }

    #[test]
    fn unknown_task_id_falls_back_to_placeholder_name() {
        let snap = vec![row(1, None, 0, 0.0), row(2, Some(1), 10, 0.0)];
        let active = vec![("unknown_id".into(), 2)];
        let names = HashMap::new();

        let s = attribute(&snap, 1, &active, &names, 0);

        assert_eq!(s.tasks.len(), 1);
        assert_eq!(s.tasks[0].task_name, "(unknown)");
    }
}
