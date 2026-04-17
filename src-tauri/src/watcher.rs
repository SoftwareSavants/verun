use dashmap::DashMap;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type FileWatcherMap =
    Arc<DashMap<String, notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>;

pub fn new_file_watcher_map() -> FileWatcherMap {
    Arc::new(DashMap::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeChangedEvent {
    pub task_id: String,
    pub path: String,
}

pub fn start_watching(
    watchers: &FileWatcherMap,
    app: AppHandle,
    task_id: String,
    worktree_path: String,
) -> Result<(), String> {
    // Already watching this task
    if watchers.contains_key(&task_id) {
        return Ok(());
    }

    let tid = task_id.clone();
    let wt_path = worktree_path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            if let Ok(events) = events {
                // Collect unique parent directories that changed
                let mut dirs = std::collections::HashSet::new();
                for event in &events {
                    if event.kind == DebouncedEventKind::Any {
                        if let Some(parent) = event.path.parent() {
                            let rel = parent
                                .strip_prefix(&wt_path)
                                .unwrap_or(parent)
                                .to_string_lossy()
                                .to_string();
                            dirs.insert(rel);
                        }
                    }
                }
                for dir in dirs {
                    let _ = app.emit(
                        "file-tree-changed",
                        FileTreeChangedEvent {
                            task_id: tid.clone(),
                            path: dir,
                        },
                    );
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create file watcher: {e}"))?;

    let path = std::path::Path::new(&worktree_path);
    debouncer
        .watcher()
        .watch(path, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch {worktree_path}: {e}"))?;

    watchers.insert(task_id, debouncer);
    Ok(())
}
