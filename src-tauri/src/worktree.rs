use std::path::Path;
use std::process::Command;

/// Create a git Command isolated from any ambient git environment variables.
fn git(repo_path: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE");
    cmd
}

/// Resolve the root of a git repository from any path inside it.
pub fn get_repo_root(path: &str) -> Result<String, String> {
    validate_git_installed()?;

    let output = git(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to find repo root: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Not a git repository: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Validate that git is installed and accessible.
pub fn validate_git_installed() -> Result<(), String> {
    Command::new("git")
        .arg("--version")
        .output()
        .map_err(|_| "git is not installed or not in PATH".to_string())?;
    Ok(())
}

/// Validate that a branch name is safe for git.
pub fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    let output = Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(|e| format!("Failed to validate branch name: {e}"))?;

    if !output.status.success() {
        return Err(format!("Invalid branch name: {name}"));
    }

    Ok(())
}

/// Detect the default base branch for a repository.
/// Checks for origin/main, origin/master, then falls back to the current HEAD branch.
pub fn detect_base_branch(repo_path: &str) -> String {
    for candidate in ["main", "master"] {
        let output = git(repo_path)
            .args(["rev-parse", "--verify", &format!("origin/{candidate}")])
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                return candidate.to_string();
            }
        }
    }

    // Fallback: current HEAD branch name
    if let Ok(output) = git(repo_path).args(["rev-parse", "--abbrev-ref", "HEAD"]).output() {
        if output.status.success() {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !branch.is_empty() && branch != "HEAD" {
                return branch;
            }
        }
    }

    "main".to_string()
}

/// Create a new git worktree for a task branch, based off `base_branch`.
/// Fetches the latest from origin first (best-effort).
pub fn create_worktree(repo_path: &str, branch: &str, base_branch: &str) -> Result<String, String> {
    validate_git_installed()?;
    validate_branch_name(branch)?;

    if !Path::new(repo_path).exists() {
        return Err(format!("Repository path does not exist: {repo_path}"));
    }

    let worktree_path = format!("{}/../.verun/worktrees/{}", repo_path, branch);

    // Best-effort fetch from origin
    let _ = git(repo_path).args(["fetch", "origin", base_branch]).output();

    // Create the branch from the base branch.
    // Try origin/{base_branch} first, then local {base_branch}, then fall back to HEAD.
    let remote_ref = format!("origin/{base_branch}");
    let branch_created = git(repo_path)
        .args(["branch", branch, &remote_ref])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !branch_created {
        let local_ok = git(repo_path)
            .args(["branch", branch, base_branch])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !local_ok {
            // Last resort: branch from HEAD
            let _ = git(repo_path).args(["branch", branch]).output();
        }
    }

    let output = git(repo_path)
        .args(["worktree", "add", &worktree_path, branch])
        .output()
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    let abs_path = std::fs::canonicalize(&worktree_path)
        .map_err(|e| format!("Failed to resolve worktree path: {e}"))?
        .to_string_lossy()
        .to_string();

    Ok(abs_path)
}

/// Delete a git worktree.
pub fn delete_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = git(repo_path)
        .args(["worktree", "remove", worktree_path, "--force"])
        .output()
        .map_err(|e| format!("Failed to delete worktree: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    Ok(())
}

/// List all git worktrees for a repo.
pub fn list_worktrees(repo_path: &str) -> Result<Vec<String>, String> {
    let output = git(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to list worktrees: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .map(|line| line.trim_start_matches("worktree ").to_string())
        .collect();

    Ok(paths)
}

/// Get diff for a worktree.
pub fn get_diff(worktree_path: &str) -> Result<String, String> {
    let output = git(worktree_path)
        .args(["diff", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get diff: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Merge a worktree branch into target, then clean up the worktree.
pub fn merge_branch(repo_path: &str, source_branch: &str, target_branch: &str) -> Result<(), String> {
    let output = git(repo_path)
        .args(["checkout", target_branch])
        .output()
        .map_err(|e| format!("Failed to checkout {target_branch}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("checkout failed: {stderr}"));
    }

    let output = git(repo_path)
        .args([
            "merge",
            source_branch,
            "--no-ff",
            "-m",
            &format!("Merge {source_branch} into {target_branch}"),
        ])
        .output()
        .map_err(|e| format!("Failed to merge: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("merge failed: {stderr}"));
    }

    // Auto-cleanup: find and remove the worktree for the source branch
    if let Ok(worktrees) = list_worktrees(repo_path) {
        for wt in &worktrees {
            if wt.ends_with(source_branch) {
                let _ = delete_worktree(repo_path, wt);
                break;
            }
        }
    }

    Ok(())
}

/// Get ahead/behind counts for a worktree branch relative to its upstream or main.
/// Returns (ahead, behind).
pub fn get_branch_status(worktree_path: &str) -> Result<(u32, u32), String> {
    // Figure out the current branch
    let output = git(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get current branch: {e}"))?;

    if !output.status.success() {
        return Err("Not on a branch".to_string());
    }

    let current = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Try upstream first, fall back to main/master
    let compare_ref = find_compare_ref(worktree_path, &current)?;

    let output = git(worktree_path)
        .args(["rev-list", "--left-right", "--count", &format!("{compare_ref}...{current}")])
        .output()
        .map_err(|e| format!("Failed to get branch status: {e}"))?;

    if !output.status.success() {
        return Ok((0, 0)); // Can't compare, likely no common ancestor
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split('\t').collect();
    if parts.len() != 2 {
        return Ok((0, 0));
    }

    let behind = parts[0].parse::<u32>().unwrap_or(0);
    let ahead = parts[1].parse::<u32>().unwrap_or(0);

    Ok((ahead, behind))
}

/// Find the best ref to compare against: upstream tracking branch, or main/master.
fn find_compare_ref(worktree_path: &str, current_branch: &str) -> Result<String, String> {
    // Check for upstream tracking branch
    let output = git(worktree_path)
        .args(["config", &format!("branch.{current_branch}.merge")])
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let upstream = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !upstream.is_empty() {
                return Ok(upstream);
            }
        }
    }

    // Fall back to main or master
    for candidate in ["main", "master"] {
        let output = git(worktree_path)
            .args(["rev-parse", "--verify", candidate])
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                return Ok(candidate.to_string());
            }
        }
    }

    Err("No upstream or main/master branch found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_test_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().join("repo");
        fs::create_dir(&repo_path).unwrap();

        git(repo_path.to_str().unwrap()).args(["init"]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["config", "user.email", "test@test.com"]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["config", "user.name", "Test"]).output().unwrap();

        fs::write(repo_path.join("README.md"), "# test").unwrap();
        git(repo_path.to_str().unwrap()).args(["add", "."]).output().unwrap();
        git(repo_path.to_str().unwrap()).args(["commit", "-m", "init"]).output().unwrap();

        let path_str = repo_path.to_str().unwrap().to_string();
        (dir, path_str)
    }

    // -- Validation tests --

    #[test]
    fn git_is_installed() {
        assert!(validate_git_installed().is_ok());
    }

    #[test]
    fn valid_branch_names() {
        assert!(validate_branch_name("feature-foo").is_ok());
        assert!(validate_branch_name("fix/bar").is_ok());
        assert!(validate_branch_name("sleepy-penguin-42").is_ok());
    }

    #[test]
    fn invalid_branch_names() {
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("..").is_err());
        assert!(validate_branch_name("foo..bar").is_err());
        assert!(validate_branch_name("foo bar").is_err());
    }

    #[test]
    fn get_repo_root_works() {
        let (_dir, repo_path) = init_test_repo();
        let root = get_repo_root(&repo_path).unwrap();
        assert!(Path::new(&root).join(".git").exists());
    }

    #[test]
    fn get_repo_root_nonexistent_fails() {
        let result = get_repo_root("/nonexistent/path");
        assert!(result.is_err());
    }

    // -- Worktree tests --

    #[test]
    fn create_and_list_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "test-branch", "main").unwrap();
        assert!(Path::new(&wt_path).exists());

        let worktrees = list_worktrees(&repo_path).unwrap();
        assert!(worktrees.len() >= 2);
        assert!(worktrees.iter().any(|p| p.contains("test-branch") || p == &wt_path));
    }

    #[test]
    fn create_and_delete_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "delete-me", "main").unwrap();
        assert!(Path::new(&wt_path).exists());

        delete_worktree(&repo_path, &wt_path).unwrap();
        assert!(!Path::new(&wt_path).exists());
    }

    #[test]
    fn create_worktree_validates_repo() {
        let result = create_worktree("/nonexistent/path", "branch", "main");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn create_worktree_validates_branch_name() {
        let (_dir, repo_path) = init_test_repo();
        let result = create_worktree(&repo_path, "foo bar", "main");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid branch name"));
    }

    #[test]
    fn get_diff_empty_on_clean_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "clean-branch", "main").unwrap();
        let diff = get_diff(&wt_path).unwrap();
        assert!(diff.is_empty(), "Expected empty diff, got: {diff}");
    }

    #[test]
    fn get_diff_shows_changes() {
        let (_dir, repo_path) = init_test_repo();

        let wt_path = create_worktree(&repo_path, "dirty-branch", "main").unwrap();

        fs::write(format!("{wt_path}/new-file.txt"), "hello").unwrap();
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
    fn delete_worktree_invalid_path_fails() {
        let (_dir, repo_path) = init_test_repo();
        let result = delete_worktree(&repo_path, "/nonexistent/worktree");
        assert!(result.is_err());
    }

    // -- Merge + cleanup --

    #[test]
    fn merge_branch_cleans_up_worktree() {
        let (_dir, repo_path) = init_test_repo();

        let output = git(&repo_path).args(["branch", "--show-current"]).output().unwrap();
        let main_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        let wt_path = create_worktree(&repo_path, "merge-cleanup", "main").unwrap();
        fs::write(format!("{wt_path}/feature.txt"), "feature").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();
        git(&wt_path).args(["commit", "-m", "add feature"]).output().unwrap();

        let result = merge_branch(&repo_path, "merge-cleanup", &main_branch);
        assert!(result.is_ok(), "merge failed: {:?}", result.err());

        // Feature file should exist in main
        assert!(Path::new(&format!("{repo_path}/feature.txt")).exists());

        // Worktree should have been cleaned up
        assert!(!Path::new(&wt_path).exists());
    }

    // -- Branch status --

    #[test]
    fn branch_status_on_fresh_worktree() {
        let (_dir, repo_path) = init_test_repo();
        let wt_path = create_worktree(&repo_path, "status-test", "main").unwrap();

        let (ahead, behind) = get_branch_status(&wt_path).unwrap();
        assert_eq!(ahead, 0);
        assert_eq!(behind, 0);
    }

    #[test]
    fn branch_status_with_commits_ahead() {
        let (_dir, repo_path) = init_test_repo();
        let wt_path = create_worktree(&repo_path, "ahead-test", "main").unwrap();

        fs::write(format!("{wt_path}/new.txt"), "new").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();
        git(&wt_path).args(["commit", "-m", "ahead"]).output().unwrap();

        let (ahead, behind) = get_branch_status(&wt_path).unwrap();
        assert_eq!(ahead, 1);
        assert_eq!(behind, 0);
    }
}
