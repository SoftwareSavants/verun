use serde::Serialize;
use std::process::Command;

/// Create a git Command isolated from ambient git environment variables.
fn git(cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE");
    cmd
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub status: String,
    pub staging: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffStats {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub files: Vec<FileStatus>,
    pub stats: Vec<FileDiffStats>,
    pub total_insertions: u32,
    pub total_deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub hunks: Vec<DiffHunk>,
    pub stats: FileDiffStats,
    pub total_lines: u32,
}

// ---------------------------------------------------------------------------
// Git status
// ---------------------------------------------------------------------------

/// Get structured git status for a worktree: file list + diff stats.
pub fn get_git_status(worktree_path: &str) -> Result<GitStatus, String> {
    let files = parse_porcelain_status(worktree_path)?;
    let stats = parse_numstat(worktree_path)?;

    let total_insertions = stats.iter().map(|s| s.insertions).sum();
    let total_deletions = stats.iter().map(|s| s.deletions).sum();

    Ok(GitStatus {
        files,
        stats,
        total_insertions,
        total_deletions,
    })
}

fn parse_porcelain_status(worktree_path: &str) -> Result<Vec<FileStatus>, String> {
    let output = git(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git status: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }

        let index_status = line.as_bytes()[0];
        let worktree_status = line.as_bytes()[1];
        let path_part = &line[3..];

        // Handle renames: "R  old -> new"
        let (path, old_path) = if path_part.contains(" -> ") {
            let parts: Vec<&str> = path_part.splitn(2, " -> ").collect();
            (parts[1].to_string(), Some(parts[0].to_string()))
        } else {
            (path_part.to_string(), None)
        };

        let (status, staging) = match (index_status, worktree_status) {
            (b'?', b'?') => ("?", "untracked"),
            (b'A', b' ') | (b'A', b'M') => ("A", "staged"),
            (b'M', b' ') => ("M", "staged"),
            (b'M', b'M') => ("M", "staged"), // staged + unstaged modifications
            (b' ', b'M') => ("M", "unstaged"),
            (b'D', b' ') => ("D", "staged"),
            (b' ', b'D') => ("D", "unstaged"),
            (b'R', _) => ("R", "staged"),
            (b'C', _) => ("C", "staged"),
            (b'U', _) | (_, b'U') => ("U", "unstaged"), // unmerged
            _ => {
                let s = String::from_utf8_lossy(&[index_status]).to_string();
                // Skip unknown statuses
                if s.trim().is_empty() && worktree_status == b' ' {
                    continue;
                }
                ("M", "unstaged")
            }
        };

        // Skip directories (untracked dirs end with '/')
        if path.ends_with('/') {
            continue;
        }

        files.push(FileStatus {
            path,
            status: status.to_string(),
            staging: staging.to_string(),
            old_path,
        });
    }

    Ok(files)
}

fn parse_numstat(worktree_path: &str) -> Result<Vec<FileDiffStats>, String> {
    // Get stats for both staged and unstaged changes
    let output = git(worktree_path)
        .args(["diff", "HEAD", "--numstat"])
        .output()
        .map_err(|e| format!("Failed to run git diff --numstat: {e}"))?;

    // HEAD might not exist yet (no commits) — fall back to diff of staged
    let stdout = if !output.status.success() {
        let fallback = git(worktree_path)
            .args(["diff", "--cached", "--numstat"])
            .output()
            .map_err(|e| format!("Failed to run git diff --cached --numstat: {e}"))?;
        String::from_utf8_lossy(&fallback.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    let mut stats = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }

        // Binary files show "-" for insertions/deletions
        let insertions = parts[0].parse::<u32>().unwrap_or(0);
        let deletions = parts[1].parse::<u32>().unwrap_or(0);
        let path = parts[2].to_string();

        stats.push(FileDiffStats {
            path,
            insertions,
            deletions,
        });
    }

    Ok(stats)
}

// ---------------------------------------------------------------------------
// Per-file diff
// ---------------------------------------------------------------------------

/// Get a structured diff for a single file.
/// `context_lines` controls how many surrounding lines to include (default 3, like git).
pub fn get_file_diff(
    worktree_path: &str,
    file_path: &str,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<FileDiff, String> {
    let ctx_flag = format!("-U{}", context_lines.unwrap_or(3));

    let mut args = vec!["diff", &ctx_flag];
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
    args.extend(["HEAD", "--", file_path]);

    let output = git(worktree_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to get file diff: {e}"))?;

    // Fall back to --cached if HEAD doesn't exist
    let raw_diff = if !output.status.success() {
        let mut fallback_args = vec!["diff", &ctx_flag];
        if ignore_whitespace.unwrap_or(false) {
            fallback_args.push("-w");
        }
        fallback_args.extend(["--cached", "--", file_path]);

        let fallback = git(worktree_path)
            .args(&fallback_args)
            .output()
            .map_err(|e| format!("Failed to get file diff: {e}"))?;
        String::from_utf8_lossy(&fallback.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    // If empty, try showing untracked file content as a full-add diff
    let raw_diff = if raw_diff.is_empty() {
        generate_untracked_diff(worktree_path, file_path)?
    } else {
        raw_diff
    };

    let hunks = parse_unified_diff(&raw_diff);

    // Compute stats from hunks
    let mut insertions: u32 = 0;
    let mut deletions: u32 = 0;
    for hunk in &hunks {
        for line in &hunk.lines {
            match line.kind.as_str() {
                "add" => insertions += 1,
                "delete" => deletions += 1,
                _ => {}
            }
        }
    }

    // Detect status from the diff header
    let status = if raw_diff.contains("new file mode") {
        "A"
    } else if raw_diff.contains("deleted file mode") {
        "D"
    } else {
        "M"
    };

    // Count total lines in the current file
    let full_path = std::path::Path::new(worktree_path).join(file_path);
    let total_lines = if full_path.exists() {
        std::fs::read_to_string(&full_path)
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0)
    } else {
        0
    };

    Ok(FileDiff {
        path: file_path.to_string(),
        status: status.to_string(),
        hunks,
        stats: FileDiffStats {
            path: file_path.to_string(),
            insertions,
            deletions,
        },
        total_lines,
    })
}

/// Read lines from a file in the worktree (new version) or from HEAD (old version).
/// Returns the requested line range (1-indexed, inclusive).
pub fn get_file_context(
    worktree_path: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    version: &str,
) -> Result<Vec<String>, String> {
    let content = if version == "old" {
        // Read from HEAD
        let output = git(worktree_path)
            .args(["show", &format!("HEAD:{file_path}")])
            .output()
            .map_err(|e| format!("Failed to read file from HEAD: {e}"))?;

        if !output.status.success() {
            return Ok(Vec::new()); // File doesn't exist in HEAD (new file)
        }
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        // Read from worktree (current version)
        let full_path = std::path::Path::new(worktree_path).join(file_path);
        std::fs::read_to_string(&full_path)
            .map_err(|e| format!("Failed to read file: {e}"))?
    };

    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let start = (start_line as usize).saturating_sub(1);
    let end = (end_line as usize).min(lines.len());

    Ok(lines[start..end].to_vec())
}

/// Generate a synthetic diff for an untracked file (shows all lines as additions).
fn generate_untracked_diff(worktree_path: &str, file_path: &str) -> Result<String, String> {
    let full_path = std::path::Path::new(worktree_path).join(file_path);
    if !full_path.exists() {
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&full_path)
        .map_err(|_| "Binary file".to_string())?;

    let line_count = content.lines().count();
    let mut diff = format!("--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1,{line_count} @@\n");
    for line in content.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(diff)
}

// ---------------------------------------------------------------------------
// Unified diff parser
// ---------------------------------------------------------------------------

/// Parse a unified diff string into structured hunks.
pub fn parse_unified_diff(diff: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line: u32 = 0;
    let mut new_line: u32 = 0;

    for line in diff.lines() {
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        if line.starts_with("@@ ") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            if let Some(parsed) = parse_hunk_header(line) {
                old_line = parsed.old_start;
                new_line = parsed.new_start;
                current_hunk = Some(parsed);
            }
            continue;
        }

        // Skip diff metadata lines (before any hunk)
        if current_hunk.is_none() {
            continue;
        }

        let hunk = current_hunk.as_mut().unwrap();

        if let Some(content) = line.strip_prefix('+') {
            hunk.lines.push(DiffLine {
                kind: "add".to_string(),
                content: content.to_string(),
                old_line_number: None,
                new_line_number: Some(new_line),
            });
            new_line += 1;
        } else if let Some(content) = line.strip_prefix('-') {
            hunk.lines.push(DiffLine {
                kind: "delete".to_string(),
                content: content.to_string(),
                old_line_number: Some(old_line),
                new_line_number: None,
            });
            old_line += 1;
        } else if line.starts_with(' ') || line.is_empty() {
            let content = if line.is_empty() {
                String::new()
            } else {
                line[1..].to_string()
            };
            hunk.lines.push(DiffLine {
                kind: "context".to_string(),
                content,
                old_line_number: Some(old_line),
                new_line_number: Some(new_line),
            });
            old_line += 1;
            new_line += 1;
        } else if line == "\\ No newline at end of file" {
            // Skip this marker
        }
    }

    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    hunks
}

fn parse_hunk_header(line: &str) -> Option<DiffHunk> {
    // @@ -old_start,old_count +new_start,new_count @@ optional context
    let line = line.strip_prefix("@@ ")?;
    let end = line.find(" @@")?;
    let range_part = &line[..end];
    let header_suffix = line[end + 3..].trim().to_string();

    let parts: Vec<&str> = range_part.split(' ').collect();
    if parts.len() != 2 {
        return None;
    }

    let old = parts[0].strip_prefix('-')?;
    let new = parts[1].strip_prefix('+')?;

    let (old_start, old_count) = parse_range(old);
    let (new_start, new_count) = parse_range(new);

    Some(DiffHunk {
        old_start,
        old_count,
        new_start,
        new_count,
        header: header_suffix,
        lines: Vec::new(),
    })
}

fn parse_range(s: &str) -> (u32, u32) {
    if let Some((start, count)) = s.split_once(',') {
        (
            start.parse().unwrap_or(1),
            count.parse().unwrap_or(1),
        )
    } else {
        (s.parse().unwrap_or(1), 1)
    }
}

// ---------------------------------------------------------------------------
// Branch commits
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// List commits on the current branch that are not on the base branch.
pub fn get_branch_commits(worktree_path: &str, base_branch: &str) -> Result<Vec<BranchCommit>, String> {
    // Prefer origin/<base> (most up-to-date), fall back to local branch name
    let base_ref = {
        let remote = format!("origin/{base_branch}");
        let remote_out = git(worktree_path)
            .args(["merge-base", &remote, "HEAD"])
            .output()
            .map_err(|e| format!("Failed to find merge base: {e}"))?;

        if remote_out.status.success() {
            String::from_utf8_lossy(&remote_out.stdout).trim().to_string()
        } else {
            let local = git(worktree_path)
                .args(["merge-base", base_branch, "HEAD"])
                .output()
                .map_err(|e| format!("Failed to find merge base: {e}"))?;

            if local.status.success() {
                String::from_utf8_lossy(&local.stdout).trim().to_string()
            } else {
                return get_all_commits(worktree_path);
            }
        }
    };

    let merge_base = base_ref;

    let output = git(worktree_path)
        .args([
            "log",
            &format!("{merge_base}..HEAD"),
            "--format=%H%n%h%n%s%n%an%n%at",
            "--shortstat",
        ])
        .output()
        .map_err(|e| format!("Failed to get branch commits: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    parse_log_output(&String::from_utf8_lossy(&output.stdout))
}

/// Get files changed in a specific commit (as a GitStatus-like structure).
pub fn get_commit_files(worktree_path: &str, commit_hash: &str) -> Result<GitStatus, String> {
    // Get file list with status
    let output = git(worktree_path)
        .args(["diff-tree", "--no-commit-id", "-r", "--name-status", commit_hash])
        .output()
        .map_err(|e| format!("Failed to get commit files: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() != 2 { continue; }
        let status_char = parts[0].chars().next().unwrap_or('M');
        let status = match status_char {
            'A' => "A",
            'D' => "D",
            'R' => "R",
            _ => "M",
        };
        files.push(FileStatus {
            path: parts[1].to_string(),
            status: status.to_string(),
            staging: "committed".to_string(),
            old_path: None,
        });
    }

    // Get stats
    let stat_output = git(worktree_path)
        .args(["diff-tree", "--no-commit-id", "-r", "--numstat", commit_hash])
        .output()
        .map_err(|e| format!("Failed to get commit stats: {e}"))?;

    let stat_stdout = String::from_utf8_lossy(&stat_output.stdout);
    let mut stats = Vec::new();
    let mut total_ins: u32 = 0;
    let mut total_del: u32 = 0;

    for line in stat_stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 3 { continue; }
        let ins = parts[0].parse::<u32>().unwrap_or(0);
        let del = parts[1].parse::<u32>().unwrap_or(0);
        total_ins += ins;
        total_del += del;
        stats.push(FileDiffStats {
            path: parts[2].to_string(),
            insertions: ins,
            deletions: del,
        });
    }

    Ok(GitStatus {
        files,
        stats,
        total_insertions: total_ins,
        total_deletions: total_del,
    })
}

/// Get the diff for a specific file in a specific commit.
pub fn get_commit_file_diff(
    worktree_path: &str,
    commit_hash: &str,
    file_path: &str,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
) -> Result<FileDiff, String> {
    let ctx_flag = format!("-U{}", context_lines.unwrap_or(3));

    let mut args = vec!["diff-tree", "-p", "--no-commit-id", &ctx_flag];
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
    args.extend([commit_hash, "--", file_path]);

    let output = git(worktree_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to get commit file diff: {e}"))?;

    let raw_diff = String::from_utf8_lossy(&output.stdout).to_string();
    let hunks = parse_unified_diff(&raw_diff);

    let mut insertions: u32 = 0;
    let mut deletions: u32 = 0;
    for hunk in &hunks {
        for line in &hunk.lines {
            match line.kind.as_str() {
                "add" => insertions += 1,
                "delete" => deletions += 1,
                _ => {}
            }
        }
    }

    let status = if raw_diff.contains("new file mode") {
        "A"
    } else if raw_diff.contains("deleted file mode") {
        "D"
    } else {
        "M"
    };

    // For commit diffs, total_lines is less meaningful but we can approximate
    let full_path = std::path::Path::new(worktree_path).join(file_path);
    let total_lines = if full_path.exists() {
        std::fs::read_to_string(&full_path)
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0)
    } else {
        0
    };

    Ok(FileDiff {
        path: file_path.to_string(),
        status: status.to_string(),
        hunks,
        stats: FileDiffStats {
            path: file_path.to_string(),
            insertions,
            deletions,
        },
        total_lines,
    })
}

fn get_all_commits(worktree_path: &str) -> Result<Vec<BranchCommit>, String> {
    let output = git(worktree_path)
        .args(["log", "--format=%H%n%h%n%s%n%an%n%at", "--shortstat"])
        .output()
        .map_err(|e| format!("Failed to get commits: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    parse_log_output(&String::from_utf8_lossy(&output.stdout))
}

fn parse_log_output(text: &str) -> Result<Vec<BranchCommit>, String> {
    let mut commits = Vec::new();
    let mut lines = text.lines().peekable();

    while lines.peek().is_some() {
        // Skip blank lines between entries
        while lines.peek().is_some_and(|l| l.is_empty()) {
            lines.next();
        }

        let hash = match lines.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => break,
        };
        let short_hash = lines.next().unwrap_or("").to_string();
        let message = lines.next().unwrap_or("").to_string();
        let author = lines.next().unwrap_or("").to_string();
        let timestamp: i64 = lines.next().unwrap_or("0").parse().unwrap_or(0);

        // Next line might be a blank line, then the shortstat, or just a blank line
        let mut files_changed: u32 = 0;
        let mut insertions: u32 = 0;
        let mut deletions: u32 = 0;

        // Skip blank lines and look for the stat line
        while lines.peek().is_some_and(|l| l.is_empty()) {
            lines.next();
        }

        if let Some(stat_line) = lines.peek() {
            if stat_line.contains("file") && stat_line.contains("changed") {
                let stat = lines.next().unwrap();
                // Parse "N file(s) changed, N insertion(s)(+), N deletion(s)(-)"
                for part in stat.split(',') {
                    let part = part.trim();
                    if part.contains("changed") {
                        files_changed = part.split_whitespace().next()
                            .and_then(|n| n.parse().ok())
                            .unwrap_or(0);
                    } else if part.contains("insertion") {
                        insertions = part.split_whitespace().next()
                            .and_then(|n| n.parse().ok())
                            .unwrap_or(0);
                    } else if part.contains("deletion") {
                        deletions = part.split_whitespace().next()
                            .and_then(|n| n.parse().ok())
                            .unwrap_or(0);
                    }
                }
            }
        }

        commits.push(BranchCommit {
            hash,
            short_hash,
            message,
            author,
            timestamp,
            files_changed,
            insertions,
            deletions,
        });
    }

    Ok(commits)
}

// ---------------------------------------------------------------------------
// Git actions (Phase 2)
// ---------------------------------------------------------------------------

/// Stage specific files.
pub fn stage_files(worktree_path: &str, paths: &[String]) -> Result<(), String> {
    let mut cmd = git(worktree_path);
    cmd.arg("add").arg("--");
    for p in paths {
        cmd.arg(p);
    }

    let output = cmd.output().map_err(|e| format!("Failed to stage files: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }
    Ok(())
}

/// Stage all changes.
pub fn stage_all(worktree_path: &str) -> Result<(), String> {
    let output = git(worktree_path)
        .args(["add", "-A"])
        .output()
        .map_err(|e| format!("Failed to stage all: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add -A failed: {stderr}"));
    }
    Ok(())
}

/// Unstage specific files.
pub fn unstage_files(worktree_path: &str, paths: &[String]) -> Result<(), String> {
    let mut cmd = git(worktree_path);
    cmd.args(["restore", "--staged", "--"]);
    for p in paths {
        cmd.arg(p);
    }

    let output = cmd.output().map_err(|e| format!("Failed to unstage files: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git restore --staged failed: {stderr}"));
    }
    Ok(())
}

/// Commit staged changes. Returns the commit hash.
pub fn commit(worktree_path: &str, message: &str) -> Result<String, String> {
    let output = git(worktree_path)
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| format!("Failed to commit: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    // Get the commit hash
    let hash_output = git(worktree_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get commit hash: {e}"))?;

    Ok(String::from_utf8_lossy(&hash_output.stdout).trim().to_string())
}

/// Push branch to remote. Uses -u to set upstream on first push.
pub fn push_branch(worktree_path: &str) -> Result<(), String> {
    // Get current branch name
    let output = git(worktree_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get branch: {e}"))?;

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let output = git(worktree_path)
        .args(["push", "-u", "origin", &branch])
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git push failed: {stderr}"));
    }
    Ok(())
}

/// Pull with rebase.
pub fn pull_branch(worktree_path: &str) -> Result<String, String> {
    let output = git(worktree_path)
        .args(["pull", "--rebase"])
        .output()
        .map_err(|e| format!("Failed to pull: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git pull failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_test_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().join("repo");
        fs::create_dir(&repo_path).unwrap();

        let rp = repo_path.to_str().unwrap();
        git(rp).args(["init"]).output().unwrap();
        git(rp).args(["config", "user.email", "test@test.com"]).output().unwrap();
        git(rp).args(["config", "user.name", "Test"]).output().unwrap();

        fs::write(repo_path.join("README.md"), "# test\n").unwrap();
        git(rp).args(["add", "."]).output().unwrap();
        git(rp).args(["commit", "-m", "init"]).output().unwrap();

        (dir, rp.to_string())
    }

    #[test]
    fn status_clean_repo() {
        let (_dir, rp) = init_test_repo();
        let status = get_git_status(&rp).unwrap();
        assert!(status.files.is_empty());
        assert_eq!(status.total_insertions, 0);
        assert_eq!(status.total_deletions, 0);
    }

    #[test]
    fn status_with_changes() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/new.txt"), "hello\nworld\n").unwrap();
        fs::write(format!("{rp}/README.md"), "# updated\n").unwrap();

        let status = get_git_status(&rp).unwrap();
        assert!(!status.files.is_empty());
        // Should have at least the untracked new.txt and modified README.md
        assert!(status.files.iter().any(|f| f.path == "new.txt"));
        assert!(status.files.iter().any(|f| f.path == "README.md"));
    }

    #[test]
    fn status_staged_file() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/staged.txt"), "staged content\n").unwrap();
        git(&rp).args(["add", "staged.txt"]).output().unwrap();

        let status = get_git_status(&rp).unwrap();
        let staged = status.files.iter().find(|f| f.path == "staged.txt").unwrap();
        assert_eq!(staged.staging, "staged");
        assert_eq!(staged.status, "A");
    }

    #[test]
    fn file_diff_modified() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/README.md"), "# updated\nline 2\n").unwrap();

        let diff = get_file_diff(&rp, "README.md", None, None).unwrap();
        assert_eq!(diff.path, "README.md");
        assert_eq!(diff.status, "M");
        assert!(!diff.hunks.is_empty());
        assert!(diff.stats.insertions > 0 || diff.stats.deletions > 0);
    }

    #[test]
    fn file_diff_new_file() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/brand-new.txt"), "line one\nline two\n").unwrap();
        git(&rp).args(["add", "brand-new.txt"]).output().unwrap();

        let diff = get_file_diff(&rp, "brand-new.txt", None, None).unwrap();
        assert_eq!(diff.status, "A");
        assert_eq!(diff.stats.insertions, 2);
        assert_eq!(diff.stats.deletions, 0);
    }

    #[test]
    fn file_diff_untracked() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/untracked.txt"), "hello\n").unwrap();

        let diff = get_file_diff(&rp, "untracked.txt", None, None).unwrap();
        assert!(!diff.hunks.is_empty());
        assert_eq!(diff.stats.insertions, 1);
    }

    #[test]
    fn parse_hunk_header_basic() {
        let hunk = parse_hunk_header("@@ -1,5 +1,7 @@ fn main()").unwrap();
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_count, 5);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_count, 7);
        assert_eq!(hunk.header, "fn main()");
    }

    #[test]
    fn parse_hunk_header_single_line() {
        let hunk = parse_hunk_header("@@ -1 +1 @@").unwrap();
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_count, 1);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_count, 1);
    }

    #[test]
    fn parse_unified_diff_basic() {
        let diff = "\
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
-old line 2
+new line 2
+added line
 line 3
";
        let hunks = parse_unified_diff(diff);
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!(h.lines.len(), 5);
        assert_eq!(h.lines[0].kind, "context");
        assert_eq!(h.lines[1].kind, "delete");
        assert_eq!(h.lines[2].kind, "add");
        assert_eq!(h.lines[3].kind, "add");
        assert_eq!(h.lines[4].kind, "context");
    }

    #[test]
    fn parse_unified_diff_line_numbers() {
        let diff = "\
--- a/file.txt
+++ b/file.txt
@@ -5,3 +5,3 @@
 context
-removed
+added
 context
";
        let hunks = parse_unified_diff(diff);
        let h = &hunks[0];

        // Context line at old:5, new:5
        assert_eq!(h.lines[0].old_line_number, Some(5));
        assert_eq!(h.lines[0].new_line_number, Some(5));

        // Deleted line at old:6
        assert_eq!(h.lines[1].old_line_number, Some(6));
        assert_eq!(h.lines[1].new_line_number, None);

        // Added line at new:6
        assert_eq!(h.lines[2].old_line_number, None);
        assert_eq!(h.lines[2].new_line_number, Some(6));
    }

    #[test]
    fn stage_and_commit() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/commit-me.txt"), "content\n").unwrap();
        stage_files(&rp, &["commit-me.txt".to_string()]).unwrap();

        let hash = commit(&rp, "test commit").unwrap();
        assert!(!hash.is_empty());
        assert!(hash.len() >= 7); // at least short hash

        let status = get_git_status(&rp).unwrap();
        assert!(status.files.is_empty());
    }

    #[test]
    fn stage_all_and_unstage() {
        let (_dir, rp) = init_test_repo();

        fs::write(format!("{rp}/a.txt"), "a\n").unwrap();
        fs::write(format!("{rp}/b.txt"), "b\n").unwrap();

        stage_all(&rp).unwrap();
        let status = get_git_status(&rp).unwrap();
        assert!(status.files.iter().all(|f| f.staging == "staged"));

        unstage_files(&rp, &["a.txt".to_string()]).unwrap();
        let status = get_git_status(&rp).unwrap();
        let a = status.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.staging, "untracked");
    }
}
