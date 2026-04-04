use std::process::Command;

/// Create a new git worktree for an agent branch
pub fn create_worktree(repo_path: &str, branch: &str) -> Result<String, String> {
    let worktree_path = format!("{}/../.verun-worktrees/{}", repo_path, branch);

    // Create the branch if it doesn't exist
    let _ = Command::new("git")
        .args(["branch", branch])
        .current_dir(repo_path)
        .output();

    // Create the worktree
    let output = Command::new("git")
        .args(["worktree", "add", &worktree_path, branch])
        .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["worktree", "remove", worktree_path, "--force"])
        .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to get diff: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Merge a worktree branch into target
pub fn merge_branch(repo_path: &str, source_branch: &str, target_branch: &str) -> Result<(), String> {
    // Checkout target
    let output = Command::new("git")
        .args(["checkout", target_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to checkout {}: {}", target_branch, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("checkout failed: {}", stderr));
    }

    // Merge
    let output = Command::new("git")
        .args(["merge", source_branch, "--no-ff", "-m", &format!("Merge {} into {}", source_branch, target_branch)])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to merge: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("merge failed: {}", stderr));
    }

    Ok(())
}
