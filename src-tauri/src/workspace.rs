//! Resolves existing workspaces without creating or changing files.

use serde::Serialize;

// Serialize workspace attachment with cleanup so a new task cannot attach
// between the reference check and a managed worktree's destruction.
pub static LIFECYCLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
use std::{path::Path, process::Command};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryInfo {
    pub path: String,
    pub is_git: bool,
    pub branch: String,
}

pub fn inspect_directory(path: &str) -> Result<DirectoryInfo, String> {
    let path = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Cannot open folder: {e}"))?;
    if !path.is_dir() {
        return Err("Choose an existing folder".into());
    }
    let git = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(args)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let is_git = git(&["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
    let branch = if is_git {
        git(&["symbolic-ref", "--short", "HEAD"]).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(DirectoryInfo {
        path: path.to_string_lossy().into_owned(),
        is_git,
        branch,
    })
}

pub fn has_other_users(path: &str, other_paths: &[String]) -> bool {
    let root = Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| path.into());
    other_paths.iter().any(|other| {
        Path::new(other)
            .canonicalize()
            .unwrap_or_else(|_| other.into())
            .starts_with(&root)
    })
}

/// External directories are never owned by a task. Managed worktrees may be
/// cleaned up only while no other task (including archived tasks) uses them.
pub fn allows_cleanup(existing_directory: bool, other_tasks: i64) -> bool {
    !existing_directory && other_tasks == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn nested_folders_and_path_aliases_keep_a_shared_worktree_alive() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        assert!(has_other_users(
            dir.path().to_str().unwrap(),
            &[nested.to_string_lossy().into()]
        ));
        assert!(has_other_users(
            dir.path().to_str().unwrap(),
            &[dir.path().join("src/..").to_string_lossy().into()]
        ));
        assert!(!has_other_users(
            nested.to_str().unwrap(),
            &[dir.path().join("other").to_string_lossy().into()]
        ));
    }

    #[test]
    fn existing_folder_is_canonical_and_not_git() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = inspect_directory(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(
            workspace.path,
            dir.path().canonicalize().unwrap().to_string_lossy()
        );
        assert!(!workspace.is_git);
        assert_eq!(workspace.branch, "");
    }

    #[test]
    fn existing_repo_keeps_its_branch_and_uncommitted_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .args(["init", "-b", "topic"])
            .current_dir(dir.path())
            .status()
            .unwrap()
            .success());
        std::fs::write(dir.path().join("keep.txt"), "work in progress").unwrap();
        let workspace = inspect_directory(dir.path().to_str().unwrap()).unwrap();
        assert!(workspace.is_git);
        assert_eq!(workspace.branch, "topic");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "work in progress"
        );
        assert!(!dir.path().join(".worktrees").exists());
    }

    #[test]
    fn files_and_missing_directories_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "keep").unwrap();
        assert!(inspect_directory(file.to_str().unwrap()).is_err());
        assert!(inspect_directory(dir.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn shared_or_external_workspaces_never_allow_lifecycle_cleanup() {
        assert!(!allows_cleanup(true, 0));
        assert!(!allows_cleanup(false, 1));
        assert!(allows_cleanup(false, 0));
    }
}
