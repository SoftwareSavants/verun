use serde::Serialize;
use std::process::Command;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepo {
    pub owner: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u32,
    pub url: String,
    pub state: String,
    pub title: String,
    pub mergeable: String,
    pub is_draft: bool,
}

// ---------------------------------------------------------------------------
// gh CLI helpers
// ---------------------------------------------------------------------------

fn gh(cwd: &str) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(cwd);
    cmd
}

/// Check if `gh` CLI is installed and authenticated.
pub fn check_gh_installed() -> Result<(), String> {
    let output = Command::new("gh")
        .args(["auth", "status"])
        .output()
        .map_err(|_| "gh CLI is not installed".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not logged in") {
            return Err("Not logged in to GitHub. Run `gh auth login` first.".to_string());
        }
    }
    Ok(())
}

/// Detect if a repo has a GitHub remote. Parses `origin` URL.
pub fn detect_github_repo(worktree_path: &str) -> Result<Option<GitHubRepo>, String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| format!("Failed to get remote URL: {e}"))?;

    if !output.status.success() {
        return Ok(None); // No origin remote
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_github_url(&url)
}

fn parse_github_url(url: &str) -> Result<Option<GitHubRepo>, String> {
    // SSH: git@github.com:owner/repo.git
    if let Some(rest) = url.strip_prefix("git@github.com:") {
        let repo_part = rest.trim_end_matches(".git");
        if let Some((owner, name)) = repo_part.split_once('/') {
            return Ok(Some(GitHubRepo {
                owner: owner.to_string(),
                name: name.to_string(),
                url: format!("https://github.com/{owner}/{name}"),
            }));
        }
    }

    // HTTPS: https://github.com/owner/repo.git
    if url.contains("github.com") {
        let cleaned = url
            .trim_end_matches(".git")
            .trim_end_matches('/');

        // Extract path after github.com
        if let Some(idx) = cleaned.find("github.com/") {
            let path = &cleaned[idx + "github.com/".len()..];
            if let Some((owner, name)) = path.split_once('/') {
                return Ok(Some(GitHubRepo {
                    owner: owner.to_string(),
                    name: name.to_string(),
                    url: format!("https://github.com/{owner}/{name}"),
                }));
            }
        }
    }

    Ok(None)
}

// ---------------------------------------------------------------------------
// PR operations
// ---------------------------------------------------------------------------

/// Get the PR for the current branch (if one exists).
pub fn get_pr_for_branch(worktree_path: &str) -> Result<Option<PrInfo>, String> {
    let output = gh(worktree_path)
        .args(["pr", "view", "--json", "number,url,state,title,mergeable,isDraft"])
        .output()
        .map_err(|e| format!("Failed to check PR: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no pull requests found") || stderr.contains("Could not resolve") {
            return Ok(None);
        }
        return Err(format!("gh pr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse PR JSON: {e}"))?;

    Ok(Some(PrInfo {
        number: json["number"].as_u64().unwrap_or(0) as u32,
        url: json["url"].as_str().unwrap_or("").to_string(),
        state: json["state"].as_str().unwrap_or("").to_string(),
        title: json["title"].as_str().unwrap_or("").to_string(),
        mergeable: json["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
        is_draft: json["isDraft"].as_bool().unwrap_or(false),
    }))
}

/// Create a pull request.
pub fn create_pr(
    worktree_path: &str,
    title: &str,
    body: &str,
    base: &str,
) -> Result<PrInfo, String> {
    check_gh_installed()?;

    let output = gh(worktree_path)
        .args([
            "pr",
            "create",
            "--title",
            title,
            "--body",
            body,
            "--base",
            base,
        ])
        .output()
        .map_err(|e| format!("Failed to create PR: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr create failed: {stderr}"));
    }

    // The output is the PR URL
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Fetch the full PR info
    if let Ok(Some(pr)) = get_pr_for_branch(worktree_path) {
        return Ok(pr);
    }

    // Fallback: construct from URL
    let number = url
        .rsplit('/')
        .next()
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0);

    Ok(PrInfo {
        number,
        url,
        state: "OPEN".to_string(),
        title: title.to_string(),
        mergeable: "UNKNOWN".to_string(),
        is_draft: false,
    })
}

/// Mark a draft PR as ready for review.
pub fn mark_pr_ready(worktree_path: &str) -> Result<(), String> {
    check_gh_installed()?;

    let output = gh(worktree_path)
        .args(["pr", "ready"])
        .output()
        .map_err(|e| format!("Failed to mark PR ready: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr ready failed: {stderr}"));
    }

    Ok(())
}

/// Merge the PR for the current branch.
/// When `force` is true, passes `--admin` to bypass branch protection rules.
/// When `delete_branch` is true, passes `--delete-branch` to remove the remote branch.
pub fn merge_pr(worktree_path: &str, force: bool, delete_branch: bool) -> Result<(), String> {
    check_gh_installed()?;

    // Don't pass --delete-branch to gh: it tries `git checkout main` locally,
    // which fails when main is already checked out by the main worktree.
    let mut cmd = gh(worktree_path);
    cmd.args(["pr", "merge", "--merge"]);
    if force {
        cmd.arg("--admin");
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to merge PR: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let msg = parse_merge_error(&stderr);
        return Err(msg);
    }

    if delete_branch {
        let _ = delete_remote_branch(worktree_path);
    }

    Ok(())
}

fn delete_remote_branch(worktree_path: &str) -> Result<(), String> {
    let branch = Command::new("git")
        .current_dir(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("failed to get branch: {e}"))?;

    if !branch.status.success() {
        return Err("could not determine current branch".into());
    }

    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();

    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["push", "origin", "--delete", &branch])
        .output()
        .map_err(|e| format!("failed to delete remote branch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("failed to delete remote branch: {stderr}"));
    }

    Ok(())
}

fn parse_merge_error(stderr: &str) -> String {
    let s = stderr.trim();

    if let Some(pos) = s.find("is not mergeable:") {
        let after = s[pos + "is not mergeable:".len()..].trim();
        let reason = after
            .split(". To ")
            .next()
            .unwrap_or(after)
            .trim_end_matches('.');
        return capitalize(reason);
    }

    if let Some(pos) = s.find("not mergeable") {
        let after = s[pos..].trim();
        return capitalize(after);
    }

    s.strip_prefix("gh pr merge failed: ")
        .unwrap_or(s)
        .to_string()
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().to_string() + c.as_str(),
    }
}

// ---------------------------------------------------------------------------
// CI checks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub status: String,
    pub url: String,
}

/// Get CI check statuses for the current branch's PR.
pub fn get_ci_checks(worktree_path: &str) -> Result<Vec<CiCheck>, String> {
    let output = gh(worktree_path)
        .args(["pr", "checks", "--json", "name,state,detailsUrl"])
        .output()
        .map_err(|e| format!("Failed to get CI checks: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new()); // No PR or no checks
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let checks: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).unwrap_or_default();

    Ok(checks
        .iter()
        .map(|c| CiCheck {
            name: c["name"].as_str().unwrap_or("").to_string(),
            status: c["state"].as_str().unwrap_or("").to_string(),
            url: c["detailsUrl"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

/// Construct the GitHub URL for viewing the branch.
pub fn get_branch_url(worktree_path: &str) -> Result<Option<String>, String> {
    let repo = detect_github_repo(worktree_path)?;
    let repo = match repo {
        Some(r) => r,
        None => return Ok(None),
    };

    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get branch: {e}"))?;

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Check if branch exists on remote
    let remote_check = Command::new("git")
        .current_dir(worktree_path)
        .args(["ls-remote", "--heads", "origin", &branch])
        .output()
        .map_err(|e| format!("Failed to check remote: {e}"))?;

    let remote_output = String::from_utf8_lossy(&remote_check.stdout);
    if remote_output.trim().is_empty() {
        return Ok(None); // Branch not pushed
    }

    Ok(Some(format!("{}/tree/{}", repo.url, branch)))
}

/// Check if there are merge conflicts in the worktree.
pub fn has_conflicts(worktree_path: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to check conflicts: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().any(|line| {
        let bytes = line.as_bytes();
        bytes.len() >= 2
            && (bytes[0] == b'U' || bytes[1] == b'U'
                || (bytes[0] == b'A' && bytes[1] == b'A')
                || (bytes[0] == b'D' && bytes[1] == b'D'))
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_url() {
        let result = parse_github_url("git@github.com:user/repo.git").unwrap();
        let repo = result.unwrap();
        assert_eq!(repo.owner, "user");
        assert_eq!(repo.name, "repo");
        assert_eq!(repo.url, "https://github.com/user/repo");
    }

    #[test]
    fn parse_https_url() {
        let result = parse_github_url("https://github.com/org/project.git").unwrap();
        let repo = result.unwrap();
        assert_eq!(repo.owner, "org");
        assert_eq!(repo.name, "project");
    }

    #[test]
    fn parse_https_no_git_suffix() {
        let result = parse_github_url("https://github.com/org/project").unwrap();
        let repo = result.unwrap();
        assert_eq!(repo.owner, "org");
        assert_eq!(repo.name, "project");
    }

    #[test]
    fn parse_non_github_url() {
        let result = parse_github_url("https://gitlab.com/org/project.git").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn parse_empty_url() {
        let result = parse_github_url("").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn merge_error_branch_protection() {
        let stderr = "X Pull request SoftwareSavants/verun#24 is not mergeable: the base branch policy prohibits the merge. To have the pull request merged after all the requirements have been met, add the `--auto` flag. To use administrator privileges to immediately merge the pull request, add the `--admin` flag.";
        assert_eq!(
            parse_merge_error(stderr),
            "The base branch policy prohibits the merge"
        );
    }

    #[test]
    fn merge_error_passthrough() {
        assert_eq!(parse_merge_error("some unknown error"), "some unknown error");
    }
}
