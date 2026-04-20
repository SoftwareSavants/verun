use dashmap::DashMap;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Returns true when the relative path from the worktree root refers to a git
/// internal directory (i.e. starts with `.git`). Changes there indicate a
/// staging, commit, stash, or other git state transition.
fn is_git_related(rel: &str) -> bool {
    rel == ".git" || rel.starts_with(".git/")
}

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
                let git_changed = dirs.iter().any(|d| is_git_related(d));
                if git_changed {
                    let _ = app.emit(
                        "git-status-changed",
                        crate::stream::GitStatusChangedEvent {
                            task_id: tid.clone(),
                        },
                    );
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

#[cfg(test)]
mod tests {
    use super::is_git_related;

    #[test]
    fn git_dir_itself_is_git_related() {
        assert!(is_git_related(".git"));
    }

    #[test]
    fn git_subdirs_are_git_related() {
        assert!(is_git_related(".git/refs/heads"));
        assert!(is_git_related(".git/logs"));
        assert!(is_git_related(".git/objects"));
    }

    #[test]
    fn source_paths_are_not_git_related() {
        assert!(!is_git_related("src"));
        assert!(!is_git_related("src-tauri/src"));
        assert!(!is_git_related(""));
    }

    #[test]
    fn partial_git_prefix_is_not_git_related() {
        assert!(!is_git_related(".gitignore"));
        assert!(!is_git_related(".github"));
    }
}
