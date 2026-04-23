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
        let cleaned = url.trim_end_matches(".git").trim_end_matches('/');

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
        .args([
            "pr",
            "view",
            "--json",
            "number,url,state,title,mergeable,isDraft",
        ])
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
            "pr", "create", "--title", title, "--body", body, "--base", base,
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

// ---------------------------------------------------------------------------
// Workflow runs (GitHub Actions)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub database_id: u64,
    pub number: u64,
    pub workflow_name: String,
    pub state: String,
    pub url: String,
    pub created_at: String,
    pub head_sha: String,
    pub head_branch: String,
    pub event: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJob {
    pub database_id: u64,
    pub name: String,
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: String,
}

/// Collapse GitHub's (status, conclusion) pair into a single state the UI can render.
///
/// GitHub reports two fields:
///   - `status`: queued | in_progress | completed | waiting | requested | pending
///   - `conclusion`: success | failure | cancelled | skipped | timed_out | action_required | neutral | stale (only when completed)
///
/// We fold that down to: queued | running | success | failure | cancelled | skipped.
pub fn derive_run_state(status: &str, conclusion: Option<&str>) -> String {
    let s = status.trim().to_ascii_lowercase();
    match s.as_str() {
        "queued" | "waiting" | "requested" | "pending" => "queued",
        "in_progress" => "running",
        "completed" => match conclusion.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("success") | Some("neutral") => "success",
            Some("failure") | Some("timed_out") | Some("action_required") => "failure",
            Some("cancelled") => "cancelled",
            Some("skipped") | Some("stale") => "skipped",
            _ => "failure",
        },
        _ => s.as_str(),
    }
    .to_string()
}

fn take_string(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn take_u64(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

pub fn parse_workflow_runs(json_str: &str) -> Result<Vec<WorkflowRun>, String> {
    let items: Vec<serde_json::Value> =
        serde_json::from_str(json_str).map_err(|e| format!("parse workflow runs: {e}"))?;

    Ok(items
        .iter()
        .map(|v| WorkflowRun {
            database_id: take_u64(v, "databaseId"),
            number: take_u64(v, "number"),
            workflow_name: take_string(v, "workflowName"),
            state: derive_run_state(
                v.get("status").and_then(|s| s.as_str()).unwrap_or(""),
                v.get("conclusion").and_then(|s| s.as_str()),
            ),
            url: take_string(v, "url"),
            created_at: take_string(v, "createdAt"),
            head_sha: take_string(v, "headSha"),
            head_branch: take_string(v, "headBranch"),
            event: take_string(v, "event"),
        })
        .collect())
}

pub fn parse_workflow_jobs(json_str: &str) -> Result<Vec<WorkflowJob>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("parse jobs: {e}"))?;
    let jobs = v
        .get("jobs")
        .and_then(|j| j.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(jobs
        .iter()
        .map(|j| WorkflowJob {
            database_id: take_u64(j, "id"),
            name: take_string(j, "name"),
            state: derive_run_state(
                j.get("status").and_then(|s| s.as_str()).unwrap_or(""),
                j.get("conclusion").and_then(|s| s.as_str()),
            ),
            started_at: j
                .get("started_at")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            completed_at: j
                .get("completed_at")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            url: take_string(j, "html_url"),
        })
        .collect())
}

/// Return the last `max_bytes` bytes of `s`, snapped to a UTF-8 char boundary.
pub fn tail_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let start = s.len() - max_bytes;
    // Walk forward to a char boundary so we don't split a multi-byte codepoint.
    let mut boundary = start;
    while boundary < s.len() && !s.is_char_boundary(boundary) {
        boundary += 1;
    }
    s[boundary..].to_string()
}

fn current_branch(worktree_path: &str) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    if !out.status.success() {
        return Err("could not determine current branch".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// List recent workflow runs for the current branch (latest first).
pub fn list_workflow_runs_for_branch(
    worktree_path: &str,
    limit: u32,
) -> Result<Vec<WorkflowRun>, String> {
    let branch = current_branch(worktree_path)?;
    let limit_str = limit.to_string();
    let output = gh(worktree_path)
        .args([
            "run",
            "list",
            "--branch",
            &branch,
            "--limit",
            &limit_str,
            "--json",
            "databaseId,number,workflowName,status,conclusion,url,createdAt,headSha,headBranch,event",
        ])
        .output()
        .map_err(|e| format!("Failed to list workflow runs: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no runs") || stderr.trim().is_empty() {
            return Ok(Vec::new());
        }
        return Err(format!("gh run list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_workflow_runs(&stdout)
}

/// List jobs for a workflow run.
pub fn list_jobs_for_run(worktree_path: &str, run_id: u64) -> Result<Vec<WorkflowJob>, String> {
    let repo = detect_github_repo(worktree_path)?
        .ok_or_else(|| "not a GitHub repo".to_string())?;
    let endpoint = format!(
        "repos/{}/{}/actions/runs/{}/jobs",
        repo.owner, repo.name, run_id
    );
    let output = gh(worktree_path)
        .args(["api", &endpoint])
        .output()
        .map_err(|e| format!("Failed to list jobs: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api jobs failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_workflow_jobs(&stdout)
}

/// Fetch log output for a specific job. When `max_bytes == 0` the full log is
/// returned untruncated; otherwise the tail is trimmed to `max_bytes`.
/// Prefers `--log-failed` (only steps that failed) for signal; falls back to the full
/// `--log` when `--log-failed` returns nothing (e.g. job failed at setup/infra level
/// so no individual step is marked failed).
pub fn get_failed_step_logs(
    worktree_path: &str,
    _run_id: u64,
    job_id: u64,
    max_bytes: usize,
) -> Result<String, String> {
    let job_id_str = job_id.to_string();

    let failed = gh(worktree_path)
        .args(["run", "view", "--log-failed", "--job", &job_id_str])
        .output()
        .map_err(|e| format!("Failed to fetch logs: {e}"))?;

    let failed_stdout = String::from_utf8_lossy(&failed.stdout).to_string();
    if failed.status.success() && !failed_stdout.trim().is_empty() {
        return Ok(maybe_tail(&failed_stdout, max_bytes));
    }

    let full = gh(worktree_path)
        .args(["run", "view", "--log", "--job", &job_id_str])
        .output()
        .map_err(|e| format!("Failed to fetch logs: {e}"))?;

    let full_stdout = String::from_utf8_lossy(&full.stdout).to_string();
    if !full.status.success() && full_stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&full.stderr);
        return Err(format!("gh run view --log failed: {stderr}"));
    }

    Ok(maybe_tail(&full_stdout, max_bytes))
}

fn maybe_tail(s: &str, max_bytes: usize) -> String {
    if max_bytes == 0 { s.to_string() } else { tail_bytes(s, max_bytes) }
}

/// Re-run a workflow run. When `failed_only` is true, passes `--failed` to re-run only failed jobs.
pub fn rerun_workflow(worktree_path: &str, run_id: u64, failed_only: bool) -> Result<(), String> {
    check_gh_installed()?;
    let run_id_str = run_id.to_string();
    let mut cmd = gh(worktree_path);
    cmd.args(["run", "rerun", &run_id_str]);
    if failed_only {
        cmd.arg("--failed");
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to rerun: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh run rerun failed: {stderr}"));
    }
    Ok(())
}

/// Re-run a single job (and any jobs that depend on it) inside a workflow run.
pub fn rerun_workflow_job(worktree_path: &str, job_id: u64) -> Result<(), String> {
    check_gh_installed()?;
    let job_id_str = job_id.to_string();
    let output = gh(worktree_path)
        .args(["run", "rerun", "--job", &job_id_str])
        .output()
        .map_err(|e| format!("Failed to rerun job: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh run rerun --job failed: {stderr}"));
    }
    Ok(())
}

/// Cancel an in-progress workflow run.
pub fn cancel_workflow(worktree_path: &str, run_id: u64) -> Result<(), String> {
    check_gh_installed()?;
    let run_id_str = run_id.to_string();
    let output = gh(worktree_path)
        .args(["run", "cancel", &run_id_str])
        .output()
        .map_err(|e| format!("Failed to cancel: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh run cancel failed: {stderr}"));
    }
    Ok(())
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
    let checks: Vec<serde_json::Value> = serde_json::from_str(&stdout).unwrap_or_default();

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
            && (bytes[0] == b'U'
                || bytes[1] == b'U'
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
        assert_eq!(
            parse_merge_error("some unknown error"),
            "some unknown error"
        );
    }

    // -----------------------------------------------------------------------
    // Workflow run parsing & state derivation
    // -----------------------------------------------------------------------

    #[test]
    fn derive_state_queued() {
        assert_eq!(derive_run_state("queued", None), "queued");
        assert_eq!(derive_run_state("waiting", None), "queued");
        assert_eq!(derive_run_state("requested", None), "queued");
    }

    #[test]
    fn derive_state_running() {
        assert_eq!(derive_run_state("in_progress", None), "running");
    }

    #[test]
    fn derive_state_completed_success() {
        assert_eq!(derive_run_state("completed", Some("success")), "success");
        assert_eq!(derive_run_state("completed", Some("neutral")), "success");
    }

    #[test]
    fn derive_state_completed_failure() {
        assert_eq!(derive_run_state("completed", Some("failure")), "failure");
        assert_eq!(derive_run_state("completed", Some("timed_out")), "failure");
        assert_eq!(
            derive_run_state("completed", Some("action_required")),
            "failure"
        );
    }

    #[test]
    fn derive_state_completed_cancelled_and_skipped() {
        assert_eq!(derive_run_state("completed", Some("cancelled")), "cancelled");
        assert_eq!(derive_run_state("completed", Some("skipped")), "skipped");
        assert_eq!(derive_run_state("completed", Some("stale")), "skipped");
    }

    #[test]
    fn derive_state_completed_missing_conclusion_treated_as_failure() {
        // If gh returns `status=completed` with no conclusion, we surface it
        // as a failure rather than hiding it - user needs to know something finished oddly.
        assert_eq!(derive_run_state("completed", None), "failure");
    }

    #[test]
    fn parse_workflow_runs_empty() {
        let runs = parse_workflow_runs("[]").unwrap();
        assert!(runs.is_empty());
    }

    #[test]
    fn parse_workflow_runs_basic() {
        let json = r#"[
            {"databaseId":12345,"number":42,"workflowName":"CI","status":"in_progress","conclusion":null,"url":"https://github.com/o/r/actions/runs/12345","createdAt":"2026-04-20T10:00:00Z","headSha":"abc123","headBranch":"feat/x","event":"push"},
            {"databaseId":12340,"number":41,"workflowName":"Release","status":"completed","conclusion":"success","url":"https://github.com/o/r/actions/runs/12340","createdAt":"2026-04-19T10:00:00Z","headSha":"def456","headBranch":"feat/x","event":"workflow_dispatch"}
        ]"#;
        let runs = parse_workflow_runs(json).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].database_id, 12345);
        assert_eq!(runs[0].number, 42);
        assert_eq!(runs[0].workflow_name, "CI");
        assert_eq!(runs[0].state, "running");
        assert_eq!(runs[0].event, "push");
        assert_eq!(runs[1].state, "success");
        assert_eq!(runs[1].workflow_name, "Release");
    }

    #[test]
    fn parse_workflow_runs_invalid_json() {
        assert!(parse_workflow_runs("not json").is_err());
    }

    #[test]
    fn parse_workflow_jobs_basic() {
        let json = r#"{
            "jobs": [
                {"id":9999,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-04-20T10:00:00Z","completed_at":"2026-04-20T10:02:00Z","html_url":"https://github.com/o/r/actions/runs/1/jobs/9999"},
                {"id":9998,"name":"lint","status":"completed","conclusion":"success","started_at":"2026-04-20T10:00:00Z","completed_at":"2026-04-20T10:00:42Z","html_url":"https://github.com/o/r/actions/runs/1/jobs/9998"},
                {"id":9997,"name":"build","status":"queued","conclusion":null,"started_at":null,"completed_at":null,"html_url":""}
            ]
        }"#;
        let jobs = parse_workflow_jobs(json).unwrap();
        assert_eq!(jobs.len(), 3);
        assert_eq!(jobs[0].database_id, 9999);
        assert_eq!(jobs[0].state, "failure");
        assert_eq!(jobs[1].state, "success");
        assert_eq!(jobs[2].state, "queued");
        assert_eq!(jobs[2].started_at, None);
    }

    #[test]
    fn parse_workflow_jobs_missing_jobs_key_is_empty() {
        let jobs = parse_workflow_jobs("{}").unwrap();
        assert!(jobs.is_empty());
    }

    #[test]
    fn tail_bytes_shorter_than_max() {
        assert_eq!(tail_bytes("hello", 100), "hello");
    }

    #[test]
    fn tail_bytes_exactly_max() {
        assert_eq!(tail_bytes("hello", 5), "hello");
    }

    #[test]
    fn tail_bytes_trims_to_max() {
        assert_eq!(tail_bytes("abcdefghij", 4), "ghij");
    }

    #[test]
    fn tail_bytes_snaps_to_char_boundary() {
        // "é" is 2 bytes (0xC3 0xA9). Requesting 1 byte mid-char should advance
        // to the next boundary, yielding an empty tail rather than invalid UTF-8.
        let s = "é"; // 2 bytes
        let result = tail_bytes(s, 1);
        assert!(result.is_empty() || result == "é");
        // Key invariant: result is valid UTF-8 (asserted implicitly by String type).
        assert!(result.as_bytes().iter().all(|&b| b < 0x80) || result.chars().count() <= 1);
    }
}
