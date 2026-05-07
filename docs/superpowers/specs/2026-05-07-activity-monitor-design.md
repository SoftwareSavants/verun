# In-App Activity Monitor - Design

**Date:** 2026-05-07
**Status:** Approved (brainstorm)
**Owner:** Abdulrahman

## Goal

Give every Verun user a glanceable view of how much RAM and CPU the app is using, broken down by running task. Addresses user complaints that "Verun uses too much resources" without forcing them to open macOS Activity Monitor.

Non-goals: killing/throttling tasks, disk/network metrics, historical graphs.

## Surface

- **Resource chip** in the Sidebar footer, next to the existing Settings gear (`src/components/Sidebar.tsx` ~line 568).
  - Renders `RAM 1.2G · 32%` from the latest sample's totals.
  - Click opens the overlay.
- **Overlay** modal (built on the existing `Dialog.tsx` shell):
  - Header row: total RAM + CPU% (large), "Verun (app)" RAM + CPU% (small).
  - Table: one row per task with a live session, sorted by RSS desc. Columns: task name, RAM, CPU%.
  - No kill button.

## Architecture

```
┌───────────────────────────┐    resource_usage event    ┌─────────────────┐
│  Rust: ResourceSampler    │ ─────────────────────────► │ Frontend store  │
│  (tokio task)             │                             │ (Solid signal)  │
│                           │ ◄── set_overlay_open(bool) ─│                 │
│  • ticks 2s (chip-only)   │                             │ ResourceChip +  │
│    or 1s (overlay open)   │                             │ ResourceOverlay │
│  • sysinfo snapshot       │                             │ Dialog          │
│  • walks Verun's process  │                             │                 │
│    tree, attributes PIDs  │                             │                 │
│    via ActiveMap          │                             │                 │
└───────────────────────────┘                             └─────────────────┘
```

Push model - single sampler emits one event per tick, both UI components subscribe to the same signal. Honors the `CLAUDE.md` rule: no frontend polling.

## Process tree attribution

Sessions are children of Verun, so naively summing "Verun's subtree" double-counts task processes. Algorithm:

1. `sysinfo::System::refresh_processes()` to snapshot all PIDs.
2. Build PID→children index from parent_pid.
3. Get Verun's own PID via `std::process::id()`.
4. Snapshot `ActiveMap` → list of `(task_id, session_pid)` for sessions whose `child.id()` is `Some(_)`.
5. For each `session_pid`: BFS descendants → that subtree's RSS+CPU = task row. Multiple sessions on the same task are summed under one row keyed by `task_id`.
6. Walk Verun's full descendants and **subtract** every PID already attributed to a task → remainder is "Verun (app)" (covers main proc + watchers + hooks + tool PTYs not tied to a session).
7. `total = app + sum(tasks)`. Idle tasks (no live session) excluded from the list.

Sort: tasks by RSS desc. CPU% sysinfo-normalized per-core then summed across the subtree.

Tradeoff: hooks/watchers spawned by Verun get bucketed into "Verun (app)" rather than per-task. Acceptable for the transparency goal; can split later if requested.

## Data model

```rust
pub struct Sample {
    pub total: ProcessStat,
    pub app: ProcessStat,
    pub tasks: Vec<TaskStat>,
    pub sampled_at_ms: i64,
}
pub struct ProcessStat { pub rss_bytes: u64, pub cpu_pct: f32 }
pub struct TaskStat {
    pub task_id: String,
    pub task_name: String,
    pub pid: u32,
    pub rss_bytes: u64,
    pub cpu_pct: f32,
}
```

Mirrored in TypeScript via `src/lib/ipc.ts` types.

## Backend

New module `src-tauri/src/resource_monitor.rs`:

```rust
trait ProcessSource { fn snapshot(&mut self) -> Vec<ProcRow>; }
struct SysinfoSource(sysinfo::System);   // production impl
// tests inject a fixed-Vec impl

pub struct ResourceSampler { /* cadence: Arc<AtomicU64>, handle: JoinHandle<()> */ }
impl ResourceSampler {
    pub fn spawn(app: AppHandle, active: ActiveMap, pool: SqlitePool) -> Self;
    pub fn set_overlay_open(&self, open: bool); // flips 2s ↔ 1s tick
}
```

- One tokio task: `loop { sleep(cadence); sample(); emit("resource_usage", sample); }`.
- Task names fetched per tick from DB (cheap; <50 active tasks typical).
- Wired in `src-tauri/src/lib.rs` after `ActiveMap::new()`:
  `ResourceSampler::spawn(app_handle, active.clone(), pool.clone())` and `.manage(sampler)`.

New IPC commands in `src-tauri/src/ipc.rs`:
- `set_resource_monitor_overlay_open(open: bool)` - flips cadence.
- `get_resource_usage_now() -> Sample` - sync fetch when overlay opens, so first paint isn't blank for up to 1s.

New Cargo dep:
```toml
sysinfo = { version = "0.32", default-features = false, features = ["system"] }
```
(Skips disk/network features we don't need.)

## Frontend

- **Store** `src/store/resource-monitor.ts`:
  ```ts
  export const [resourceSample, setResourceSample] = createSignal<Sample | null>(null);
  // listen("resource_usage", ...) once at app boot, write to signal
  ```
- **Typed wrappers** in `src/lib/ipc.ts`: `setResourceMonitorOverlayOpen(open)`, `getResourceUsageNow()`.
- **`ResourceChip.tsx`**: dim placeholder when sample is `null` (no width jump); shows `RAM 1.2G · 32%` from `resourceSample().total`; subtle hover ring (`ring-1 ring-white/8` per UnoCSS conventions); click opens overlay.
- **`ResourceOverlayDialog.tsx`**: on mount calls `setResourceMonitorOverlayOpen(true)` and `getResourceUsageNow()` for instant first paint; on unmount calls `setResourceMonitorOverlayOpen(false)`. Uses `<For>` for the task table sorted by RSS desc.
- **Format helpers** in `src/lib/format.ts`: `formatBytes` (1024-base, B/KB/MB/GB), `formatPct` (0 decimals if ≥10, 1 decimal under).

## Testing

**Rust** (`resource_monitor.rs` `#[cfg(test)] mod tests`, fake `ProcessSource`):
- Two tasks with subtree descendants → correct rollup, no double-count.
- Verun-only descendants (watcher, hook) → land in `app`, not in tasks.
- Session with dead `child.id() == None` → excluded from list.
- Multiple sessions on one task → summed under one row.
- Empty active map → `tasks: []`, `total == app`.
- Tasks sorted by RSS desc.

TDD per CLAUDE.md: each test written red before the corresponding code.

**Frontend** (vitest):
- `ResourceChip.test.tsx`: formatted total when sample present, dim placeholder when null, click invokes handler.
- `ResourceOverlayDialog.test.tsx`: rows in RSS-desc order, app row separate from task rows.
- `formatBytes` / `formatPct` unit tests covering 0, B/KB/MB/GB boundaries, fractional CPU%.

**Manual smoke** (per Definition of Done):
- `pnpm tauri dev`, spawn 2-3 sessions, confirm chip updates and per-task numbers track macOS Activity Monitor within ~10%.

## File changes summary

**New:**
- `src-tauri/src/resource_monitor.rs`
- `src/store/resource-monitor.ts`
- `src/components/ResourceChip.tsx` + `.test.tsx`
- `src/components/ResourceOverlayDialog.tsx` + `.test.tsx`
- `src/lib/format.ts` + `.test.ts`

**Modified:**
- `src-tauri/Cargo.toml` - add `sysinfo`
- `src-tauri/src/lib.rs` - register module, spawn sampler, manage state
- `src-tauri/src/ipc.rs` - `set_resource_monitor_overlay_open`, `get_resource_usage_now`
- `src/lib/ipc.ts` - typed wrappers + `Sample` / `TaskStat` / `ProcessStat` types
- `src/components/Sidebar.tsx` - mount `<ResourceChip>` in the footer next to Settings
- `CHANGELOG.md` - bullet under `## Unreleased`
- `README.md` - features list, if it mentions monitoring/observability

## Risks / open questions

- **sysinfo accuracy on macOS**: RSS includes shared/copy-on-write pages, so the sum across processes can overcount real memory pressure. We accept this - it matches what macOS Activity Monitor shows by default, which is the user's reference point.
- **Hook/watcher PIDs in "Verun (app)"**: noted above; deferred until someone asks for it.
- **Task name freshness**: rename mid-session shows old name for up to one tick. Acceptable.
