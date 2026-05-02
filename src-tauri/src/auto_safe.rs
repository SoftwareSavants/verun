//! Auto-safe policy: user-configurable defaults that drive `policy::evaluate`
//! when the task's trust level is `AutoSafe`.

// Some types/functions land in this commit but are wired in subsequent tasks
// (db helpers, policy refactor, IPC). Until then clippy treats them as dead.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadScope {
    Repo,
    Any,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteScope {
    Worktree,
    Repo,
    Any,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchMode {
    Allow,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebFetchMode {
    Allow,
    Domains,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpMode {
    Allow,
    Servers,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashPattern {
    pub id: String,
    pub pattern: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadConfig {
    pub scope: ReadScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteConfig {
    pub scope: WriteScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSearchConfig {
    pub mode: WebSearchMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebFetchConfig {
    pub mode: WebFetchMode,
    #[serde(default)]
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpConfig {
    pub mode: McpMode,
    #[serde(default)]
    pub servers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashConfig {
    pub patterns: Vec<BashPattern>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobalPolicy {
    pub version: u32,
    pub read: ReadConfig,
    pub write: WriteConfig,
    pub websearch: WebSearchConfig,
    pub webfetch: WebFetchConfig,
    pub mcp: McpConfig,
    pub bash: BashConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverrideBash {
    #[serde(default)]
    pub disabled_global: Vec<String>,
    #[serde(default)]
    pub extra: Vec<BashPattern>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectOverride {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<WriteConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websearch: Option<WebSearchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webfetch: Option<WebFetchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<McpConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bash: Option<ProjectOverrideBash>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectivePolicy {
    pub read: ReadConfig,
    pub write: WriteConfig,
    pub websearch: WebSearchConfig,
    pub webfetch: WebFetchConfig,
    pub mcp: McpConfig,
    pub bash_patterns: Vec<BashPattern>,
}

/// IDs of built-in Bash deny patterns. Stable across versions so per-project
/// `disabled_global` lists keep working when the global list shrinks/grows.
/// Each id maps to a single program/subcommand so the matcher can be a simple
/// "program + positional + flags" check; UI groups related patterns visually.
pub const BUILTIN_PATTERN_IDS: &[(&str, &str)] = &[
    ("sudo", "sudo"),
    ("ssh", "ssh"),
    ("scp", "scp"),
    ("rsync", "rsync"),
    ("kill", "kill"),
    ("pkill", "pkill"),
    ("killall", "killall"),
    ("chmod", "chmod"),
    ("chown", "chown"),
    ("docker", "docker"),
    ("kubectl", "kubectl"),
    ("git-push-force", "git push --force"),
    ("git-reset-hard", "git reset --hard"),
    ("git-clean-f", "git clean -f"),
    ("git-checkout-discard", "git checkout -- ."),
    ("git-branch-D", "git branch -D"),
    ("git-stash-drop", "git stash drop"),
    ("rm-rf", "rm -rf"),
    ("curl-pipe-sh", "curl | sh"),
];

pub fn defaults() -> GlobalPolicy {
    GlobalPolicy {
        version: 1,
        read: ReadConfig {
            scope: ReadScope::Repo,
        },
        write: WriteConfig {
            scope: WriteScope::Worktree,
        },
        websearch: WebSearchConfig {
            mode: WebSearchMode::Ask,
        },
        webfetch: WebFetchConfig {
            mode: WebFetchMode::Ask,
            domains: vec![],
        },
        mcp: McpConfig {
            mode: McpMode::Ask,
            servers: vec![],
        },
        bash: BashConfig {
            patterns: BUILTIN_PATTERN_IDS
                .iter()
                .map(|(id, label)| BashPattern {
                    id: (*id).into(),
                    pattern: (*label).into(),
                    builtin: true,
                })
                .collect(),
        },
    }
}

pub fn resolve_effective(
    global: &GlobalPolicy,
    project: Option<&ProjectOverride>,
) -> EffectivePolicy {
    let mut bash_patterns = global.bash.patterns.clone();
    if let Some(po) = project {
        if let Some(b) = po.bash.as_ref() {
            if !b.disabled_global.is_empty() {
                let disabled: std::collections::HashSet<&str> =
                    b.disabled_global.iter().map(|s| s.as_str()).collect();
                bash_patterns.retain(|bp| !disabled.contains(bp.id.as_str()));
            }
            for extra in &b.extra {
                bash_patterns.push(extra.clone());
            }
        }
    }
    EffectivePolicy {
        read: project
            .and_then(|p| p.read.clone())
            .unwrap_or_else(|| global.read.clone()),
        write: project
            .and_then(|p| p.write.clone())
            .unwrap_or_else(|| global.write.clone()),
        websearch: project
            .and_then(|p| p.websearch.clone())
            .unwrap_or_else(|| global.websearch.clone()),
        webfetch: project
            .and_then(|p| p.webfetch.clone())
            .unwrap_or_else(|| global.webfetch.clone()),
        mcp: project
            .and_then(|p| p.mcp.clone())
            .unwrap_or_else(|| global.mcp.clone()),
        bash_patterns,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_legacy_hardcoded_policy() {
        let p = defaults();
        assert_eq!(p.version, 1);
        assert_eq!(p.read.scope, ReadScope::Repo);
        assert_eq!(p.write.scope, WriteScope::Worktree);
        assert_eq!(p.websearch.mode, WebSearchMode::Ask);
        assert_eq!(p.webfetch.mode, WebFetchMode::Ask);
        assert_eq!(p.mcp.mode, McpMode::Ask);
        assert!(p.bash.patterns.iter().any(|b| b.id == "sudo"));
        assert!(p.bash.patterns.iter().any(|b| b.id == "git-push-force"));
        assert!(p.bash.patterns.iter().all(|b| b.builtin));
    }

    #[test]
    fn global_policy_round_trips_through_json() {
        let p = defaults();
        let s = serde_json::to_string(&p).unwrap();
        let back: GlobalPolicy = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn resolve_no_override_returns_global() {
        let g = defaults();
        let eff = resolve_effective(&g, None);
        assert_eq!(eff.read, g.read);
        assert_eq!(eff.write, g.write);
        assert_eq!(eff.bash_patterns, g.bash.patterns);
    }

    #[test]
    fn resolve_override_read_scope_wins() {
        let g = defaults();
        let po = ProjectOverride {
            version: 1,
            read: Some(ReadConfig {
                scope: ReadScope::Any,
            }),
            ..Default::default()
        };
        let eff = resolve_effective(&g, Some(&po));
        assert_eq!(eff.read.scope, ReadScope::Any);
        assert_eq!(eff.write, g.write);
    }

    #[test]
    fn resolve_disables_global_bash_pattern() {
        let g = defaults();
        let po = ProjectOverride {
            version: 1,
            bash: Some(ProjectOverrideBash {
                disabled_global: vec!["rsync".into()],
                extra: vec![],
            }),
            ..Default::default()
        };
        let eff = resolve_effective(&g, Some(&po));
        assert!(eff.bash_patterns.iter().any(|b| b.id == "sudo"));
        assert!(!eff.bash_patterns.iter().any(|b| b.id == "rsync"));
    }

    #[test]
    fn resolve_appends_project_extras() {
        let g = defaults();
        let po = ProjectOverride {
            version: 1,
            bash: Some(ProjectOverrideBash {
                disabled_global: vec![],
                extra: vec![BashPattern {
                    id: "user-npm-publish".into(),
                    pattern: "npm publish".into(),
                    builtin: false,
                }],
            }),
            ..Default::default()
        };
        let eff = resolve_effective(&g, Some(&po));
        assert!(eff.bash_patterns.iter().any(|b| b.id == "user-npm-publish"));
    }

    #[test]
    fn project_override_round_trips_through_json_with_omitted_keys() {
        let po = ProjectOverride {
            version: 1,
            read: Some(ReadConfig {
                scope: ReadScope::Any,
            }),
            ..Default::default()
        };
        let s = serde_json::to_string(&po).unwrap();
        assert!(!s.contains("\"write\""), "write key should be omitted: {s}");
        assert!(!s.contains("\"mcp\""), "mcp key should be omitted: {s}");
        let back: ProjectOverride = serde_json::from_str(&s).unwrap();
        assert_eq!(po, back);
    }

    #[test]
    fn project_override_bash_uses_camel_case() {
        let po = ProjectOverride {
            version: 1,
            bash: Some(ProjectOverrideBash {
                disabled_global: vec!["rsync".into()],
                extra: vec![],
            }),
            ..Default::default()
        };
        let s = serde_json::to_string(&po).unwrap();
        assert!(
            s.contains("\"disabledGlobal\""),
            "expected camelCase disabledGlobal: {s}"
        );
    }
}
