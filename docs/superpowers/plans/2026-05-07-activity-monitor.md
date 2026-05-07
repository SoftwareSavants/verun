# In-App Activity Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar-footer chip showing total RAM/CPU% with a click-through overlay listing per-task breakdown, so users can see Verun's resource usage without opening macOS Activity Monitor.

**Architecture:** Push model. A Rust `ResourceSampler` tokio task polls the process tree via `sysinfo` (1s when overlay is open, 2s otherwise), attributes each session subtree to its task via `ActiveMap`, and emits a `resource_usage` event. Frontend has a single store listening to that event, feeding both the chip and the overlay.

**Tech Stack:** Rust + `sysinfo` 0.32, Tauri 2 events/commands, Solid.js signals, UnoCSS, vitest.

**Spec:** [`docs/superpowers/specs/2026-05-07-activity-monitor-design.md`](../specs/2026-05-07-activity-monitor-design.md)

---

## File map

**New:**
- `src-tauri/src/resource_monitor.rs` - types, `ProcessSource` trait, `attribute()` pure function, `SysinfoSource`, `ResourceSampler`
- `src/store/resource-monitor.ts` - Solid signal + tauri event listener
- `src/components/ResourceChip.tsx` + `.test.tsx`
- `src/components/ResourceOverlayDialog.tsx` + `.test.tsx`

**Modified:**
- `src-tauri/Cargo.toml` - add `sysinfo`
- `src-tauri/src/lib.rs` - register module, spawn sampler in setup, add commands to invoke_handler
- `src-tauri/src/ipc.rs` - 2 new commands
- `src/lib/format.ts` + `format.test.ts` - add `formatBytes`, `formatPct`
- `src/lib/ipc.ts` + `ipc.test.ts` - new types + wrappers
- `src/components/Sidebar.tsx` - mount `<ResourceChip>` in footer
- `src/components/StorageSettings.tsx` - replace local `formatBytes` with import (DRY cleanup)
- `CHANGELOG.md` - one-line bullet under `## Unreleased`
- `README.md` - features list (only if it mentions monitoring)

---

## Task 1: Add `formatBytes` and `formatPct` to shared formatters

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/lib/format.test.ts`
- Modify: `src/components/StorageSettings.tsx` (remove local `formatBytes`, import from `../lib/format`)

- [ ] **Step 1: Write failing tests for `formatBytes` and `formatPct`**

Append to `src/lib/format.test.ts`:

```ts
import { formatBytes, formatPct } from './format'

describe('formatBytes', () => {
  it('shows raw bytes under 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('uses KB at 1 KiB and above', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(10 * 1024)).toBe('10.0 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
  })

  it('uses MB at 1 MiB and above', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
  })

  it('uses GB at 1 GiB and above', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB')
    expect(formatBytes(Math.round(1.234 * 1024 ** 3))).toBe('1.23 GB')
  })
})

describe('formatPct', () => {
  it('uses 1 decimal under 10%', () => {
    expect(formatPct(0)).toBe('0.0%')
    expect(formatPct(1.234)).toBe('1.2%')
    expect(formatPct(9.95)).toBe('10%') // rounds to 10
  })

  it('uses 0 decimals at 10% and above', () => {
    expect(formatPct(10)).toBe('10%')
    expect(formatPct(99.6)).toBe('100%')
    expect(formatPct(420)).toBe('420%')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/format.test.ts`
Expected: FAIL with "formatBytes is not a function" / "formatPct is not a function".

- [ ] **Step 3: Implement `formatBytes` and `formatPct`**

Append to `src/lib/format.ts`:

```ts
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatPct(p: number): string {
  if (p < 10) return `${p.toFixed(1)}%`
  return `${Math.round(p)}%`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/format.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Replace duplicated `formatBytes` in `StorageSettings.tsx`**

Edit `src/components/StorageSettings.tsx`:
- Add `formatBytes` to existing import from a relative path (or add a new import line).
- Delete the local `function formatBytes(n: number): string { ... }` block (currently lines ~12-22).

```ts
// at top of file, after existing imports
import { formatBytes } from '../lib/format'
// remove the local function definition
```

- [ ] **Step 6: Run typecheck and storage-settings consumers**

Run: `pnpm check && pnpm vitest run`
Expected: zero TS errors; full vitest suite green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/components/StorageSettings.tsx
git commit -m "feat(format): add formatBytes and formatPct helpers"
```

---

## Task 2: Add `sysinfo` dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dep**

Edit `src-tauri/Cargo.toml`. Find the `[dependencies]` block and add (alphabetical order, near `serde`):

```toml
sysinfo = { version = "0.32", default-features = false, features = ["system"] }
```

- [ ] **Step 2: Verify it builds**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean build, no warnings related to sysinfo.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: add sysinfo crate for resource monitoring"
```

---

## Task 3: `resource_monitor` types and pure attribution function

This is the testable core. No `sysinfo` calls here yet - only data shapes and the attribution algorithm.

**Files:**
- Create: `src-tauri/src/resource_monitor.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod resource_monitor;`)

- [ ] **Step 1: Register the module so tests can compile**

Edit `src-tauri/src/lib.rs`. After the existing `mod` declarations (alphabetical, between `pty` and `snapshots`):

```rust
mod resource_monitor;
```

- [ ] **Step 2: Create the module with types and a stub `attribute` function**

Create `src-tauri/src/resource_monitor.rs`:

```rust
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProcessStat {
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskStat {
    pub task_id: String,
    pub task_name: String,
    pub pid: u32,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub total: ProcessStat,
    pub app: ProcessStat,
    pub tasks: Vec<TaskStat>,
    pub sampled_at_ms: i64,
}

/// Snapshot row for a single process. Source-agnostic (sysinfo or test fake).
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

/// Pure function: turn a snapshot + ActiveMap data into a Sample.
/// `active` is `(task_id, session_pid)` pairs. Multiple sessions per task are summed.
/// Sessions whose `session_pid` is missing from the snapshot (process died) are dropped.
pub fn attribute(
    snapshot: &[ProcRow],
    verun_pid: u32,
    active: &[(String, u32)],
    task_names: &HashMap<String, String>,
    sampled_at_ms: i64,
) -> Sample {
    // TODO: implement in step 4
    let _ = (snapshot, verun_pid, active, task_names);
    Sample {
        total: ProcessStat { rss_bytes: 0, cpu_pct: 0.0 },
        app: ProcessStat { rss_bytes: 0, cpu_pct: 0.0 },
        tasks: Vec::new(),
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
}
```

- [ ] **Step 3: Write the failing tests for `attribute`**

Append to the `mod tests` block in `src-tauri/src/resource_monitor.rs`:

```rust
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
        let active = vec![("ta".into(), 999)]; // 999 not in snapshot
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
```

- [ ] **Step 4: Run tests, confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests`
Expected: 6 failures - the stub `attribute` returns zeros so all assertions fail.

- [ ] **Step 5: Implement `attribute`**

Replace the stub body in `src-tauri/src/resource_monitor.rs`:

```rust
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
```

- [ ] **Step 6: Run tests, confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: 6 tests pass, no clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/resource_monitor.rs src-tauri/src/lib.rs
git commit -m "feat(resource-monitor): add attribution algorithm with unit tests"
```

---

## Task 4: `SysinfoSource` real implementation

**Files:**
- Modify: `src-tauri/src/resource_monitor.rs`

- [ ] **Step 1: Write a smoke test that uses sysinfo against the test process**

Append to the `mod tests` block:

```rust
    #[test]
    fn sysinfo_source_returns_self_pid() {
        let mut src = SysinfoSource::new();
        let snap = src.snapshot();
        let self_pid = std::process::id();
        let me = snap.iter().find(|r| r.pid == self_pid)
            .expect("self process must be in the snapshot");
        assert!(me.rss_bytes > 0, "self process RSS should be > 0");
    }
```

- [ ] **Step 2: Run, expect failure ("SysinfoSource not defined")**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests::sysinfo_source_returns_self_pid`
Expected: FAIL - undefined symbol.

- [ ] **Step 3: Implement `SysinfoSource`**

Add to `src-tauri/src/resource_monitor.rs` (above `#[cfg(test)] mod tests`):

```rust
pub struct SysinfoSource {
    sys: sysinfo::System,
}

impl SysinfoSource {
    pub fn new() -> Self {
        let mut sys = sysinfo::System::new();
        // First refresh primes CPU baseline; subsequent calls compute deltas.
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().with_cpu().with_memory(),
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
            sysinfo::ProcessRefreshKind::nothing().with_cpu().with_memory(),
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
```

Note: sysinfo 0.32 API uses `ProcessesToUpdate::All` and `ProcessRefreshKind::nothing()`. If a different minor version exposes a different builder name, adjust at compile time - the surface here is small and obvious.

- [ ] **Step 4: Run, expect pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests::sysinfo_source_returns_self_pid && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/resource_monitor.rs
git commit -m "feat(resource-monitor): add SysinfoSource backed by sysinfo crate"
```

---

## Task 5: `ResourceSampler` background loop with cadence switching

**Files:**
- Modify: `src-tauri/src/resource_monitor.rs`

- [ ] **Step 1: Write a failing test for cadence switching**

Append to `mod tests`:

```rust
    use std::sync::atomic::Ordering;

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
```

- [ ] **Step 2: Run, expect compile failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests::sampler_cadence`
Expected: FAIL (no `ResourceSampler::new_for_test`).

- [ ] **Step 3: Implement `ResourceSampler`**

Append to `src-tauri/src/resource_monitor.rs` (above `#[cfg(test)] mod tests`):

```rust
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct ResourceSampler {
    cadence: Arc<AtomicU64>,
    notify: Arc<tokio::sync::Notify>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl ResourceSampler {
    /// Production constructor: spawns the loop. `task_names_provider` returns
    /// (task_id -> task_name) for the active session task_ids on each tick.
    pub fn spawn<S, F>(
        app: tauri::AppHandle,
        active: crate::task::ActiveMap,
        mut source: S,
        task_names_provider: F,
    ) -> Self
    where
        S: ProcessSource + Send + 'static,
        F: Fn(&[String]) -> HashMap<String, String> + Send + Sync + 'static,
    {
        let cadence = Arc::new(AtomicU64::new(2000));
        let notify = Arc::new(tokio::sync::Notify::new());
        let cadence_clone = cadence.clone();
        let notify_clone = notify.clone();

        let handle = tokio::spawn(async move {
            let verun_pid = std::process::id();
            loop {
                let active_pairs: Vec<(String, u32)> = active
                    .iter()
                    .filter_map(|entry| {
                        entry.value().child.id().map(|pid| (entry.value().task_id.clone(), pid))
                    })
                    .collect();

                let task_ids: Vec<String> =
                    active_pairs.iter().map(|(t, _)| t.clone()).collect();
                let names = task_names_provider(&task_ids);

                let snap = source.snapshot();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);

                let sample = attribute(&snap, verun_pid, &active_pairs, &names, now_ms);

                use tauri::Emitter;
                let _ = app.emit("resource_usage", &sample);

                let wait_ms = cadence_clone.load(Ordering::Relaxed);
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms)) => {}
                    _ = notify_clone.notified() => {} // wake immediately if cadence changed
                }
            }
        });

        Self { cadence, notify, handle: Some(handle) }
    }

    pub fn set_overlay_open(&self, open: bool) {
        self.cadence.store(if open { 1000 } else { 2000 }, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub fn cadence_ms(&self) -> u64 {
        self.cadence.load(Ordering::Relaxed)
    }

    /// Build a sampler without spawning the loop. For unit tests of cadence only.
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

/// Produce the on-demand sample. Used by `get_resource_usage_now` so the
/// overlay's first paint isn't blank for up to 1s. Builds its own short-lived
/// SysinfoSource - the live sampler keeps its own.
pub fn sample_now<F>(
    active: &crate::task::ActiveMap,
    task_names_provider: F,
) -> Sample
where
    F: Fn(&[String]) -> HashMap<String, String>,
{
    let mut src = SysinfoSource::new();
    // Two refreshes, separated by a tiny sleep, so CPU% has a delta.
    let _ = src.snapshot();
    std::thread::sleep(std::time::Duration::from_millis(100));
    let snap = src.snapshot();

    let active_pairs: Vec<(String, u32)> = active
        .iter()
        .filter_map(|entry| {
            entry.value().child.id().map(|pid| (entry.value().task_id.clone(), pid))
        })
        .collect();
    let task_ids: Vec<String> = active_pairs.iter().map(|(t, _)| t.clone()).collect();
    let names = task_names_provider(&task_ids);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    attribute(&snap, std::process::id(), &active_pairs, &names, now_ms)
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resource_monitor::tests && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/resource_monitor.rs
git commit -m "feat(resource-monitor): add ResourceSampler tokio loop"
```

---

## Task 6: IPC commands and lib.rs wiring

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add a helper to fetch task names for a list of IDs**

Look in `src-tauri/src/db.rs` for an existing helper. If there isn't one (likely there is not), add it:

```rust
// in src-tauri/src/db.rs, near other task queries
pub async fn task_names_for_ids(
    pool: &SqlitePool,
    ids: &[String],
) -> Result<std::collections::HashMap<String, String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let mut q = String::from("SELECT id, name FROM tasks WHERE id IN (");
    for i in 0..ids.len() {
        if i > 0 { q.push(','); }
        q.push('?');
    }
    q.push(')');

    let mut query = sqlx::query_as::<_, (String, String)>(&q);
    for id in ids {
        query = query.bind(id);
    }
    let rows: Vec<(String, String)> = query.fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}
```

(If `db.rs` already has a `Task` row mapper that exposes `name`, it's fine to reuse; keep this helper if not.)

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles.

- [ ] **Step 2: Add the two IPC commands**

Append to `src-tauri/src/ipc.rs`:

```rust
#[tauri::command]
pub async fn set_resource_monitor_overlay_open(
    sampler: State<'_, std::sync::Arc<crate::resource_monitor::ResourceSampler>>,
    open: bool,
) -> Result<(), String> {
    sampler.set_overlay_open(open);
    Ok(())
}

#[tauri::command]
pub async fn get_resource_usage_now(
    pool: State<'_, SqlitePool>,
    active: State<'_, crate::task::ActiveMap>,
) -> Result<crate::resource_monitor::Sample, String> {
    let active_clone = (*active).clone();
    let pool_clone = (*pool).clone();
    // sample_now does a 100ms blocking sleep; offload to a blocking thread.
    let sample = tokio::task::spawn_blocking(move || {
        // We block on a small Tokio runtime to call the async name fetcher.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let names_provider = |ids: &[String]| -> std::collections::HashMap<String, String> {
            rt.block_on(async {
                crate::db::task_names_for_ids(&pool_clone, ids)
                    .await
                    .unwrap_or_default()
            })
        };
        Ok::<_, String>(crate::resource_monitor::sample_now(&active_clone, names_provider))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(sample)
}
```

- [ ] **Step 3: Wrap `ResourceSampler` in `Arc`, spawn it during setup, register state**

Edit `src-tauri/src/lib.rs`. In the `setup` block (after the existing `app.manage(pool)` call around line 175-177), add:

```rust
            // Resource monitor: per-task RAM/CPU sampler used by the sidebar
            // chip + overlay.
            let active_for_monitor = std::sync::Arc::clone(&*app.state::<crate::task::ActiveMap>());
            let pool_for_monitor = app.state::<sqlx::sqlite::SqlitePool>().inner().clone();
            let monitor_handle = app.handle().clone();
            let names_provider = move |ids: &[String]| -> std::collections::HashMap<String, String> {
                let pool = pool_for_monitor.clone();
                let ids = ids.to_vec();
                tauri::async_runtime::block_on(async move {
                    crate::db::task_names_for_ids(&pool, &ids).await.unwrap_or_default()
                })
            };
            let sampler = std::sync::Arc::new(
                crate::resource_monitor::ResourceSampler::spawn(
                    monitor_handle,
                    active_for_monitor,
                    crate::resource_monitor::SysinfoSource::new(),
                    names_provider,
                ),
            );
            app.manage(sampler);
```

- [ ] **Step 4: Register the two commands in `invoke_handler`**

In the same file, in the `tauri::generate_handler![...]` list (around line 256), add a new section near the end:

```rust
            // Resource monitor
            ipc::set_resource_monitor_overlay_open,
            ipc::get_resource_usage_now,
```

- [ ] **Step 5: Build and run tests**

Run: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src-tauri/src/db.rs
git commit -m "feat(resource-monitor): wire IPC commands and spawn sampler"
```

---

## Task 7: Frontend types + IPC wrappers

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/ipc.test.ts` (if it exists - otherwise skip the test step)

- [ ] **Step 1: Write failing tests for the new wrappers**

If `src/lib/ipc.test.ts` already covers other wrappers via mocked `invoke`, append:

```ts
// near other test cases
test('setResourceMonitorOverlayOpen calls invoke with `open`', async () => {
  const invokeMock = vi.fn().mockResolvedValue(undefined)
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
  const { setResourceMonitorOverlayOpen } = await import('./ipc')
  await setResourceMonitorOverlayOpen(true)
  expect(invokeMock).toHaveBeenCalledWith('set_resource_monitor_overlay_open', { open: true })
})

test('getResourceUsageNow calls invoke with no args', async () => {
  const invokeMock = vi.fn().mockResolvedValue({
    total: { rssBytes: 0, cpuPct: 0 },
    app: { rssBytes: 0, cpuPct: 0 },
    tasks: [],
    sampledAtMs: 0,
  })
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
  const { getResourceUsageNow } = await import('./ipc')
  await getResourceUsageNow()
  expect(invokeMock).toHaveBeenCalledWith('get_resource_usage_now')
})
```

If no such test file exists, create a minimal `src/lib/ipc.resource-monitor.test.ts` with the same content and adjust imports.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run src/lib/ipc`
Expected: FAIL (functions don't exist yet).

- [ ] **Step 3: Add the types and wrappers**

In `src/lib/ipc.ts`, add types near the top (or in `src/types/`):

```ts
export interface ProcessStat { rssBytes: number; cpuPct: number }
export interface TaskStat {
  taskId: string
  taskName: string
  pid: number
  rssBytes: number
  cpuPct: number
}
export interface ResourceSample {
  total: ProcessStat
  app: ProcessStat
  tasks: TaskStat[]
  sampledAtMs: number
}
```

Note: serde renames Rust `rss_bytes` to TS `rss_bytes` by default. Verify what shows up by adding an `eprintln!` in the Rust handler and inspecting once - or use `#[serde(rename_all = "camelCase")]` on the Rust structs. Recommended fix in Rust:

```rust
// in src-tauri/src/resource_monitor.rs - update each struct
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStat { ... }

// similarly TaskStat and Sample
```

(Make this Rust change in this same task. Re-run `cargo test`. If the rust unit tests don't deserialize, no change needed - they only construct the values.)

Then add the wrappers at the bottom of `src/lib/ipc.ts`:

```ts
export const setResourceMonitorOverlayOpen = (open: boolean) =>
  invoke<void>('set_resource_monitor_overlay_open', { open })

export const getResourceUsageNow = () =>
  invoke<ResourceSample>('get_resource_usage_now')
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run src/lib/ipc && pnpm check && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts src-tauri/src/resource_monitor.rs
git commit -m "feat(resource-monitor): add frontend IPC wrappers and camelCase serde"
```

---

## Task 8: Resource monitor store

**Files:**
- Create: `src/store/resource-monitor.ts`
- Create: `src/store/resource-monitor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/store/resource-monitor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured: Array<{ event: string; cb: (e: { payload: unknown }) => void }> = []
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    captured.push({ event, cb })
    return Promise.resolve(() => {})
  }),
}))

describe('resource-monitor store', () => {
  beforeEach(() => { captured.length = 0 })

  it('listens for resource_usage events and updates the signal', async () => {
    const { resourceSample, initResourceMonitor } = await import('./resource-monitor')
    expect(resourceSample()).toBe(null)
    await initResourceMonitor()
    const entry = captured.find(c => c.event === 'resource_usage')
    expect(entry).toBeDefined()
    entry!.cb({ payload: {
      total: { rssBytes: 100, cpuPct: 1 },
      app: { rssBytes: 50, cpuPct: 0.5 },
      tasks: [],
      sampledAtMs: 0,
    } })
    expect(resourceSample()?.total.rssBytes).toBe(100)
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run src/store/resource-monitor.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the store**

Create `src/store/resource-monitor.ts`:

```ts
import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import type { ResourceSample } from '../lib/ipc'

export const [resourceSample, setResourceSample] = createSignal<ResourceSample | null>(null)

let initPromise: Promise<void> | null = null

export function initResourceMonitor(): Promise<void> {
  if (!initPromise) {
    initPromise = listen<ResourceSample>('resource_usage', (e) => {
      setResourceSample(e.payload)
    }).then(() => {})
  }
  return initPromise
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm vitest run src/store/resource-monitor.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `initResourceMonitor` at app boot**

Find where other stores are initialized at app boot (search for `loadProjects` or `initSetup` in `src/main.tsx`, `src/App.tsx`, or `src/lib/appInit.ts`). Add a call to `initResourceMonitor()` alongside them.

```ts
// in the file that already imports loadProjects / setup init
import { initResourceMonitor } from './store/resource-monitor'
// inside the boot sequence
void initResourceMonitor()
```

Run: `pnpm check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/resource-monitor.ts src/store/resource-monitor.test.ts src/main.tsx src/App.tsx src/lib/appInit.ts
git commit -m "feat(resource-monitor): add Solid store + boot listener"
```

(Adjust the `git add` to whichever boot file you actually touched.)

---

## Task 9: `ResourceChip` component

**Files:**
- Create: `src/components/ResourceChip.tsx`
- Create: `src/components/ResourceChip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ResourceChip.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'

const sampleSig = vi.hoisted(() => ({
  current: null as null | {
    total: { rssBytes: number; cpuPct: number }
    app: { rssBytes: number; cpuPct: number }
    tasks: unknown[]
    sampledAtMs: number
  },
}))

vi.mock('../store/resource-monitor', () => ({
  resourceSample: () => sampleSig.current,
}))

describe('ResourceChip', () => {
  afterEach(() => { cleanup(); sampleSig.current = null })

  it('renders dim placeholder when sample is null', async () => {
    sampleSig.current = null
    const { ResourceChip } = await import('./ResourceChip')
    const { getByTestId } = render(() => <ResourceChip onClick={() => {}} />)
    expect(getByTestId('resource-chip').textContent).toMatch(/RAM\s+-/)
  })

  it('renders formatted total when sample present', async () => {
    sampleSig.current = {
      total: { rssBytes: 1024 * 1024 * 1024 + 200 * 1024 * 1024, cpuPct: 32.4 },
      app: { rssBytes: 0, cpuPct: 0 },
      tasks: [],
      sampledAtMs: 0,
    }
    const { ResourceChip } = await import('./ResourceChip')
    const { getByTestId } = render(() => <ResourceChip onClick={() => {}} />)
    expect(getByTestId('resource-chip').textContent).toMatch(/1\.20 GB/)
    expect(getByTestId('resource-chip').textContent).toMatch(/32%/)
  })

  it('invokes onClick when clicked', async () => {
    sampleSig.current = null
    const onClick = vi.fn()
    const { ResourceChip } = await import('./ResourceChip')
    const { getByTestId } = render(() => <ResourceChip onClick={onClick} />)
    fireEvent.click(getByTestId('resource-chip'))
    expect(onClick).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run src/components/ResourceChip.test.tsx`
Expected: FAIL (component does not exist).

- [ ] **Step 3: Implement the component**

Create `src/components/ResourceChip.tsx`:

```tsx
import { Component, Show } from 'solid-js'
import { resourceSample } from '../store/resource-monitor'
import { formatBytes, formatPct } from '../lib/format'

interface Props {
  onClick: () => void
}

export const ResourceChip: Component<Props> = (props) => {
  return (
    <button
      data-testid="resource-chip"
      onClick={() => props.onClick()}
      title="Activity"
      class="px-2 py-1 rounded-md text-xs tabular-nums text-text-dim hover:text-text-secondary hover:bg-surface-3 ring-1 ring-white/8 transition-colors"
    >
      <Show
        when={resourceSample()}
        fallback={<span>RAM -</span>}
      >
        {(s) => (
          <span>
            RAM {formatBytes(s().total.rssBytes)} <span class="opacity-60">·</span> {formatPct(s().total.cpuPct)}
          </span>
        )}
      </Show>
    </button>
  )
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run src/components/ResourceChip.test.tsx && pnpm check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ResourceChip.tsx src/components/ResourceChip.test.tsx
git commit -m "feat(resource-monitor): add ResourceChip component"
```

---

## Task 10: `ResourceOverlayDialog` component

**Files:**
- Create: `src/components/ResourceOverlayDialog.tsx`
- Create: `src/components/ResourceOverlayDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ResourceOverlayDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

const sampleSig = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../store/resource-monitor', () => ({
  resourceSample: () => sampleSig.current,
}))

const ipcMocks = vi.hoisted(() => ({
  setResourceMonitorOverlayOpen: vi.fn().mockResolvedValue(undefined),
  getResourceUsageNow: vi.fn().mockResolvedValue({
    total: { rssBytes: 0, cpuPct: 0 },
    app: { rssBytes: 0, cpuPct: 0 },
    tasks: [],
    sampledAtMs: 0,
  }),
}))
vi.mock('../lib/ipc', () => ipcMocks)

describe('ResourceOverlayDialog', () => {
  afterEach(() => { cleanup(); sampleSig.current = null; vi.clearAllMocks() })

  it('renders nothing when closed', async () => {
    const { ResourceOverlayDialog } = await import('./ResourceOverlayDialog')
    const { container } = render(() => <ResourceOverlayDialog open={false} onClose={() => {}} />)
    expect(container.querySelector('[data-testid="resource-overlay"]')).toBeNull()
  })

  it('on open: calls setResourceMonitorOverlayOpen(true) and getResourceUsageNow', async () => {
    const { ResourceOverlayDialog } = await import('./ResourceOverlayDialog')
    render(() => <ResourceOverlayDialog open={true} onClose={() => {}} />)
    expect(ipcMocks.setResourceMonitorOverlayOpen).toHaveBeenCalledWith(true)
    expect(ipcMocks.getResourceUsageNow).toHaveBeenCalled()
  })

  it('renders task rows sorted by RSS desc', async () => {
    sampleSig.current = {
      total: { rssBytes: 1_500_000_000, cpuPct: 50 },
      app: { rssBytes: 200_000_000, cpuPct: 5 },
      tasks: [
        { taskId: 'a', taskName: 'Small', pid: 1, rssBytes: 100_000_000, cpuPct: 1 },
        { taskId: 'b', taskName: 'Big',   pid: 2, rssBytes: 800_000_000, cpuPct: 30 },
        { taskId: 'c', taskName: 'Mid',   pid: 3, rssBytes: 400_000_000, cpuPct: 14 },
      ],
      sampledAtMs: 0,
    }
    const { ResourceOverlayDialog } = await import('./ResourceOverlayDialog')
    const { getAllByTestId } = render(() => <ResourceOverlayDialog open={true} onClose={() => {}} />)
    const rows = getAllByTestId('resource-task-row')
    expect(rows.map(r => r.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Big'),
        expect.stringContaining('Mid'),
        expect.stringContaining('Small'),
      ])
    )
    // Confirm order
    expect(rows[0].textContent).toContain('Big')
    expect(rows[1].textContent).toContain('Mid')
    expect(rows[2].textContent).toContain('Small')
  })
})
```

(Note: the spec already says rows should arrive sorted from Rust. The component renders them as given - this test is a regression guard against accidentally re-sorting them in JS in a way that breaks order.)

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run src/components/ResourceOverlayDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/components/ResourceOverlayDialog.tsx`:

```tsx
import { Component, For, Show, createEffect, onCleanup } from 'solid-js'
import { Dialog } from './Dialog'
import { resourceSample } from '../store/resource-monitor'
import { formatBytes, formatPct } from '../lib/format'
import { setResourceMonitorOverlayOpen, getResourceUsageNow } from '../lib/ipc'

interface Props {
  open: boolean
  onClose: () => void
}

export const ResourceOverlayDialog: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    void setResourceMonitorOverlayOpen(true)
    void getResourceUsageNow().then((s) => {
      // store listener will pick up subsequent ticks; this seeds first paint
      // by piggy-backing on the listener since the same payload shape is set.
      const ev = new CustomEvent('__resource_seed__', { detail: s })
      window.dispatchEvent(ev)
    })
    onCleanup(() => { void setResourceMonitorOverlayOpen(false) })
  })

  return (
    <Dialog open={props.open} onClose={props.onClose} width="42rem">
      <div data-testid="resource-overlay" class="p-4">
        <Show
          when={resourceSample()}
          fallback={<div class="text-text-dim">Sampling…</div>}
        >
          {(s) => (
            <>
              <div class="flex items-baseline justify-between mb-3">
                <div>
                  <div class="text-2xl tabular-nums">
                    {formatBytes(s().total.rssBytes)}
                    <span class="text-text-dim text-base ml-2">{formatPct(s().total.cpuPct)}</span>
                  </div>
                  <div class="text-xs text-text-dim mt-1">
                    Verun (app): {formatBytes(s().app.rssBytes)} · {formatPct(s().app.cpuPct)}
                  </div>
                </div>
              </div>
              <div class="border-t-1 border-t-solid border-t-white/8 pt-2">
                <div class="grid grid-cols-[1fr_5rem_4rem] gap-2 text-xs text-text-dim mb-1">
                  <div>Task</div><div class="text-right">RAM</div><div class="text-right">CPU</div>
                </div>
                <For each={s().tasks}>{(t) => (
                  <div data-testid="resource-task-row" class="grid grid-cols-[1fr_5rem_4rem] gap-2 py-1 text-sm tabular-nums">
                    <div class="truncate">{t.taskName}</div>
                    <div class="text-right">{formatBytes(t.rssBytes)}</div>
                    <div class="text-right">{formatPct(t.cpuPct)}</div>
                  </div>
                )}</For>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
```

Note: the seed event in the effect is a workaround if `getResourceUsageNow`'s response should immediately appear in `resourceSample()`. Cleaner alternative: have `getResourceUsageNow` directly call `setResourceSample` from the store. Use that instead - it's simpler:

```ts
// in src/store/resource-monitor.ts, export setResourceSample (not just resourceSample)
export { setResourceSample }
```

Then in the dialog:
```ts
import { setResourceSample } from '../store/resource-monitor'
void getResourceUsageNow().then(setResourceSample)
```

Strip the CustomEvent wiring. Update the test mock accordingly (it already calls `getResourceUsageNow` so behavior matches).

- [ ] **Step 4: Run, expect pass**

Run: `pnpm vitest run src/components/ResourceOverlayDialog.test.tsx && pnpm check`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ResourceOverlayDialog.tsx src/components/ResourceOverlayDialog.test.tsx src/store/resource-monitor.ts
git commit -m "feat(resource-monitor): add overlay dialog with per-task breakdown"
```

---

## Task 11: Mount the chip in the Sidebar footer

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add overlay state and chip in the footer button row**

Open `src/components/Sidebar.tsx`. Locate the footer button row containing the Settings gear (search for `title="Settings"` - currently around line 566). Wrap or extend that row to include the chip and an overlay state:

```tsx
// near other createSignal calls at the top of the component:
const [showResourceOverlay, setShowResourceOverlay] = createSignal(false)

// in the footer button row (the same flex row that currently contains
// the Archive and Settings buttons), prepend the chip:
<ResourceChip onClick={() => setShowResourceOverlay(true)} />

// at the bottom of the component's returned JSX (alongside the existing
// ConfirmDialog), add:
<ResourceOverlayDialog
  open={showResourceOverlay()}
  onClose={() => setShowResourceOverlay(false)}
/>
```

Add the imports at the top:

```tsx
import { ResourceChip } from './ResourceChip'
import { ResourceOverlayDialog } from './ResourceOverlayDialog'
```

- [ ] **Step 2: Run typecheck and frontend tests**

Run: `pnpm check && pnpm vitest run`
Expected: zero TS errors, all tests green.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications`

Verify:
- Chip appears in sidebar footer next to the Settings gear, shows "RAM -" briefly then real numbers.
- Numbers update every ~2s without the overlay.
- Click the chip: overlay opens, first paint within ~100ms (from `getResourceUsageNow`), subsequent ticks every ~1s.
- With 2-3 active sessions, per-task RSS roughly matches what macOS Activity Monitor shows for the corresponding processes (within ~10%).
- Closing overlay returns chip cadence to ~2s (verify by leaving DevTools open and watching the event stream slow down).

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(resource-monitor): mount chip + overlay in sidebar footer"
```

---

## Task 12: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (only if it has a Features list and the activity monitor fits it)

- [ ] **Step 1: Add the changelog bullet**

Open `CHANGELOG.md`. Find the `## Unreleased` section (create at the top above the latest version section if it doesn't exist). Add:

```md
- Sidebar footer chip showing total RAM/CPU% with an overlay breakdown per task
```

- [ ] **Step 2: Update README features list (if applicable)**

Open `README.md`. If a Features section exists, add a bullet:

```md
- Activity monitor: live RAM/CPU breakdown per task in the sidebar
```

If no Features section exists, skip.

- [ ] **Step 3: Final full health check per Definition of Done**

Run: `make check`
Expected: zero errors, zero clippy warnings.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: add activity monitor to changelog"
```

---

## Self-review

**Spec coverage:**
- Goal (transparency for "too much RAM" complaint): Tasks 9-11 surface this in the UI.
- Surface (sidebar footer chip + overlay): Task 9 (chip), Task 10 (overlay), Task 11 (mounting).
- Push model with single sampler: Task 5.
- 2s/1s cadence: Task 5 (sampler), Task 6 (set_overlay_open command), Task 10 (overlay calls it).
- Process tree attribution: Task 3.
- `Verun (app)` excludes session subtrees: Task 3 (test `rolls_up_session_subtrees_and_excludes_them_from_app`).
- Idle tasks excluded: Task 3 (test `dead_session_pid_is_excluded`).
- Multiple sessions per task summed: Task 3 (test `multiple_sessions_for_one_task_are_summed`).
- Sort by RSS desc: Task 3 (test `tasks_sorted_by_rss_desc`).
- Sample on overlay open for instant first paint: Task 6 (`get_resource_usage_now`), Task 10 (component effect).
- Format helpers (`formatBytes`, `formatPct`): Task 1.
- Cargo dep: Task 2.
- Backend wiring: Task 6.
- Frontend types/wrappers: Task 7.
- Store + listener: Task 8.
- Docs: Task 12.

**Placeholder scan:** All steps include concrete code. The two notes-to-implementer (sysinfo API surface check in Task 4 step 3, and the cleaner store-export approach in Task 10 step 3) are inline guidance rather than placeholders, with the recommended path explicit.

**Type consistency:**
- Rust: `Sample`, `ProcessStat`, `TaskStat`, `ProcRow` defined once (Task 3) and referenced consistently.
- TS: `ResourceSample`, `ProcessStat`, `TaskStat` defined in Task 7, used by Tasks 8-10.
- Method names: `setOverlayOpen` on `ResourceSampler`, `set_resource_monitor_overlay_open` IPC command, `setResourceMonitorOverlayOpen` TS wrapper - consistent across the chain.
- camelCase serde rename added in Task 7 step 3 to keep TS naming idiomatic.

No gaps found.
