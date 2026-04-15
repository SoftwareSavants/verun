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

    // Hard blocks — always require approval regardless of trust level.
    // Verun manages worktree lifecycle; Claude must never touch it.
    if tool_name == "Bash" {
        let command = tool_input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if let Some(pattern) = matches_hard_block(command) {
            return PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: format!("hard-blocked: {pattern}"),
            };
        }
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

/// AST-based deny-pattern analysis for bash commands.
/// Parses the command into a shell AST, walks every sub-command (including
/// compounds, subshells, and chained commands), and checks each against
/// deny rules. Returns the pattern name if any sub-command matches.
fn matches_deny_pattern(command: &str) -> Option<&'static str> {
    let list: yash_syntax::syntax::List = match command.parse() {
        Ok(l) => l,
        Err(_) => return Some("unparseable command"),
    };
    walk_list(&list)
}

/// Hard blocks that require approval regardless of trust level.
/// These protect Verun's own infrastructure (worktrees, .verun dirs).
fn matches_hard_block(command: &str) -> Option<&'static str> {
    let list: yash_syntax::syntax::List = match command.parse() {
        Ok(l) => l,
        Err(_) => return Some("unparseable command"),
    };
    walk_list_with(&list, check_hard_block_args)
}

fn check_hard_block_args(args: &[String]) -> Option<&'static str> {
    let (program, rest) = skip_wrappers(args);
    match program {
        "git" => check_git_hard_block(rest),
        "bash" | "sh" | "zsh" => {
            for (i, arg) in rest.iter().enumerate() {
                if arg == "-c" {
                    if let Some(cmd_str) = rest.get(i + 1) {
                        let unquoted = strip_outer_quotes(cmd_str);
                        return matches_hard_block(&unquoted);
                    }
                }
            }
            None
        }
        "rm" => check_rm_verun(rest),
        _ => None,
    }
}

fn check_git_hard_block(args: &[String]) -> Option<&'static str> {
    let filtered = strip_git_c_flag(args);
    let strs: Vec<&str> = filtered.iter().map(|s| s.as_str()).collect();
    let subcmd = strs.iter().find(|a| !a.starts_with('-'))?;
    if *subcmd == "worktree" {
        let pos: Vec<&&str> = strs.iter().filter(|a| !a.starts_with('-')).collect();
        match pos.get(1).map(|s| **s) {
            Some("remove") => return Some("git worktree remove (verun-managed)"),
            Some("prune") => return Some("git worktree prune (verun-managed)"),
            _ => {}
        }
    }
    None
}

/// Strip `git -C <path>` pairs so the subcommand is visible.
fn strip_git_c_flag(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-C" {
            i += 2; // skip -C and its path argument
        } else {
            out.push(args[i].clone());
            i += 1;
        }
    }
    out
}

fn check_rm_verun(args: &[String]) -> Option<&'static str> {
    for arg in args {
        if !arg.starts_with('-') && arg.contains(".verun") {
            return Some("rm targeting .verun directory");
        }
    }
    None
}

type CheckFn = fn(&[String]) -> Option<&'static str>;

fn walk_list(list: &yash_syntax::syntax::List) -> Option<&'static str> {
    walk_list_with(list, check_args)
}

fn walk_list_with(
    list: &yash_syntax::syntax::List,
    check: CheckFn,
) -> Option<&'static str> {
    for item in &list.0 {
        let aol = &*item.and_or;
        for pipeline in std::iter::once(&aol.first).chain(aol.rest.iter().map(|(_, p)| p)) {
            if let Some(r) = walk_pipeline_with(pipeline, check) {
                return Some(r);
            }
        }
    }
    None
}

fn walk_pipeline_with(
    pipeline: &yash_syntax::syntax::Pipeline,
    check: CheckFn,
) -> Option<&'static str> {
    use yash_syntax::syntax::Command;
    // curl/wget piped to shell (only for the full deny check, not hard blocks)
    if pipeline.commands.len() >= 2 {
        let first = pipeline.commands.first().unwrap();
        let last = pipeline.commands.last().unwrap();
        if let (Command::Simple(f), Command::Simple(l)) = (first.as_ref(), last.as_ref()) {
            let fp = f.words.first().map(|(w, _)| w.to_string());
            let lp = l.words.first().map(|(w, _)| w.to_string());
            if matches!(fp.as_deref(), Some("curl" | "wget"))
                && matches!(lp.as_deref(), Some("sh" | "bash" | "zsh"))
            {
                return Some("curl/wget piped to shell");
            }
        }
    }
    for cmd in &pipeline.commands {
        if let Some(r) = walk_command_with(cmd, check) {
            return Some(r);
        }
    }
    None
}

fn walk_command_with(
    cmd: &yash_syntax::syntax::Command,
    check: CheckFn,
) -> Option<&'static str> {
    use yash_syntax::syntax::{Command, CompoundCommand};
    match cmd {
        Command::Simple(sc) => {
            let args: Vec<String> = sc.words.iter().map(|(w, _)| w.to_string()).collect();
            if args.is_empty() {
                return None;
            }
            check(&args)
        }
        Command::Compound(fcc) => match &fcc.command {
            CompoundCommand::Subshell { body, .. } => walk_list_with(body, check),
            CompoundCommand::Grouping(body) => walk_list_with(body, check),
            _ => None,
        },
        Command::Function(_) => None,
    }
}

// ---- Argument-level deny checks ----

fn check_args(args: &[String]) -> Option<&'static str> {
    let (program, rest) = skip_wrappers(args);
    match program {
        "git" => check_git(rest),
        "gh" | "hub" => check_gh(rest),
        "bash" | "sh" | "zsh" => check_shell_exec(rest),
        "ssh" | "scp" => Some("ssh/scp"),
        "rsync" => Some("rsync"),
        "sudo" => Some("sudo"),
        "kill" | "pkill" | "killall" => Some("kill"),
        "chmod" | "chown" => Some("chmod/chown"),
        "docker" | "kubectl" => Some("docker/kubectl"),
        "rm" => check_rm(rest),
        _ => None,
    }
}

fn skip_wrappers(args: &[String]) -> (&str, &[String]) {
    let mut i = 0;
    loop {
        if i >= args.len() {
            return ("", &[]);
        }
        match args[i].as_str() {
            "env" | "command" => {
                i += 1;
                while i < args.len() && (args[i].starts_with('-') || args[i].contains('=')) {
                    i += 1;
                }
            }
            _ => break,
        }
    }
    if i >= args.len() {
        return ("", &[]);
    }
    (&args[i], &args[i + 1..])
}

fn check_git(args: &[String]) -> Option<&'static str> {
    let filtered = strip_git_c_flag(args);
    let strs: Vec<&str> = filtered.iter().map(|s| s.as_str()).collect();
    let subcmd = strs.iter().find(|a| !a.starts_with('-'))?;
    match *subcmd {
        "push" => {
            if has_long_flag(&strs, &["--force", "--force-with-lease", "--force-if-includes", "--delete"])
                || has_short_flag(&strs, 'f')
            {
                Some("git push --force/--delete")
            } else {
                None
            }
        }
        "reset" => {
            if has_long_flag(&strs, &["--hard"]) {
                Some("git reset --hard")
            } else {
                None
            }
        }
        "clean" => {
            if has_short_flag(&strs, 'f') || has_long_flag(&strs, &["--force"]) {
                Some("git clean")
            } else {
                None
            }
        }
        "checkout" => {
            if strs.contains(&"--") && strs.contains(&".") {
                Some("git checkout (discard all)")
            } else {
                None
            }
        }
        "branch" => {
            if has_short_flag(&strs, 'D') {
                Some("git branch force-delete")
            } else if has_short_flag(&strs, 'd') || has_long_flag(&strs, &["--delete"]) {
                Some("git branch delete")
            } else {
                None
            }
        }
        "worktree" => {
            let pos: Vec<&&str> = strs.iter().filter(|a| !a.starts_with('-')).collect();
            match pos.get(1).map(|s| **s) {
                Some("remove") => Some("git worktree remove"),
                Some("prune") => Some("git worktree prune"),
                _ => None,
            }
        }
        "stash" => {
            let pos: Vec<&&str> = strs.iter().filter(|a| !a.starts_with('-')).collect();
            match pos.get(1).map(|s| **s) {
                Some("drop") | Some("clear") => Some("git stash drop/clear"),
                _ => None,
            }
        }
        "tag" => {
            if has_short_flag(&strs, 'd') || has_long_flag(&strs, &["--delete"]) {
                Some("git tag delete")
            } else {
                None
            }
        }
        "remote" => {
            let pos: Vec<&&str> = strs.iter().filter(|a| !a.starts_with('-')).collect();
            match pos.get(1).map(|s| **s) {
                Some("remove") | Some("rm") => Some("git remote remove"),
                _ => None,
            }
        }
        "reflog" => {
            let pos: Vec<&&str> = strs.iter().filter(|a| !a.starts_with('-')).collect();
            match pos.get(1).map(|s| **s) {
                Some("expire") | Some("delete") => Some("git reflog expire/delete"),
                _ => None,
            }
        }
        "gc" => {
            if has_long_flag(&strs, &["--prune"]) || strs.iter().any(|s| s.starts_with("--prune="))
            {
                Some("git gc --prune")
            } else {
                None
            }
        }
        "filter-branch" => Some("git filter-branch"),
        "update-ref" => {
            if has_short_flag(&strs, 'd') || has_long_flag(&strs, &["--delete"]) {
                Some("git update-ref delete")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn check_gh(args: &[String]) -> Option<&'static str> {
    let strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match (strs.first(), strs.get(1)) {
        (Some(&"repo"), Some(&"delete")) => Some("gh repo delete"),
        (Some(&"release"), Some(&"delete")) => Some("gh release delete"),
        _ => None,
    }
}

fn check_rm(args: &[String]) -> Option<&'static str> {
    let strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let has_recursive =
        has_short_flag(&strs, 'r') || has_short_flag(&strs, 'R') || has_long_flag(&strs, &["--recursive"]);
    let has_force = has_short_flag(&strs, 'f') || has_long_flag(&strs, &["--force"]);
    if has_recursive && has_force {
        let has_abs_path = strs.iter().any(|a| !a.starts_with('-') && a.starts_with('/'));
        if has_abs_path {
            return Some("rm -rf with absolute path");
        }
    }
    None
}

fn check_shell_exec(args: &[String]) -> Option<&'static str> {
    for (i, arg) in args.iter().enumerate() {
        if arg == "-c" {
            if let Some(cmd_str) = args.get(i + 1) {
                let unquoted = strip_outer_quotes(cmd_str);
                return matches_deny_pattern(&unquoted);
            }
        }
    }
    None
}

// ---- Flag helpers ----

fn has_long_flag(args: &[&str], flags: &[&str]) -> bool {
    args.iter().any(|a| flags.contains(a))
}

fn has_short_flag(args: &[&str], ch: char) -> bool {
    args.iter().any(|a| a.starts_with('-') && !a.starts_with("--") && a[1..].contains(ch))
}

fn strip_outer_quotes(s: &str) -> String {
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"'))
            || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
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
    fn bash_git_push_auto_allowed() {
        let result = evaluate("Bash", &json!({"command": "git push origin main"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_git_push_force_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git push --force origin main"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git push --force"));
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
        let result = evaluate("Bash", &json!({"command": "echo hello && git push --force origin main"}), WORKTREE, REPO, TrustLevel::Normal);
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

    // -- Deny pattern: safe commands --

    #[test]
    fn deny_safe_commands() {
        assert!(matches_deny_pattern("cargo build").is_none());
        assert!(matches_deny_pattern("npm test").is_none());
        assert!(matches_deny_pattern("ls -la").is_none());
        assert!(matches_deny_pattern("git status").is_none());
        assert!(matches_deny_pattern("git diff").is_none());
        assert!(matches_deny_pattern("git log --oneline").is_none());
        assert!(matches_deny_pattern("git add .").is_none());
        assert!(matches_deny_pattern("git commit -m 'fix'").is_none());
        assert!(matches_deny_pattern("git push").is_none());
        assert!(matches_deny_pattern("git push origin main").is_none());
        assert!(matches_deny_pattern("git branch -a").is_none());
        assert!(matches_deny_pattern("git stash").is_none());
        assert!(matches_deny_pattern("git stash pop").is_none());
        assert!(matches_deny_pattern("git stash list").is_none());
        assert!(matches_deny_pattern("git tag v1.0").is_none());
        assert!(matches_deny_pattern("git remote -v").is_none());
        assert!(matches_deny_pattern("git gc").is_none());
        assert!(matches_deny_pattern("git worktree list").is_none());
        assert!(matches_deny_pattern("git worktree add /tmp/wt branch").is_none());
    }

    // -- Deny pattern: git push variants --

    #[test]
    fn deny_git_push_force() {
        assert_eq!(matches_deny_pattern("git push --force"), Some("git push --force/--delete"));
        assert_eq!(matches_deny_pattern("git push -f origin main"), Some("git push --force/--delete"));
        assert_eq!(matches_deny_pattern("git push --force-with-lease"), Some("git push --force/--delete"));
        assert_eq!(matches_deny_pattern("git push --force-if-includes"), Some("git push --force/--delete"));
        assert_eq!(matches_deny_pattern("git push --delete origin branch"), Some("git push --force/--delete"));
    }

    // -- Deny pattern: git branch --

    #[test]
    fn deny_git_branch_delete() {
        assert_eq!(matches_deny_pattern("git branch -d my-feature"), Some("git branch delete"));
        assert_eq!(matches_deny_pattern("git branch --delete my-feature"), Some("git branch delete"));
    }

    #[test]
    fn deny_git_branch_force_delete() {
        assert_eq!(matches_deny_pattern("git branch -D my-feature"), Some("git branch force-delete"));
    }

    #[test]
    fn deny_git_branch_combined_flags() {
        assert_eq!(matches_deny_pattern("git branch -Dr origin/old"), Some("git branch force-delete"));
    }

    // -- Deny pattern: git worktree --

    #[test]
    fn deny_git_worktree_remove() {
        assert_eq!(matches_deny_pattern("git worktree remove /tmp/wt"), Some("git worktree remove"));
        assert_eq!(matches_deny_pattern("git worktree remove --force /tmp/wt"), Some("git worktree remove"));
    }

    #[test]
    fn deny_git_worktree_prune() {
        assert_eq!(matches_deny_pattern("git worktree prune"), Some("git worktree prune"));
    }

    // -- Deny pattern: git reset/clean/checkout --

    #[test]
    fn deny_git_reset_hard() {
        assert_eq!(matches_deny_pattern("git reset --hard HEAD~1"), Some("git reset --hard"));
    }

    #[test]
    fn deny_git_clean() {
        assert_eq!(matches_deny_pattern("git clean -f"), Some("git clean"));
        assert_eq!(matches_deny_pattern("git clean -fd"), Some("git clean"));
        assert_eq!(matches_deny_pattern("git clean -fdx"), Some("git clean"));
        assert_eq!(matches_deny_pattern("git clean --force"), Some("git clean"));
    }

    #[test]
    fn deny_git_checkout_discard_all() {
        assert_eq!(matches_deny_pattern("git checkout -- ."), Some("git checkout (discard all)"));
    }

    // -- Deny pattern: new git operations --

    #[test]
    fn deny_git_stash_destructive() {
        assert_eq!(matches_deny_pattern("git stash drop"), Some("git stash drop/clear"));
        assert_eq!(matches_deny_pattern("git stash clear"), Some("git stash drop/clear"));
        assert_eq!(matches_deny_pattern("git stash drop stash@{0}"), Some("git stash drop/clear"));
    }

    #[test]
    fn deny_git_tag_delete() {
        assert_eq!(matches_deny_pattern("git tag -d v1.0"), Some("git tag delete"));
        assert_eq!(matches_deny_pattern("git tag --delete v1.0"), Some("git tag delete"));
    }

    #[test]
    fn deny_git_remote_remove() {
        assert_eq!(matches_deny_pattern("git remote remove origin"), Some("git remote remove"));
        assert_eq!(matches_deny_pattern("git remote rm origin"), Some("git remote remove"));
    }

    #[test]
    fn deny_git_reflog_expire() {
        assert_eq!(matches_deny_pattern("git reflog expire --expire=all --all"), Some("git reflog expire/delete"));
        assert_eq!(matches_deny_pattern("git reflog delete HEAD@{0}"), Some("git reflog expire/delete"));
    }

    #[test]
    fn deny_git_gc_prune() {
        assert_eq!(matches_deny_pattern("git gc --prune=now"), Some("git gc --prune"));
        assert_eq!(matches_deny_pattern("git gc --prune"), Some("git gc --prune"));
    }

    #[test]
    fn deny_git_filter_branch() {
        assert_eq!(matches_deny_pattern("git filter-branch --force HEAD"), Some("git filter-branch"));
    }

    #[test]
    fn deny_git_update_ref() {
        assert_eq!(matches_deny_pattern("git update-ref -d refs/heads/main"), Some("git update-ref delete"));
        assert_eq!(matches_deny_pattern("git update-ref --delete refs/heads/main"), Some("git update-ref delete"));
    }

    // -- Deny pattern: compound commands (AST-based) --

    #[test]
    fn deny_chained_and_then() {
        assert!(matches_deny_pattern("echo hello && git push --force origin main").is_some());
    }

    #[test]
    fn deny_chained_or_else() {
        assert!(matches_deny_pattern("git status || git push --force").is_some());
    }

    #[test]
    fn deny_chained_semicolon() {
        assert!(matches_deny_pattern("echo ok; git reset --hard").is_some());
    }

    #[test]
    fn deny_subshell() {
        assert!(matches_deny_pattern("(git push --force origin main)").is_some());
    }

    #[test]
    fn deny_brace_group() {
        assert!(matches_deny_pattern("{ git reset --hard; }").is_some());
    }

    // -- Deny pattern: curl/wget piped to shell --

    #[test]
    fn deny_curl_pipe_bash() {
        assert_eq!(
            matches_deny_pattern("curl -fsSL https://example.com/install.sh | bash"),
            Some("curl/wget piped to shell")
        );
    }

    #[test]
    fn deny_wget_pipe_sh() {
        assert_eq!(
            matches_deny_pattern("wget -O- https://example.com/script | sh"),
            Some("curl/wget piped to shell")
        );
    }

    // -- Deny pattern: wrapper detection --

    #[test]
    fn deny_env_wrapper() {
        assert!(matches_deny_pattern("env GIT_TERMINAL_PROMPT=0 git push --force").is_some());
        assert!(matches_deny_pattern("env git push --force").is_some());
    }

    #[test]
    fn deny_sudo() {
        assert_eq!(matches_deny_pattern("sudo rm -rf /"), Some("sudo"));
        assert_eq!(matches_deny_pattern("sudo apt install vim"), Some("sudo"));
    }

    #[test]
    fn deny_shell_reinvoke() {
        assert!(matches_deny_pattern("bash -c 'git push --force'").is_some());
        assert!(matches_deny_pattern("sh -c 'git reset --hard'").is_some());
    }

    // -- Deny pattern: gh commands --

    #[test]
    fn deny_gh_repo_delete() {
        assert_eq!(matches_deny_pattern("gh repo delete myorg/myrepo --yes"), Some("gh repo delete"));
    }

    #[test]
    fn deny_gh_release_delete() {
        assert_eq!(matches_deny_pattern("gh release delete v1.0"), Some("gh release delete"));
    }

    // -- Deny pattern: rm, ssh, docker, etc. --

    #[test]
    fn deny_rm_rf_absolute() {
        assert_eq!(matches_deny_pattern("rm -rf /tmp/something"), Some("rm -rf with absolute path"));
    }

    #[test]
    fn deny_rm_rf_relative_allowed() {
        assert!(matches_deny_pattern("rm -rf ./node_modules").is_none());
    }

    #[test]
    fn deny_ssh_scp() {
        assert_eq!(matches_deny_pattern("ssh user@host"), Some("ssh/scp"));
        assert_eq!(matches_deny_pattern("scp file user@host:/tmp"), Some("ssh/scp"));
    }

    #[test]
    fn deny_docker_kubectl() {
        assert_eq!(matches_deny_pattern("docker run -it ubuntu"), Some("docker/kubectl"));
        assert_eq!(matches_deny_pattern("kubectl delete pod"), Some("docker/kubectl"));
    }

    #[test]
    fn deny_kill() {
        assert_eq!(matches_deny_pattern("kill -9 1234"), Some("kill"));
        assert_eq!(matches_deny_pattern("pkill -f node"), Some("kill"));
        assert_eq!(matches_deny_pattern("killall node"), Some("kill"));
    }

    #[test]
    fn deny_chmod_chown() {
        assert_eq!(matches_deny_pattern("chmod 777 /tmp/file"), Some("chmod/chown"));
        assert_eq!(matches_deny_pattern("chown root:root /tmp/file"), Some("chmod/chown"));
    }

    // -- Integration: evaluate() with Bash tool --

    #[test]
    fn bash_git_branch_delete_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git branch -d my-feature"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git branch delete"));
    }

    #[test]
    fn bash_git_branch_force_delete_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git branch -D my-feature"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git branch force-delete"));
    }

    #[test]
    fn bash_git_worktree_remove_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git worktree remove /tmp/some-worktree"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git worktree remove"));
    }

    #[test]
    fn bash_git_worktree_prune_requires_approval() {
        let result = evaluate("Bash", &json!({"command": "git worktree prune"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git worktree prune"));
    }

    #[test]
    fn bash_git_branch_list_auto_allowed() {
        let result = evaluate("Bash", &json!({"command": "git branch -a"}), WORKTREE, REPO, TrustLevel::Normal);
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    // -- Flag helpers --

    #[test]
    fn has_short_flag_combined() {
        assert!(has_short_flag(&["-Df"], 'D'));
        assert!(has_short_flag(&["-Df"], 'f'));
        assert!(!has_short_flag(&["-Df"], 'x'));
        assert!(!has_short_flag(&["--delete"], 'd'));
    }

    #[test]
    fn has_long_flag_exact() {
        assert!(has_long_flag(&["--force", "origin"], &["--force"]));
        assert!(!has_long_flag(&["-f", "origin"], &["--force"]));
    }

    // -- Hard blocks (bypass trust level) --

    #[test]
    fn hard_block_worktree_prune_in_full_auto() {
        let result = evaluate("Bash", &json!({"command": "git worktree prune"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("hard-blocked"));
    }

    #[test]
    fn hard_block_worktree_remove_in_full_auto() {
        let result = evaluate("Bash", &json!({"command": "git worktree remove /tmp/wt"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("hard-blocked"));
    }

    #[test]
    fn hard_block_git_c_worktree_prune() {
        let result = evaluate("Bash", &json!({"command": "git -C /other/project worktree prune"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_rm_verun_dir() {
        let result = evaluate("Bash", &json!({"command": "rm -rf .verun/worktrees/some-task"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains(".verun"));
    }

    #[test]
    fn hard_block_rm_verun_absolute() {
        let result = evaluate("Bash", &json!({"command": "rm -rf /projects/repo/.verun/worktrees"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_in_subshell() {
        let result = evaluate("Bash", &json!({"command": "(git worktree prune)"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_chained() {
        let result = evaluate("Bash", &json!({"command": "echo ok && git worktree remove /tmp/wt"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_bash_c_worktree() {
        let result = evaluate("Bash", &json!({"command": "bash -c 'git worktree prune'"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn full_auto_allows_safe_commands() {
        let result = evaluate("Bash", &json!({"command": "git push --force"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_git_worktree_list() {
        let result = evaluate("Bash", &json!({"command": "git worktree list"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn hard_block_env_wrapped_worktree() {
        let result = evaluate("Bash", &json!({"command": "env git worktree prune"}), WORKTREE, REPO, TrustLevel::FullAuto);
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }
}
