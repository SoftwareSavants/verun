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

/// If `worktree_path/.git` is a file (git worktree), parses the `gitdir:` line
/// and returns the absolute path to the actual git directory (the one that
/// holds `index`, `HEAD`, etc.). Returns an empty vec for regular repos where
/// `.git` is already a directory inside the worktree and therefore covered by
/// the recursive watch on `worktree_path`.
pub fn resolve_extra_git_dirs(worktree_path: &str) -> Vec<std::path::PathBuf> {
    let git_entry = std::path::Path::new(worktree_path).join(".git");
    if !git_entry.is_file() {
        return vec![];
    }
    let content = match std::fs::read_to_string(&git_entry) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let gitdir_str = content
        .lines()
        .find_map(|l| l.strip_prefix("gitdir:"))
        .unwrap_or("")
        .trim();
    let gitdir = std::path::Path::new(gitdir_str);
    if gitdir.is_dir() {
        vec![gitdir.to_path_buf()]
    } else {
        vec![]
    }
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
    // For git worktrees, .git is a file — resolve the actual git dir so we
    // can watch it separately and detect index/HEAD changes from there.
    let extra_git_dirs = resolve_extra_git_dirs(&worktree_path);
    let extra_git_dirs_for_watch = extra_git_dirs.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            if let Ok(events) = events {
                let mut file_dirs = std::collections::HashSet::new();
                let mut git_changed = false;
                for event in &events {
                    if event.kind == DebouncedEventKind::Any {
                        // Events from the extra git dir (worktree git state) →
                        // git-status-changed only, never file-tree-changed.
                        let from_extra_git = extra_git_dirs
                            .iter()
                            .any(|gd| event.path.starts_with(gd));
                        if from_extra_git {
                            git_changed = true;
                            continue;
                        }
                        if let Some(parent) = event.path.parent() {
                            let rel = parent
                                .strip_prefix(&wt_path)
                                .unwrap_or(parent)
                                .to_string_lossy()
                                .to_string();
                            if is_git_related(&rel) {
                                // .git/ dir in a regular (non-worktree) repo
                                git_changed = true;
                            } else {
                                file_dirs.insert(rel);
                            }
                        }
                    }
                }
                if git_changed {
                    let _ = app.emit(
                        "git-status-changed",
                        crate::stream::GitStatusChangedEvent {
                            task_id: tid.clone(),
                        },
                    );
                }
                for dir in file_dirs {
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

    // For worktrees: also watch the external git dir so stage/commit/stash
    // events from outside the worktree tree are detected.
    for git_dir in extra_git_dirs_for_watch {
        let _ = debouncer
            .watcher()
            .watch(&git_dir, notify::RecursiveMode::Recursive);
    }

    watchers.insert(task_id, debouncer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_git_related, resolve_extra_git_dirs};

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

    #[test]
    fn resolve_extra_git_dirs_empty_for_regular_repo() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let result = resolve_extra_git_dirs(dir.path().to_str().unwrap());
        assert!(result.is_empty());
    }

    #[test]
    fn resolve_extra_git_dirs_parses_worktree_gitfile() {
        let fake_gitdir = tempfile::tempdir().unwrap();
        let worktree_dir = tempfile::tempdir().unwrap();
        let gitdir_path = fake_gitdir.path().to_str().unwrap().to_string();
        std::fs::write(
            worktree_dir.path().join(".git"),
            format!("gitdir: {}\n", gitdir_path),
        )
        .unwrap();
        let result = resolve_extra_git_dirs(worktree_dir.path().to_str().unwrap());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], fake_gitdir.path());
    }

    #[test]
    fn resolve_extra_git_dirs_empty_when_no_git_entry() {
        let dir = tempfile::tempdir().unwrap();
        let result = resolve_extra_git_dirs(dir.path().to_str().unwrap());
        assert!(result.is_empty());
    }
}
