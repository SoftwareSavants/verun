use std::process::Command;

/// Create a git Command isolated from any ambient git environment variables.
/// This prevents interference when Verun is invoked from inside a git hook
/// or another git-aware context.
fn git(repo_path: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE");
    cmd
}

/// Create a new git worktree for an agent branch
pub fn create_worktree(repo_path: &str, branch: &str) -> Result<String, String> {
    let worktree_path = format!("{}/../.verun/worktrees/{}", repo_path, branch);

    // Create the branch if it doesn't exist
    let _ = git(repo_path).args(["branch", branch]).output();

    // Create the worktree
    let output = git(repo_path)
        .args(["worktree", "add", &worktree_path, branch])
        .output()
        .map_err(|e| format!("Failed to create worktree: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    // Resolve to absolute path
    let abs_path = std::fs::canonicalize(&worktree_path)
        .map_err(|e| format!("Failed to resolve worktree path: {}", e))?
        .to_string_lossy()
        .to_string();

    Ok(abs_path)
}

/// Delete a git worktree
pub fn delete_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = git(repo_path)
        .args(["worktree", "remove", worktree_path, "--force"])
        .output()
        .map_err(|e| format!("Failed to delete worktree: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {}", stderr));
    }

    Ok(())
}

/// List all git worktrees for a repo
pub fn list_worktrees(repo_path: &str) -> Result<Vec<String>, String> {
    let output = git(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .map(|line| line.trim_start_matches("worktree ").to_string())
        .collect();

    Ok(paths)
}

/// Get diff for a worktree
pub fn get_diff(worktree_path: &str) -> Result<String, String> {
    let output = git(worktree_path)
        .args(["diff", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get diff: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Merge a worktree branch into target
pub fn merge_branch(repo_path: &str, source_branch: &str, target_branch: &str) -> Result<(), String> {
    let output = git(repo_path)
        .args(["checkout", target_branch])
        .output()
        .map_err(|e| format!("Failed to checkout {}: {}", target_branch, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("checkout failed: {}", stderr));
    }

    let output = git(repo_path)
        .args(["merge", source_branch, "--no-ff", "-m", &format!("Merge {} into {}", source_branch, target_branch)])
        .output()
        .map_err(|e| format!("Failed to merge: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("merge failed: {}", stderr));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Set up a fresh git repo inside a nested `repo/` subdir of a temp directory.
    /// This ensures the `../` in the worktree path formula stays inside the temp dir,
    /// preventing collisions between parallel tests.
    fn init_test_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().join("repo");
        fs::create_dir(&repo_path).unwrap();

        git(repo_path.to_str().unwrap()).args(["init"]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["config", "user.email", "test@test.com"]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["config", "user.name", "Test"]).output().unwrap();

        // Need at least one commit for worktrees to work
        fs::write(repo_path.join("README.md"), "# test").unwrap();
        git(repo_path.to_str().unwrap()).args(["add", "."]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["commit", "-m", "init"]).output().unwrap();

        let path_str = repo_path.to_str().unwrap().to_string();
        (dir, path_str)
    }

    #[test]
    fn create_and_list_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "test-branch").unwrap();
        assert!(std::path::Path::new(&wt_path).exists());

        let worktrees = list_worktrees(&repo_path).unwrap();
        assert!(worktrees.len() >= 2);
        assert!(worktrees.iter().any(|p| p.contains("test-branch") || p == &wt_path));
    }

    #[test]
    fn create_and_delete_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "delete-me").unwrap();
        assert!(std::path::Path::new(&wt_path).exists());

        delete_worktree(&repo_path, &wt_path).unwrap();
        assert!(!std::path::Path::new(&wt_path).exists());
    }

    #[test]
    fn get_diff_empty_on_clean_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "clean-branch").unwrap();
        let diff = get_diff(&wt_path).unwrap();
        assert!(diff.is_empty(), "Expected empty diff on clean worktree, got: {}", diff);
    }

    #[test]
    fn get_diff_shows_changes() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "dirty-branch").unwrap();

        fs::write(format!("{}/new-file.txt", wt_path), "hello").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();

        let diff = get_diff(&wt_path).unwrap();
        assert!(diff.contains("new-file.txt"));
        assert!(diff.contains("hello"));
    }

    #[test]
    fn list_worktrees_on_fresh_repo() {
        let (_dir, repo_path) = init_test_repo();

        let worktrees = list_worktrees(&repo_path).unwrap();
        assert_eq!(worktrees.len(), 1);
    }

    #[test]
    fn create_worktree_invalid_repo_fails() {
        let result = create_worktree("/nonexistent/path", "branch");
        assert!(result.is_err());
    }

    #[test]
    fn delete_worktree_invalid_path_fails() {
        let (_dir, repo_path) = init_test_repo();

        let result = delete_worktree(&repo_path, "/nonexistent/worktree");
        assert!(result.is_err());
    }

    #[test]
    fn merge_branch_works() {
        let (_dir, repo_path) = init_test_repo();

        let output = git(&repo_path).args(["branch", "--show-current"]).output().unwrap();
        let main_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        let wt_path = create_worktree(&repo_path, "merge-src").unwrap();
        fs::write(format!("{}/feature.txt", wt_path), "feature").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();
        git(&wt_path).args(["commit", "-m", "add feature"]).output().unwrap();

        delete_worktree(&repo_path, &wt_path).unwrap();

        let result = merge_branch(&repo_path, "merge-src", &main_branch);
        assert!(result.is_ok(), "merge failed: {:?}", result.err());

        assert!(std::path::Path::new(&format!("{}/feature.txt", repo_path)).exists());
    }
}
