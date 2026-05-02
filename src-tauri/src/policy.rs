use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Per-task trust level — controls how aggressively we auto-approve tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLevel {
    /// User-configurable auto-safe policy (the default). See `auto_safe`
    /// module + `EffectivePolicy` for what gets auto-allowed.
    AutoSafe,
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
            _ => Self::AutoSafe,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AutoSafe => "auto_safe",
            Self::FullAuto => "full_auto",
            Self::Supervised => "supervised",
        }
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Self::AutoSafe => 0,
            Self::FullAuto => 1,
            Self::Supervised => 2,
        }
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::FullAuto,
            2 => Self::Supervised,
            _ => Self::AutoSafe,
        }
    }

    pub fn from_atomic(atom: &AtomicU8) -> Self {
        Self::from_u8(atom.load(Ordering::Relaxed))
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
/// - `policy`: user-configured effective policy (read/write scopes, web/MCP
///   modes, bash deny patterns)
pub fn evaluate(
    tool_name: &str,
    tool_input: &serde_json::Value,
    worktree_path: &str,
    repo_path: &str,
    trust_level: TrustLevel,
    policy: &crate::auto_safe::EffectivePolicy,
) -> PolicyResult {
    if tool_name == "ExitPlanMode" {
        return PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: "plan review always requires user approval".into(),
        };
    }

    // Hard blocks — always require approval regardless of trust level.
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
        TrustLevel::AutoSafe => {}
    }

    use crate::auto_safe::{McpMode, ReadScope, WebFetchMode, WebSearchMode, WriteScope};

    match tool_name {
        "Read" | "Glob" | "Grep" | "LSP" => match policy.read.scope {
            ReadScope::Any => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "read scope = any".into(),
            },
            ReadScope::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "read scope = ask".into(),
            },
            ReadScope::Repo => {
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
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("{tool_name} with no file path"),
                    }
                }
            }
        },

        "Edit" | "Write" | "NotebookEdit" => {
            let path = extract_path(tool_input);
            match policy.write.scope {
                WriteScope::Any => PolicyResult {
                    decision: PolicyDecision::AutoAllow,
                    reason: "write scope = any".into(),
                },
                WriteScope::Ask => PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: "write scope = ask".into(),
                },
                WriteScope::Repo => match path {
                    Some(p) if is_path_within(&p, repo_path) => PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("write within project repo: {p}"),
                    },
                    Some(p) => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("write outside project repo: {p}"),
                    },
                    None => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("{tool_name} with no file path — cannot verify scope"),
                    },
                },
                WriteScope::Worktree => match path {
                    Some(p) if is_path_within(&p, worktree_path) => PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("write within worktree: {p}"),
                    },
                    Some(p) => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("write outside worktree: {p}"),
                    },
                    None => PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("{tool_name} with no file path — cannot verify scope"),
                    },
                },
            }
        }

        "Bash" => {
            let command = tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Some(pattern_id) = matches_user_patterns(command, &policy.bash_patterns) {
                PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("bash matches deny pattern: {pattern_id}"),
                }
            } else {
                PolicyResult {
                    decision: PolicyDecision::AutoAllowLogged,
                    reason: "bash command not in deny list".into(),
                }
            }
        }

        "Agent" => PolicyResult {
            decision: PolicyDecision::AutoAllow,
            reason: "agent tool — sub-calls evaluated individually".into(),
        },

        name if name.starts_with("mcp__") => {
            let server = name
                .trim_start_matches("mcp__")
                .split("__")
                .next()
                .unwrap_or("");
            match policy.mcp.mode {
                McpMode::Allow => PolicyResult {
                    decision: PolicyDecision::AutoAllow,
                    reason: "mcp mode = allow".into(),
                },
                McpMode::Ask => PolicyResult {
                    decision: PolicyDecision::RequireApproval,
                    reason: format!("MCP tool: {name}"),
                },
                McpMode::Servers => {
                    if policy.mcp.servers.iter().any(|s| s == server) {
                        PolicyResult {
                            decision: PolicyDecision::AutoAllow,
                            reason: format!("mcp server '{server}' in allowlist"),
                        }
                    } else {
                        PolicyResult {
                            decision: PolicyDecision::RequireApproval,
                            reason: format!("mcp server '{server}' not in allowlist"),
                        }
                    }
                }
            }
        }

        "WebSearch" => match policy.websearch.mode {
            WebSearchMode::Allow => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "websearch = allow".into(),
            },
            WebSearchMode::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "websearch = ask".into(),
            },
        },

        "WebFetch" => match policy.webfetch.mode {
            WebFetchMode::Allow => PolicyResult {
                decision: PolicyDecision::AutoAllow,
                reason: "webfetch = allow".into(),
            },
            WebFetchMode::Ask => PolicyResult {
                decision: PolicyDecision::RequireApproval,
                reason: "webfetch = ask".into(),
            },
            WebFetchMode::Domains => {
                let url = tool_input.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let host = parse_host(url).unwrap_or_default();
                if !host.is_empty()
                    && policy
                        .webfetch
                        .domains
                        .iter()
                        .any(|d| host_matches(&host, d))
                {
                    PolicyResult {
                        decision: PolicyDecision::AutoAllow,
                        reason: format!("webfetch host '{host}' in allowlist"),
                    }
                } else {
                    PolicyResult {
                        decision: PolicyDecision::RequireApproval,
                        reason: format!("webfetch host '{host}' not in allowlist"),
                    }
                }
            }
        },

        _ => PolicyResult {
            decision: PolicyDecision::RequireApproval,
            reason: format!("unknown tool: {tool_name}"),
        },
    }
}

// ---------------------------------------------------------------------------
// URL host parsing for WebFetch domain match
// ---------------------------------------------------------------------------

fn parse_host(url: &str) -> Option<String> {
    let after_scheme = url.find("://").map(|i| &url[i + 3..]).unwrap_or(url);
    let host_with_userinfo = after_scheme.split(['/', '?', '#']).next()?;
    let host = host_with_userinfo.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.split(':').next().unwrap_or("").to_string())
    }
}

/// DNS-label suffix match. `host_matches("api.github.com", "github.com")` = true,
/// `host_matches("notgithub.com", "github.com")` = false.
fn host_matches(host: &str, domain: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() {
        return false;
    }
    if h == d {
        return true;
    }
    h.ends_with(&format!(".{d}"))
}

// ---------------------------------------------------------------------------
// User-pattern Bash matcher
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ParsedPattern<'a> {
    /// Pattern display text (e.g. "git push --force"). Used as the
    /// human-readable reason on a match.
    label: &'a str,
    program: String,
    /// Subcommand words (positional args, in order) before any flags.
    subcommand: Vec<String>,
    /// Required flags (any leading-`-` token in the pattern).
    flags: Vec<String>,
    /// Special: pipe-to-shell (e.g. `curl | sh`).
    pipe_to_shell: bool,
}

fn parse_user_pattern(p: &crate::auto_safe::BashPattern) -> Option<ParsedPattern<'_>> {
    let text = p.pattern.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((left, right)) = text.split_once('|') {
        let left = left.trim();
        let right = right.trim();
        if matches!(right, "sh" | "bash" | "zsh") {
            let lhs_first = left.split_whitespace().next().unwrap_or("");
            return Some(ParsedPattern {
                label: &p.pattern,
                program: lhs_first.to_string(),
                subcommand: vec![],
                flags: vec![],
                pipe_to_shell: true,
            });
        }
    }
    let mut tokens = text.split_whitespace();
    let program = tokens.next()?.to_string();
    let mut subcommand = Vec::new();
    let mut flags = Vec::new();
    for tok in tokens {
        if tok.starts_with('-') {
            flags.push(tok.to_string());
        } else {
            subcommand.push(tok.to_string());
        }
    }
    Some(ParsedPattern {
        label: &p.pattern,
        program,
        subcommand,
        flags,
        pipe_to_shell: false,
    })
}

fn matches_user_patterns(
    command: &str,
    patterns: &[crate::auto_safe::BashPattern],
) -> Option<String> {
    let parsed: Vec<ParsedPattern<'_>> = patterns.iter().filter_map(parse_user_pattern).collect();
    if parsed.is_empty() {
        return None;
    }
    let list: yash_syntax::syntax::List = command.parse().ok()?;
    walk_user_match(&list, &parsed)
}

fn walk_user_match(
    list: &yash_syntax::syntax::List,
    patterns: &[ParsedPattern],
) -> Option<String> {
    for item in &list.0 {
        let aol = &*item.and_or;
        for pipeline in std::iter::once(&aol.first).chain(aol.rest.iter().map(|(_, p)| p)) {
            if let Some(r) = walk_pipeline_user_match(pipeline, patterns) {
                return Some(r);
            }
        }
    }
    None
}

fn walk_pipeline_user_match(
    pipeline: &yash_syntax::syntax::Pipeline,
    patterns: &[ParsedPattern],
) -> Option<String> {
    use yash_syntax::syntax::Command;
    if pipeline.commands.len() >= 2 {
        let first = pipeline.commands.first().unwrap();
        let last = pipeline.commands.last().unwrap();
        if let (Command::Simple(f), Command::Simple(l)) = (first.as_ref(), last.as_ref()) {
            let fp = f
                .words
                .first()
                .map(|(w, _)| w.to_string())
                .unwrap_or_default();
            let lp = l
                .words
                .first()
                .map(|(w, _)| w.to_string())
                .unwrap_or_default();
            if matches!(lp.as_str(), "sh" | "bash" | "zsh") {
                for p in patterns {
                    if p.pipe_to_shell && p.program == fp {
                        return Some(p.label.to_string());
                    }
                }
            }
        }
    }
    for cmd in &pipeline.commands {
        if let Some(r) = walk_command_user_match(cmd, patterns) {
            return Some(r);
        }
    }
    None
}

fn walk_command_user_match(
    cmd: &yash_syntax::syntax::Command,
    patterns: &[ParsedPattern],
) -> Option<String> {
    use yash_syntax::syntax::{Command, CompoundCommand};
    match cmd {
        Command::Simple(sc) => {
            let args: Vec<String> = sc.words.iter().map(|(w, _)| w.to_string()).collect();
            check_user_simple(&args, patterns)
        }
        Command::Compound(fcc) => match &fcc.command {
            CompoundCommand::Subshell { body, .. } => walk_user_match(body, patterns),
            CompoundCommand::Grouping(body) => walk_user_match(body, patterns),
            _ => None,
        },
        Command::Function(_) => None,
    }
}

fn check_user_simple(args: &[String], patterns: &[ParsedPattern]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let (program, rest) = skip_wrappers(args);
    let positional: Vec<&str> = rest
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();
    let flags: Vec<&str> = rest
        .iter()
        .filter(|a| a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();
    for p in patterns {
        if p.pipe_to_shell {
            continue;
        }
        if program != p.program {
            continue;
        }
        if positional.len() < p.subcommand.len() {
            continue;
        }
        if !p
            .subcommand
            .iter()
            .enumerate()
            .all(|(i, w)| positional[i] == w.as_str())
        {
            continue;
        }
        if p.flags
            .iter()
            .all(|req| flag_present(&flags, req, &p.program))
        {
            return Some(p.label.to_string());
        }
    }
    None
}

fn flag_present(present: &[&str], required: &str, program: &str) -> bool {
    if present.contains(&required) {
        return true;
    }
    if program == "git" && required == "--force" && present.contains(&"-f") {
        return true;
    }
    if required == "-rf" {
        // accept any rm-style flag combination that includes both r and f
        let combined: String = present.iter().copied().collect();
        let has_r = combined.contains('r') || present.contains(&"--recursive");
        let has_f = combined.contains('f') || present.contains(&"--force");
        return has_r && has_f;
    }
    false
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

/// Hard blocks that require approval regardless of trust level.
/// These protect Verun's own infrastructure (worktrees, .verun dirs).
/// Only parsed-and-matched patterns hard-block; parse failures fall through
/// so FullAuto can still auto-allow exotic shell (heredocs, etc).
fn matches_hard_block(command: &str) -> Option<&'static str> {
    let list: yash_syntax::syntax::List = command.parse().ok()?;
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
        "sudo" => check_hard_block_args(skip_sudo_flags(rest)),
        _ => None,
    }
}

fn skip_sudo_flags(args: &[String]) -> &[String] {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        if matches!(
            args[i].as_str(),
            "-u" | "-g" | "-C" | "-D" | "-r" | "-t" | "-p"
        ) {
            i += 2;
        } else {
            i += 1;
        }
    }
    &args[i..]
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

fn walk_list_with(list: &yash_syntax::syntax::List, check: CheckFn) -> Option<&'static str> {
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
    for cmd in &pipeline.commands {
        if let Some(r) = walk_command_with(cmd, check) {
            return Some(r);
        }
    }
    None
}

fn walk_command_with(cmd: &yash_syntax::syntax::Command, check: CheckFn) -> Option<&'static str> {
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

fn strip_outer_quotes(s: &str) -> String {
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
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

    fn default_policy() -> crate::auto_safe::EffectivePolicy {
        crate::auto_safe::resolve_effective(&crate::auto_safe::defaults(), None)
    }

    // -- Trust level overrides --

    #[test]
    fn full_auto_allows_everything() {
        let result = evaluate(
            "Bash",
            &json!({"command": "rm -rf /"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_heredoc_command() {
        let cmd = "cd /tmp/shein-research && python3 << 'PY'\n\
                   content = open('bundles/foo.js').read()\n\
                   print(content[0:100])\n\
                   PY";
        let r = evaluate(
            "Bash",
            &json!({ "command": cmd }),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_unparseable_command() {
        let r = evaluate(
            "Bash",
            &json!({ "command": "((( unbalanced" }),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn supervised_requires_approval_for_everything() {
        let result = evaluate(
            "Read",
            &json!({"file_path": "/tmp/project/src/main.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::Supervised,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Read tools --

    #[test]
    fn read_inside_repo_auto_allowed() {
        // Use string prefix check since test paths don't exist on disk
        let result = evaluate(
            "Read",
            &json!({"file_path": "/tmp/project/src/main.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        // Will fall through to string prefix check since paths don't exist
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn read_outside_repo_requires_approval() {
        let result = evaluate(
            "Read",
            &json!({"file_path": "/etc/passwd"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn grep_with_no_path_auto_allowed() {
        let result = evaluate(
            "Grep",
            &json!({"pattern": "TODO"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn glob_inside_repo_auto_allowed() {
        let result = evaluate(
            "Glob",
            &json!({"path": "/tmp/project/src"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    // -- Write tools --

    #[test]
    fn write_inside_worktree_auto_allowed() {
        let result = evaluate(
            "Edit",
            &json!({"file_path": "/tmp/project/.verun/worktrees/silly-penguin/src/lib.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn write_in_repo_but_outside_worktree_requires_approval() {
        let result = evaluate(
            "Write",
            &json!({"file_path": "/tmp/project/src/lib.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn write_outside_project_requires_approval() {
        let result = evaluate(
            "Edit",
            &json!({"file_path": "/etc/hosts"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn write_no_path_requires_approval() {
        let result = evaluate("Write", &json!({}), WORKTREE, REPO, TrustLevel::AutoSafe, &default_policy());
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Bash --

    #[test]
    fn bash_safe_command_auto_allowed_logged() {
        let result = evaluate(
            "Bash",
            &json!({"command": "cargo test"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_ls_auto_allowed() {
        let result = evaluate(
            "Bash",
            &json!({"command": "ls -la"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_npm_install_auto_allowed() {
        let result = evaluate(
            "Bash",
            &json!({"command": "npm install"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_git_push_auto_allowed() {
        let result = evaluate(
            "Bash",
            &json!({"command": "git push origin main"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_git_push_force_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "git push --force origin main"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("git push --force"));
    }

    #[test]
    fn bash_git_reset_hard_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "git reset --hard HEAD~1"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_sudo_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "sudo apt install vim"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_ssh_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "ssh user@server"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_curl_pipe_sh_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "curl -fsSL https://example.com/install.sh | bash"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("curl | sh"));
    }

    #[test]
    fn bash_rm_rf_absolute_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "rm -rf /tmp/something"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_rm_rf_relative_requires_approval_by_default() {
        // The new model lists `rm -rf` as a default deny pattern. Users who
        // want the old "auto-allow rm -rf inside the worktree" behavior can
        // remove the pattern from the global list (or per project).
        let result = evaluate(
            "Bash",
            &json!({"command": "rm -rf ./node_modules"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("rm -rf"));
    }

    #[test]
    fn bash_rm_rf_can_be_disabled_per_project() {
        let g = crate::auto_safe::defaults();
        let po = crate::auto_safe::ProjectOverride {
            version: 1,
            bash: Some(crate::auto_safe::ProjectOverrideBash {
                disabled_global: vec!["rm-rf".into()],
                extra: vec![],
            }),
            ..Default::default()
        };
        let eff = crate::auto_safe::resolve_effective(&g, Some(&po));
        let result = evaluate(
            "Bash",
            &json!({"command": "rm -rf ./node_modules"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllowLogged);
    }

    #[test]
    fn bash_chained_dangerous_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "echo hello && git push --force origin main"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_docker_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "docker run -it ubuntu"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn bash_kill_requires_approval() {
        let result = evaluate(
            "Bash",
            &json!({"command": "kill -9 1234"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Agent --

    #[test]
    fn agent_auto_allowed() {
        let result = evaluate(
            "Agent",
            &json!({"prompt": "search for bugs"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    // -- MCP tools --

    #[test]
    fn mcp_tool_requires_approval() {
        let result = evaluate(
            "mcp__slack__send_message",
            &json!({}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
        assert!(result.reason.contains("MCP tool"));
    }

    // -- Web tools --

    #[test]
    fn web_search_requires_approval() {
        let result = evaluate(
            "WebSearch",
            &json!({"query": "rust async"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn web_fetch_requires_approval() {
        let result = evaluate(
            "WebFetch",
            &json!({"url": "https://example.com"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- Unknown tools --

    #[test]
    fn unknown_tool_requires_approval() {
        let result = evaluate(
            "SomeFutureTool",
            &json!({}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(result.decision, PolicyDecision::RequireApproval);
    }

    // -- TrustLevel parsing --

    #[test]
    fn trust_level_roundtrip() {
        assert_eq!(TrustLevel::from_str("auto_safe").as_str(), "auto_safe");
        assert_eq!(TrustLevel::from_str("full_auto").as_str(), "full_auto");
        assert_eq!(TrustLevel::from_str("supervised").as_str(), "supervised");
        // Unknown strings, including the legacy "normal", fall back to AutoSafe.
        assert_eq!(TrustLevel::from_str("garbage").as_str(), "auto_safe");
        assert_eq!(TrustLevel::from_str("normal").as_str(), "auto_safe");
    }

    #[test]
    fn trust_level_strings_use_auto_safe() {
        assert_eq!(TrustLevel::AutoSafe.as_str(), "auto_safe");
        assert_eq!(TrustLevel::from_str("auto_safe"), TrustLevel::AutoSafe);
        // Numeric encoding unchanged so live atomics survive the rename.
        assert_eq!(TrustLevel::AutoSafe.to_u8(), 0);
        assert_eq!(TrustLevel::from_u8(0), TrustLevel::AutoSafe);
    }

    // -- TrustLevel <-> u8 for atomic sharing --

    #[test]
    fn trust_level_u8_roundtrip() {
        for lvl in [
            TrustLevel::AutoSafe,
            TrustLevel::FullAuto,
            TrustLevel::Supervised,
        ] {
            assert_eq!(TrustLevel::from_u8(lvl.to_u8()), lvl);
        }
    }

    #[test]
    fn trust_level_unknown_u8_defaults_to_normal() {
        assert_eq!(TrustLevel::from_u8(99), TrustLevel::AutoSafe);
        assert_eq!(TrustLevel::from_u8(u8::MAX), TrustLevel::AutoSafe);
    }

    #[test]
    fn trust_level_atomic_load_reflects_latest_store() {
        use std::sync::atomic::{AtomicU8, Ordering};
        let atom = AtomicU8::new(TrustLevel::AutoSafe.to_u8());
        assert_eq!(TrustLevel::from_atomic(&atom), TrustLevel::AutoSafe);
        atom.store(TrustLevel::FullAuto.to_u8(), Ordering::SeqCst);
        assert_eq!(TrustLevel::from_atomic(&atom), TrustLevel::FullAuto);
        atom.store(TrustLevel::Supervised.to_u8(), Ordering::SeqCst);
        assert_eq!(TrustLevel::from_atomic(&atom), TrustLevel::Supervised);
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

    // =====================================================================
    // Hard blocks — worktree ops & .verun deletion (all trust levels)
    // =====================================================================

    // -- Core: worktree prune/remove blocked at every trust level --

    #[test]
    fn hard_block_worktree_prune_full_auto() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
        assert!(r.reason.contains("hard-blocked"));
        assert!(r.reason.contains("verun-managed"));
    }

    #[test]
    fn hard_block_worktree_prune_normal() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
        assert!(r.reason.contains("hard-blocked"));
    }

    #[test]
    fn hard_block_worktree_prune_supervised() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::Supervised,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_remove_full_auto() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree remove /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
        assert!(r.reason.contains("hard-blocked"));
    }

    #[test]
    fn hard_block_worktree_remove_normal() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree remove /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
        assert!(r.reason.contains("hard-blocked"));
    }

    #[test]
    fn hard_block_worktree_remove_force_flag() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree remove --force /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- git -C cross-repo attacks --

    #[test]
    fn hard_block_git_c_worktree_prune() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git -C /other/project worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_git_c_worktree_remove() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git -C /other/repo worktree remove /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_git_multiple_c_flags() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git -C /a -C /b worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- .verun directory deletion --

    #[test]
    fn hard_block_rm_verun_relative() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm -rf .verun/worktrees/some-task"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
        assert!(r.reason.contains(".verun"));
    }

    #[test]
    fn hard_block_rm_verun_absolute() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm -rf /projects/repo/.verun/worktrees"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_rm_verun_without_rf() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm .verun/worktrees/task/.git"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_rm_verun_parent() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm -rf .verun"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_rm_verun_sibling_worktree() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm -rf ../other-task/.verun"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- Compound command evasions --

    #[test]
    fn hard_block_worktree_in_subshell() {
        let r = evaluate(
            "Bash",
            &json!({"command": "(git worktree prune)"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_in_brace_group() {
        let r = evaluate(
            "Bash",
            &json!({"command": "{ git worktree remove /tmp/wt; }"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_chained_and() {
        let r = evaluate(
            "Bash",
            &json!({"command": "echo ok && git worktree remove /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_chained_or() {
        let r = evaluate(
            "Bash",
            &json!({"command": "false || git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_worktree_chained_semicolon() {
        let r = evaluate(
            "Bash",
            &json!({"command": "echo ok; git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_rm_verun_chained() {
        let r = evaluate(
            "Bash",
            &json!({"command": "echo ok && rm -rf .verun/worktrees/task"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- Wrapper evasions --

    #[test]
    fn hard_block_env_worktree_prune() {
        let r = evaluate(
            "Bash",
            &json!({"command": "env git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_env_with_vars_worktree() {
        let r = evaluate(
            "Bash",
            &json!({"command": "env GIT_TERMINAL_PROMPT=0 git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_command_worktree() {
        let r = evaluate(
            "Bash",
            &json!({"command": "command git worktree remove /tmp/wt"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_sudo_worktree_prune() {
        let r = evaluate(
            "Bash",
            &json!({"command": "sudo git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_sudo_u_worktree_prune() {
        let r = evaluate(
            "Bash",
            &json!({"command": "sudo -u root git worktree prune"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_sudo_rm_verun() {
        let r = evaluate(
            "Bash",
            &json!({"command": "sudo rm -rf .verun/worktrees"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- Shell re-invocation --

    #[test]
    fn hard_block_bash_c_worktree() {
        let r = evaluate(
            "Bash",
            &json!({"command": "bash -c 'git worktree prune'"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_sh_c_worktree() {
        let r = evaluate(
            "Bash",
            &json!({"command": "sh -c 'git worktree remove /tmp/wt'"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn hard_block_bash_c_rm_verun() {
        let r = evaluate(
            "Bash",
            &json!({"command": "bash -c 'rm -rf .verun'"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::RequireApproval);
    }

    // -- Safe ops that must NOT be hard-blocked --

    #[test]
    fn full_auto_allows_non_worktree_destructive() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git push --force"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_worktree_list() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree list"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_worktree_add() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git worktree add /tmp/new-wt feature-branch"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_rm_without_verun() {
        let r = evaluate(
            "Bash",
            &json!({"command": "rm -rf ./node_modules"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_git_status() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git status"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn full_auto_allows_git_c_safe_op() {
        let r = evaluate(
            "Bash",
            &json!({"command": "git -C /other/repo status"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn hard_block_does_not_affect_non_bash_tools() {
        let r = evaluate(
            "Read",
            &json!({"file_path": "/tmp/project/src/main.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn hard_block_does_not_affect_write_tool() {
        let r = evaluate(
            "Write",
            &json!({"file_path": "/tmp/.verun/foo"}),
            WORKTREE,
            REPO,
            TrustLevel::FullAuto,
            &default_policy(),
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    // -- New EffectivePolicy-driven decisions --

    #[test]
    fn auto_safe_websearch_allow_when_policy_says_allow() {
        let mut p = crate::auto_safe::defaults();
        p.websearch.mode = crate::auto_safe::WebSearchMode::Allow;
        let eff = crate::auto_safe::resolve_effective(&p, None);
        let result = evaluate(
            "WebSearch",
            &json!({"query": "verun"}),
            "/tmp",
            "/tmp",
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(result.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn auto_safe_webfetch_domain_match_is_dns_label_suffix() {
        let mut p = crate::auto_safe::defaults();
        p.webfetch.mode = crate::auto_safe::WebFetchMode::Domains;
        p.webfetch.domains = vec!["github.com".into()];
        let eff = crate::auto_safe::resolve_effective(&p, None);

        let allow_sub = evaluate(
            "WebFetch",
            &json!({"url": "https://api.github.com/repos/foo"}),
            "/tmp",
            "/tmp",
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(allow_sub.decision, PolicyDecision::AutoAllow);

        let deny_lookalike = evaluate(
            "WebFetch",
            &json!({"url": "https://notgithub.com/x"}),
            "/tmp",
            "/tmp",
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(deny_lookalike.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn auto_safe_mcp_server_allowlist() {
        let mut p = crate::auto_safe::defaults();
        p.mcp.mode = crate::auto_safe::McpMode::Servers;
        p.mcp.servers = vec!["atlassian".into()];
        let eff = crate::auto_safe::resolve_effective(&p, None);

        let allow = evaluate(
            "mcp__atlassian__search",
            &json!({}),
            "/tmp",
            "/tmp",
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(allow.decision, PolicyDecision::AutoAllow);

        let deny = evaluate(
            "mcp__apollo__people_match",
            &json!({}),
            "/tmp",
            "/tmp",
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(deny.decision, PolicyDecision::RequireApproval);
    }

    #[test]
    fn auto_safe_read_scope_any_allows_outside_repo() {
        let mut p = crate::auto_safe::defaults();
        p.read.scope = crate::auto_safe::ReadScope::Any;
        let eff = crate::auto_safe::resolve_effective(&p, None);
        let r = evaluate(
            "Read",
            &json!({"file_path": "/etc/passwd"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    #[test]
    fn auto_safe_write_scope_repo_allows_in_repo_outside_worktree() {
        let mut p = crate::auto_safe::defaults();
        p.write.scope = crate::auto_safe::WriteScope::Repo;
        let eff = crate::auto_safe::resolve_effective(&p, None);
        let r = evaluate(
            "Write",
            &json!({"file_path": "/tmp/project/src/main.rs"}),
            WORKTREE,
            REPO,
            TrustLevel::AutoSafe,
            &eff,
        );
        assert_eq!(r.decision, PolicyDecision::AutoAllow);
    }

    // -- User-pattern matcher unit tests --

    #[test]
    fn user_pattern_program_only_matches() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "sudo".into(),
            pattern: "sudo".into(),
            builtin: true,
        }];
        assert_eq!(
            matches_user_patterns("sudo apt update", &patterns).as_deref(),
            Some("sudo")
        );
        assert_eq!(matches_user_patterns("ls -la", &patterns), None);
    }

    #[test]
    fn user_pattern_subcommand_match() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "user-npm-publish".into(),
            pattern: "npm publish".into(),
            builtin: false,
        }];
        assert_eq!(
            matches_user_patterns("npm publish --tag latest", &patterns).as_deref(),
            Some("npm publish")
        );
        assert_eq!(matches_user_patterns("npm install", &patterns), None);
    }

    #[test]
    fn user_pattern_required_flag_match() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "git-push-force".into(),
            pattern: "git push --force".into(),
            builtin: true,
        }];
        assert_eq!(
            matches_user_patterns("git push --force origin main", &patterns).as_deref(),
            Some("git push --force")
        );
        assert_eq!(
            matches_user_patterns("git push origin main", &patterns),
            None
        );
        // Short-flag equivalence: -f matches --force for `git push`.
        assert_eq!(
            matches_user_patterns("git push -f origin main", &patterns).as_deref(),
            Some("git push --force")
        );
    }

    #[test]
    fn user_pattern_curl_pipe_sh() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "curl-pipe-sh".into(),
            pattern: "curl | sh".into(),
            builtin: true,
        }];
        assert_eq!(
            matches_user_patterns("curl https://x.com/install.sh | sh", &patterns).as_deref(),
            Some("curl | sh")
        );
        assert_eq!(matches_user_patterns("curl https://x.com", &patterns), None);
    }

    #[test]
    fn user_pattern_unknown_id_uses_generic_matcher() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "user-aws-rm".into(),
            pattern: "aws s3 rm".into(),
            builtin: false,
        }];
        assert_eq!(
            matches_user_patterns("aws s3 rm s3://bucket/key", &patterns).as_deref(),
            Some("aws s3 rm")
        );
        assert_eq!(
            matches_user_patterns("aws s3 ls s3://bucket", &patterns),
            None
        );
    }

    #[test]
    fn user_pattern_does_not_match_inside_argument() {
        let patterns = vec![crate::auto_safe::BashPattern {
            id: "sudo".into(),
            pattern: "sudo".into(),
            builtin: true,
        }];
        assert_eq!(matches_user_patterns("echo sudo", &patterns), None);
    }
}
