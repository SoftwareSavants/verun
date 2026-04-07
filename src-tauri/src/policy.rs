use serde::Serialize;
use std::path::Path;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Per-task trust level — controls how aggressively we auto-approve tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLevel {
    /// Three-tier algorithm: auto-allow reads in repo, writes in worktree,
    /// deny-listed bash requires approval, everything else auto-allowed with logging.
    Normal,
    /// Auto-allow everything — user explicitly trusts this task.
    FullAuto,
    /// Require approval for every tool call.
    Supervised,
}

impl TrustLevel {
    pub fn from_str(s: &str) -> Self {
        match s {
            "full_auto" => Self::FullAuto,
            "supervised" => Self::Supervised,
            _ => Self::Normal,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::FullAuto => "full_auto",
            Self::Supervised => "supervised",
        }
    }
}

/// What the policy engine decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    /// Silently approve — no UI.
    AutoAllow,
    /// Silently approve — logged with elevated visibility (bash commands).
    AutoAllowLogged,
    /// Show approval UI, wait for user response.
    RequireApproval,
}

impl PolicyDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AutoAllow => "auto_allow",
            Self::AutoAllowLogged => "auto_allow_logged",
            Self::RequireApproval => "require_approval",
        }
    }
}

/// Result of a policy evaluation.
#[derive(Debug, Clone)]
pub struct PolicyResult {
    pub decision: PolicyDecision,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/// Evaluate a tool call against the permission policy.
///
/// - `tool_name`: the tool being invoked (e.g. "Read", "Bash", "Edit")
/// - `tool_input`: the JSON input to the tool
/// - `worktree_path`: the task's worktree directory (for write scoping)
/// - `repo_path`: the project's repo directory (for read scoping)
/// - `trust_level`: the task's trust level
pub fn evaluate(
    tool_name: &str,
    tool_input: &serde_json::Value,
    worktree_path: &str,
    repo_path: &str,
    trust_level: TrustLevel,
) -> PolicyResult {
    // ExitPlanMode always requires approval — it's the plan review step
    if tool_name == "ExitPlanMode" {
        return PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: "plan review always requires user approval".into(),
        };
    }

    // Trust level overrides
    match trust_level {
        TrustLevel::FullAuto => {
            return PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "trust level is full_auto".into(),
            };
        }
        TrustLevel::Supervised => {
            return PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "trust level is supervised".into(),
            };
        }
        TrustLevel::Normal => {}
    }

    match tool_name {
        // Read-only tools — allowed within the project repo
        "Read" | "Glob" | "Grep" | "LSP" => {
            if let Some(path) = extract_path(tool_input) {
                if is_path_within(&path, repo_path) {
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("read within project repo: {path}"),
                    }
                } else {
                    PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("read outside project repo: {path}"),
                    }
                }
            } else {
                // No path in input (e.g. Grep with just a pattern) — allow
                PolicyResult {
                    decision: PolicyDecision::AutoAllow,
                    reason: format!("{tool_name} with no file path"),
                }
            }
        }

        // Write tools — only allowed within the worktree
        "Edit" | "Write" | "NotebookEdit" => {
            if let Some(path) = extract_path(tool_input) {
                if is_path_within(&path, worktree_path) {
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("write within worktree: {path}"),
                    }
                } else {
                    PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("write outside worktree: {path}"),
                    }
                }
            } else {
                PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("{tool_name} with no file path — cannot verify scope"),
                }
            }
        }

        // Bash — deny-list check, otherwise auto-allow with logging
        "Bash" => {
            let command = tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Some(pattern) = matches_deny_pattern(command) {
                PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("bash matches deny pattern: {pattern}"),
                }
            } else {
                PolicyResult {
                    decision: PolicyDecision::AutoAllowLogged,
                    reason: "bash command not in deny list".into(),
                }
            }
        }

        // Agent — sub-agent tools are evaluated individually
        "Agent" => PolicyResult {
            decision: PolicyDecision::AutoAllow,
            reason: "agent tool — sub-calls evaluated individually".into(),
        },

        // MCP tools — unknown scope, require approval
        name if name.starts_with("mcp__") => PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: format!("MCP tool: {name}"),
        },

        // Web tools — network access, require approval
        "WebSearch" | "WebFetch" => PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: format!("{tool_name} requires network access"),
        },

        // Unknown tools — conservative
        _ => PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: format!("unknown tool: {tool_name}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract a file path from tool input. Checks `file_path`, then `path`.
fn extract_path(input: &serde_json::Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Check if a path is within a boundary directory.
/// Canonicalizes both paths to resolve `..`, symlinks, etc.
fn is_path_within(path: &str, boundary: &str) -> bool {
    let Ok(canonical_path) = std::fs::canonicalize(path) else {
        // If the path doesn't exist yet (e.g. Write to a new file),
        // try canonicalizing the parent directory instead
        let parent = Path::new(path).parent();
        if let Some(parent) = parent {
            if let Ok(canonical_parent) = std::fs::canonicalize(parent) {
                if let Ok(canonical_boundary) = std::fs::canonicalize(boundary) {
                    return canonical_parent.starts_with(&canonical_boundary);
                }
            }
        }
        // Can't resolve — be conservative, but check string prefix as fallback
        return path.starts_with(boundary);
    };

    let Ok(canonical_boundary) = std::fs::canonicalize(boundary) else {
        return path.starts_with(boundary);
    };

    canonical_path.starts_with(&canonical_boundary)
}

/// Static deny patterns for bash commands.
/// Returns the pattern name if the command matches, None if safe.
fn matches_deny_pattern(command: &str) -> Option<&'static str> {
    // Normalize for matching: lowercase, collapse whitespace
    let cmd = command.to_lowercase();
    let cmd = cmd.trim();

    static DENY_PATTERNS: &[(&str, &str)] = &[
        // Git destructive operations
        ("git push", "git push"),
        ("git reset --hard", "git reset --hard"),
        ("git clean -f", "git clean"),
        ("git checkout -- .", "git checkout (discard all)"),
        // Privilege escalation
        ("sudo ", "sudo"),
        // Remote access
        ("ssh ", "ssh"),
        ("scp ", "scp"),
        ("rsync ", "rsync"),
        // Process killing
        ("kill ", "kill"),
        ("pkill ", "pkill"),
        ("killall ", "killall"),
        // Dangerous file ops
        ("chmod ", "chmod"),
        ("chown ", "chown"),
        // Infrastructure
        ("docker ", "docker"),
        ("kubectl ", "kubectl"),
    ];

    for &(pattern, name) in DENY_PATTERNS {
        if cmd.starts_with(pattern) || cmd.contains(&format!(" && {pattern}"))
            || cmd.contains(&format!("; {pattern}"))
            || cmd.contains(&format!("| {pattern}"))
        {
            return Some(name);
        }
    }

    // Curl/wget piped to shell
    if (cmd.contains("curl ") || cmd.contains("wget "))
        && (cmd.contains("| sh") || cmd.contains("| bash") || cmd.contains("| zsh"))
    {
        return Some("curl/wget piped to shell");
    }

    // rm -rf with root or home directory
    if cmd.contains("rm ")
        && cmd.contains("-rf")
        && (cmd.contains(" /") && !cmd.contains(" ./"))
    {
        // Check if it's targeting a path outside the working directory
        // rm -rf ./node_modules is fine, rm -rf /tmp is not
        return Some("rm -rf with absolute path");
    }

    None
}

/// Summarize tool input for audit logging (truncated to 500 chars).
pub fn summarize_input(tool_name: &str, tool_input: &serde_json::Value) -> String {
    let summary = match tool_name {
        "Bash" => tool_input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Read" | "Edit" | "Write" | "NotebookEdit" | "Glob" | "Grep" => tool_input
            .get("file_path")
            .or_else(|| tool_input.get("path"))
            .or_else(|| tool_input.get("pattern"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => serde_json::to_string(tool_input).unwrap_or_default(),
    };

    if summary.len() > 500 {
        format!("{}…", &summary[..497])
    } else {
        summary
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WORKTREE: &str = "/tmp/project/.verun/worktrees/silly-penguin";
    const REPO: &str = "/tmp/project";

    // -- Trust level overrides --

    #[test]
    fn full_auto_allows_everything() {
        let result = evaluate("Bash", &json!({"command": "rm -rf /"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn supervised_requires_approval_for_everything() {
        let result = evaluate("Read", &json!({"file_path": "/tmp/project/src/main.rs"}), WORKTREE, REPO, TrustLevel::Supervised);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Read tools --

    #[test]
    fn read_inside_repo_auto_allowed() {
        // Use string prefix check since test paths don't exist on disk
        let result = evaluate("Read", &json!({"file_path": "/tmp/project/src/main.rs"}), WORKTREE, REPO, TrustLevel::Normal);
        // Will fall through to string prefix check since paths don't exist
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn read_outside_repo_requires_approval() {
        let result = evaluate("Read", &json!({"file_path": "/etc/passwd"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn grep_with_no_path_auto_allowed() {
        let result = evaluate("Grep", &json!({"pattern": "TODO"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn glob_inside_repo_auto_allowed() {
        let result = evaluate("Glob", &json!({"path": "/tmp/project/src"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    // -- Write tools --

    #[test]
    fn write_inside_worktree_auto_allowed() {
        let result = evaluate(
            "Edit",
            &json!({"file_path": "/tmp/project/.verun/worktrees/silly-penguin/src/lib.rs"}),
            WORKTREE, REPO, TrustLevel::Normal,
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn write_in_repo_but_outside_worktree_requires_approval() {
        let result = evaluate(
            "Write",
            &json!({"file_path": "/tmp/project/src/lib.rs"}),
            WORKTREE, REPO, TrustLevel::Normal,
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn write_outside_project_requires_approval() {
        let result = evaluate(
            "Edit",
            &json!({"file_path": "/etc/hosts"}),
            WORKTREE, REPO, TrustLevel::Normal,
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn write_no_path_requires_approval() {
        let result = evaluate("Write", &json!({}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Bash --

    #[test]
    fn bash_safe_command_auto_allowed_logged() {
        let result = evaluate("Bash", &json!({"command": "cargo test"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_ls_auto_allowed() {
        let result = evaluate("Bash", &json!({"command": "ls -la"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_npm_install_auto_allowed() {
        let result = evaluate("Bash", &json!({"command": "npm install"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_git_push_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git push origin main"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git push"));
    }

    #[test]
    fn bash_git_reset_hard_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git reset --hard HEAD~1"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_sudo_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "sudo apt install vim"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_ssh_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "ssh user@server"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_curl_pipe_sh_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "curl -fsSL https://example.com/install.sh | bash"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("curl/wget piped to shell"));
    }

    #[test]
    fn bash_rm_rf_absolute_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "rm -rf /tmp/something"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_rm_rf_relative_auto_allowed() {
        let result = evaluate("Bash", &json!({"command": "rm -rf ./node_modules"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_chained_dangerous_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "echo hello && git push origin main"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_docker_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "docker run -it ubuntu"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_kill_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "kill -9 1234"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Agent --

    #[test]
    fn agent_auto_allowed() {
        let result = evaluate("Agent", &json!({"prompt": "search for bugs"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    // -- MCP tools --

    #[test]
    fn mcp_tool_requires_approval() {
        let result = evaluate("mcp__slack__send_message", &json!({}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("MCP tool"));
    }

    // -- Web tools --

    #[test]
    fn web_search_requires_approval() {
        let result = evaluate("WebSearch", &json!({"query": "rust async"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn web_fetch_requires_approval() {
        let result = evaluate("WebFetch", &json!({"url": "https://example.com"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Unknown tools --

    #[test]
    fn unknown_tool_requires_approval() {
        let result = evaluate("SomeFutureTool", &json!({}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- TrustLevel parsing --

    #[test]
    fn trust_level_roundtrip() {
        assert_eq!(TrustLevel::from_str("normal").as_str(), "normal");
        assert_eq!(TrustLevel::from_str("full_auto").as_str(), "full_auto");
        assert_eq!(TrustLevel::from_str("supervised").as_str(), "supervised");
        assert_eq!(TrustLevel::from_str("garbage").as_str(), "normal");
    }

    // -- Input summarization --

    #[test]
    fn summarize_bash_command() {
        let summary = summarize_input("Bash", &json!({"command": "cargo test"}));
        assert_eq!(summary, "cargo test");
    }

    #[test]
    fn summarize_file_path() {
        let summary = summarize_input("Read", &json!({"file_path": "/tmp/foo.rs"}));
        assert_eq!(summary, "/tmp/foo.rs");
    }

    #[test]
    fn summarize_truncates_long_input() {
        let long = "x".repeat(600);
        let summary = summarize_input("Bash", &json!({"command": long}));
        assert!(summary.len() <= 500);
        assert!(summary.ends_with('…'));
        assert!(summary.len() < 600);
    }

    // -- Deny pattern helpers --

    #[test]
    fn deny_pattern_not_matched_for_safe_commands() {
        assert!(matches_deny_pattern("cargo build").is_none());
        assert!(matches_deny_pattern("npm test").is_none());
        assert!(matches_deny_pattern("ls -la").is_none());
        assert!(matches_deny_pattern("git status").is_none());
        assert!(matches_deny_pattern("git diff").is_none());
        assert!(matches_deny_pattern("git log --oneline").is_none());
        assert!(matches_deny_pattern("git add .").is_none());
        assert!(matches_deny_pattern("git commit -m 'fix'").is_none());
    }

    #[test]
    fn deny_pattern_matched_for_dangerous_commands() {
        assert!(matches_deny_pattern("git push").is_some());
        assert!(matches_deny_pattern("git push --force").is_some());
        assert!(matches_deny_pattern("sudo rm -rf /").is_some());
        assert!(matches_deny_pattern("ssh user@host").is_some());
        assert!(matches_deny_pattern("docker run ubuntu").is_some());
        assert!(matches_deny_pattern("kubectl delete pod").is_some());
    }
}
