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
    if let Ok(output) = git(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
    {
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

    let worktree_path = format!("{}/.verun/worktrees/{}", repo_path, branch);

    // Best-effort fetch from origin
    let _ = git(repo_path)
        .args(["fetch", "origin", base_branch])
        .output();

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

/// Build env vars for a task: VERUN_PORT_0–9 and VERUN_REPO_PATH.
pub fn verun_env_vars(port_offset: i64, repo_path: &str) -> Vec<(String, String)> {
    let base_port = 10000 + port_offset * 10;
    let mut vars: Vec<(String, String)> = (0..10)
        .map(|i| (format!("VERUN_PORT_{i}"), format!("{}", base_port + i)))
        .collect();
    vars.push(("VERUN_REPO_PATH".into(), repo_path.into()));
    vars
}

/// Run a shell command in the given directory with optional env vars.
/// Skips silently if the command is empty. Returns Err with stderr on failure.
pub fn run_hook(cwd: &str, command: &str, env_vars: &[(String, String)]) -> Result<(), String> {
    if command.is_empty() {
        return Ok(());
    }

    let mut cmd = Command::new("sh");
    cmd.args(["-c", command]).current_dir(cwd);
    for (k, v) in env_vars {
        cmd.env(k, v);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run hook: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Hook failed: {stderr}"));
    }

    Ok(())
}

/// Get the last commit message for a branch.
pub fn last_commit_message(repo_path: &str, branch: &str) -> Option<String> {
    git(repo_path)
        .args(["log", "-1", "--format=%s", branch])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Check if a worktree path exists on disk and its branch exists in the repo.
pub fn check_worktree_exists(repo_path: &str, worktree_path: &str, branch: &str) -> (bool, bool) {
    let worktree_exists = std::path::Path::new(worktree_path).is_dir();
    let branch_exists = git(repo_path)
        .args(["rev-parse", "--verify", branch])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    (worktree_exists, branch_exists)
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

/// Delete a git branch.
pub fn delete_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    let output = git(repo_path)
        .args(["branch", "-D", branch])
        .output()
        .map_err(|e| format!("Failed to delete branch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch -D failed: {stderr}"));
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
pub fn merge_branch(
    repo_path: &str,
    source_branch: &str,
    target_branch: &str,
) -> Result<(), String> {
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

/// Get ahead/behind counts for a worktree branch.
/// Returns (ahead_of_base, behind_base, unpushed):
/// - ahead_of_base = commits on this branch not in origin/main — for PR indicators
/// - behind_base = commits on origin/main not in this branch — needs rebase
/// - unpushed = commits on this branch not pushed to origin/<branch> — for push button
pub fn get_branch_status(worktree_path: &str) -> Result<(u32, u32, u32), String> {
    let current = get_current_branch(worktree_path)?;
    let base_ref = find_compare_ref(worktree_path, &current)?;
    let (behind, ahead) = rev_list_left_right(worktree_path, &base_ref, &current);

    // Check unpushed commits against origin/<branch>
    let tracking = format!("origin/{current}");
    let unpushed = if ref_exists(worktree_path, &tracking) {
        let (_, u) = rev_list_left_right(worktree_path, &tracking, &current);
        u
    } else if branch_has_remote_config(worktree_path, &current) {
        // Remote branch was deleted (e.g., after PR merge with delete branch).
        // Use patch-equivalence to find commits not yet on the base branch.
        count_cherry_commits(worktree_path, &base_ref)
    } else {
        // No remote tracking branch yet — everything is unpushed
        ahead
    };

    Ok((ahead, behind, unpushed))
}

fn get_current_branch(worktree_path: &str) -> Result<String, String> {
    let output = git(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get current branch: {e}"))?;

    if !output.status.success() {
        return Err("Not on a branch".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn branch_has_remote_config(worktree_path: &str, branch: &str) -> bool {
    git(worktree_path)
        .args(["config", &format!("branch.{branch}.remote")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn count_cherry_commits(worktree_path: &str, base_ref: &str) -> u32 {
    let output = git(worktree_path)
        .args(["cherry", base_ref])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|line| line.starts_with('+'))
                .count() as u32
        }
        _ => 0,
    }
}

fn ref_exists(worktree_path: &str, refname: &str) -> bool {
    git(worktree_path)
        .args(["rev-parse", "--verify", "--quiet", refname])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Returns (left_count, right_count) from `git rev-list --left-right --count left...right`
fn rev_list_left_right(worktree_path: &str, left: &str, right: &str) -> (u32, u32) {
    let output = git(worktree_path)
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{left}...{right}"),
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split('\t').collect();
    if parts.len() != 2 {
        return (0, 0);
    }

    (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
}

/// Find the base branch (main/master) to compare ahead count against.
fn find_compare_ref(worktree_path: &str, _current_branch: &str) -> Result<String, String> {
    // Try origin/main, origin/master first (most up-to-date)
    for candidate in ["origin/main", "origin/master", "main", "master"] {
        if ref_exists(worktree_path, candidate) {
            return Ok(candidate.to_string());
        }
    }

    Err("No main/master branch found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_test_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().join("repo");
        fs::create_dir(&repo_path).unwrap();

        git(repo_path.to_str().unwrap())
            .args(["init"])
            .output()
            .unwrap();
        git(repo_path.to_str().unwrap())
            .args(["config", "user.email", "test@test.com"])
            .output()
            .unwrap();
        git(repo_path.to_str().unwrap())
            .args(["config", "user.name", "Test"])
            .output()
            .unwrap();

        fs::write(repo_path.join("README.md"), "# test").unwrap();
        git(repo_path.to_str().unwrap())
            .args(["add", "."])
            .output()
            .unwrap();
        git(repo_path.to_str().unwrap())
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();

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
        assert!(worktrees
            .iter()
            .any(|p| p.contains("test-branch") || p == &wt_path));
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

        let output = git(&repo_path)
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        let main_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        let wt_path = create_worktree(&repo_path, "merge-cleanup", "main").unwrap();
        fs::write(format!("{wt_path}/feature.txt"), "feature").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();
        git(&wt_path)
            .args(["commit", "-m", "add feature"])
            .output()
            .unwrap();

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

        let (ahead, behind, _unpushed) = get_branch_status(&wt_path).unwrap();
        assert_eq!(ahead, 0);
        assert_eq!(behind, 0);
    }

    #[test]
    fn branch_status_with_commits_ahead() {
        let (_dir, repo_path) = init_test_repo();
        let wt_path = create_worktree(&repo_path, "ahead-test", "main").unwrap();

        fs::write(format!("{wt_path}/new.txt"), "new").unwrap();
        git(&wt_path).args(["add", "."]).output().unwrap();
        git(&wt_path)
            .args(["commit", "-m", "ahead"])
            .output()
            .unwrap();

        let (ahead, behind, _unpushed) = get_branch_status(&wt_path).unwrap();
        assert_eq!(ahead, 1);
        assert_eq!(behind, 0);
    }

    #[test]
    fn branch_status_behind_when_main_has_new_commits() {
        // When main advances, the branch should report as behind
        let (_dir, repo_path) = init_test_repo();
        let wt_path = create_worktree(&repo_path, "behind-main-test", "main").unwrap();

        // Make a commit on main
        fs::write(format!("{repo_path}/main-change.txt"), "main").unwrap();
        git(&repo_path).args(["add", "."]).output().unwrap();
        git(&repo_path)
            .args(["commit", "-m", "main change"])
            .output()
            .unwrap();

        let (ahead, behind, _unpushed) = get_branch_status(&wt_path).unwrap();
        assert_eq!(behind, 1, "should be 1 behind main");
        assert_eq!(ahead, 0);
    }

    /// Helper: create a bare "remote" repo, clone it, and return (tempdir, clone_path)
    fn init_test_repo_with_remote() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();

        // Create bare remote
        let bare_path = dir.path().join("remote.git");
        fs::create_dir(&bare_path).unwrap();
        git(bare_path.to_str().unwrap())
            .args(["init", "--bare"])
            .output()
            .unwrap();

        // Clone it
        let clone_path = dir.path().join("clone");
        std::process::Command::new("git")
            .current_dir(dir.path())
            .args([
                "clone",
                bare_path.to_str().unwrap(),
                clone_path.to_str().unwrap(),
            ])
            .output()
            .unwrap();

        let cp = clone_path.to_str().unwrap();
        git(cp)
            .args(["config", "user.email", "test@test.com"])
            .output()
            .unwrap();
        git(cp)
            .args(["config", "user.name", "Test"])
            .output()
            .unwrap();

        // Initial commit + push
        fs::write(clone_path.join("README.md"), "# test").unwrap();
        git(cp).args(["add", "."]).output().unwrap();
        git(cp).args(["commit", "-m", "init"]).output().unwrap();
        git(cp)
            .args(["push", "-u", "origin", "main"])
            .output()
            .unwrap();

        let bp = bare_path.to_str().unwrap().to_string();
        (dir, cp.to_string(), bp)
    }

    #[test]
    fn branch_status_behind_origin_main() {
        let (_dir, clone_path, bare_path) = init_test_repo_with_remote();

        // Create a feature branch
        git(&clone_path)
            .args(["checkout", "-b", "feature"])
            .output()
            .unwrap();
        fs::write(format!("{clone_path}/feature.txt"), "feat").unwrap();
        git(&clone_path).args(["add", "."]).output().unwrap();
        git(&clone_path)
            .args(["commit", "-m", "feature commit"])
            .output()
            .unwrap();

        // Simulate someone else pushing to origin/main
        let other_clone = _dir.path().join("other");
        std::process::Command::new("git")
            .current_dir(_dir.path())
            .args(["clone", &bare_path, other_clone.to_str().unwrap()])
            .output()
            .unwrap();
        let oc = other_clone.to_str().unwrap();
        git(oc)
            .args(["config", "user.email", "other@test.com"])
            .output()
            .unwrap();
        git(oc)
            .args(["config", "user.name", "Other"])
            .output()
            .unwrap();
        fs::write(format!("{oc}/other.txt"), "other").unwrap();
        git(oc).args(["add", "."]).output().unwrap();
        git(oc)
            .args(["commit", "-m", "main advance"])
            .output()
            .unwrap();
        git(oc).args(["push"]).output().unwrap();

        // Fetch in original clone so it sees the new origin/main
        git(&clone_path).args(["fetch"]).output().unwrap();

        let (ahead, behind, _unpushed) = get_branch_status(&clone_path).unwrap();
        assert_eq!(ahead, 1, "should be 1 ahead of origin/main");
        assert_eq!(behind, 1, "should be 1 behind origin/main");
    }

    #[test]
    fn branch_status_not_behind_when_main_unchanged() {
        let (_dir, clone_path, _bare_path) = init_test_repo_with_remote();

        // Create a branch — main hasn't changed so behind should be 0
        git(&clone_path)
            .args(["checkout", "-b", "up-to-date"])
            .output()
            .unwrap();
        fs::write(format!("{clone_path}/file.txt"), "content").unwrap();
        git(&clone_path).args(["add", "."]).output().unwrap();
        git(&clone_path)
            .args(["commit", "-m", "commit"])
            .output()
            .unwrap();

        let (ahead, behind, _unpushed) = get_branch_status(&clone_path).unwrap();
        assert_eq!(ahead, 1, "should be 1 ahead of origin/main");
        assert_eq!(behind, 0, "should not be behind when main hasn't changed");
    }

    // -- Hook tests --

    #[test]
    fn run_hook_empty_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        assert!(run_hook(dir.path().to_str().unwrap(), "", &[]).is_ok());
    }

    #[test]
    fn run_hook_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        run_hook(cwd, "echo hello > hook-test.txt", &[]).unwrap();
        let content = fs::read_to_string(dir.path().join("hook-test.txt")).unwrap();
        assert!(content.contains("hello"));
    }

    #[test]
    fn run_hook_fails_on_bad_command() {
        let dir = tempfile::tempdir().unwrap();
        let result = run_hook(dir.path().to_str().unwrap(), "false", &[]);
        assert!(result.is_err());
    }

    #[test]
    fn run_hook_runs_in_correct_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        run_hook(cwd, "pwd > cwd-test.txt", &[]).unwrap();
        let content = fs::read_to_string(dir.path().join("cwd-test.txt")).unwrap();
        let canonical = fs::canonicalize(dir.path()).unwrap();
        assert_eq!(content.trim(), canonical.to_str().unwrap());
    }

    #[test]
    fn run_hook_injects_env_vars() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let vars = verun_env_vars(0, "/tmp/repo");
        run_hook(
            cwd,
            "echo $VERUN_PORT_0 $VERUN_REPO_PATH > env-test.txt",
            &vars,
        )
        .unwrap();
        let content = fs::read_to_string(dir.path().join("env-test.txt")).unwrap();
        assert!(content.contains("10000"));
        assert!(content.contains("/tmp/repo"));
    }

    #[test]
    fn verun_env_vars_port_offset() {
        let vars = verun_env_vars(3, "/repo");
        let port_0 = vars.iter().find(|(k, _)| k == "VERUN_PORT_0").unwrap();
        assert_eq!(port_0.1, "10030"); // 10000 + 3*10
        let port_9 = vars.iter().find(|(k, _)| k == "VERUN_PORT_9").unwrap();
        assert_eq!(port_9.1, "10039");
        let repo = vars.iter().find(|(k, _)| k == "VERUN_REPO_PATH").unwrap();
        assert_eq!(repo.1, "/repo");
    }
}
