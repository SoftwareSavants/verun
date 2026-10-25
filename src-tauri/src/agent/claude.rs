use super::account_files::inherited_home_dir;
use super::{
    AbortStrategy, AccountHome, AccountProfile, Agent, AgentKind, AgentSkill, InputMode,
    SessionArgs,
};
use crate::accounts::identity::{
    non_empty_str, read_json_with_retry, unknown_identity, unread_file_identity, AccountIdentity,
    SignInStatus,
};
use crate::claude_home::ClaudeHome;
use crate::markdown_skills::{scan_commands_dir, scan_skills_dir};
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The env var that moves all of Claude's state: settings, history and the
/// signed-in account.
const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";

/// Claude Code - Anthropic's CLI coding agent.
///
/// Binary: `claude`
/// Streaming: `--output-format stream-json --input-format stream-json`
/// Resume: `--resume <session_id>`
/// Docs: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code
pub struct Claude;

impl Agent for Claude {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }
    fn cli_binary(&self) -> &'static str {
        "claude"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::StreamJsonStdin
    }

    fn install_hint(&self) -> &'static str {
        "npm i -g @anthropic-ai/claude-code"
    }

    fn update_hint(&self) -> &'static str {
        "claude update"
    }

    fn docs_url(&self) -> &'static str {
        "https://docs.anthropic.com/en/docs/claude-code/quickstart"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new(
                "claude-opus-5-5",
                "Claude Opus 5.5",
                "Recommended for most workloads",
            ),
            ModelOption::new(
                "claude-fable-5-1",
                "Claude Fable 5.1",
                "Most capable for demanding reasoning and long-horizon work",
            ),
            ModelOption::new("claude-opus-5", "Claude Opus 5", "Previous-generation Opus"),
            ModelOption::new(
                "claude-sonnet-5",
                "Claude Sonnet 5",
                "Balanced speed and intelligence",
            ),
            ModelOption::new(
                "claude-opus-4-8",
                "Claude Opus 4.8",
                "Previous-generation Opus",
            ),
            ModelOption::new(
                "claude-haiku-4-5",
                "Claude Haiku 4.5",
                "Fastest for quick answers",
            ),
        ]
    }

    fn build_session_args(&self, args: &SessionArgs<'_>) -> Vec<String> {
        // No `-p`: the CLI stays alive reading NDJSON on stdin across turns,
        // matching claude-agent-sdk-python (subprocess_cli.py:207).
        let mut v = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
        ];

        // Inject the per-task verun MCP server via `--mcp-config` rather than
        // writing into the project's `.mcp.json`. Without `--strict-mcp-config`
        // this is additive: the user's project, user, and local MCP configs
        // still load alongside ours.
        if let Some(path) = args.verun_mcp_config_path {
            v.extend(["--mcp-config".into(), path.to_string_lossy().into_owned()]);
        }

        if args.chrome_enabled {
            v.push("--chrome".into());
        }

        if args.plan_mode {
            v.extend(["--permission-mode".into(), "plan".into()]);
        }
        if let Some(rid) = args.resume_session_id {
            v.extend(["--resume".into(), rid.to_string()]);
        }
        if let Some(m) = args.model {
            v.extend(["--model".into(), m.to_string()]);
        }
        if args.thinking_mode {
            v.extend(["--effort".into(), "max".into()]);
        }
        if args.fast_mode {
            v.extend(["--effort".into(), "low".into()]);
        }
        v
    }

    fn supports_plan_mode(&self) -> bool {
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn supports_attachments(&self) -> bool {
        true
    }
    fn supports_fork(&self) -> bool {
        true
    }
    fn uses_claude_jsonl(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        let t = v.get("type")?.as_str()?;
        match t {
            "system" if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                v.get("session_id")?.as_str().map(str::to_string)
            }
            "result" => v.get("session_id")?.as_str().map(str::to_string),
            _ => None,
        }
    }

    fn persists_across_turns(&self) -> bool {
        true
    }

    fn abort_strategy(&self) -> AbortStrategy {
        AbortStrategy::Interrupt
    }

    fn encode_stream_user_message(
        &self,
        message: &str,
        attachments: &[crate::task::Attachment],
    ) -> Result<Vec<u8>, String> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut content_blocks: Vec<serde_json::Value> = Vec::new();
        for attachment in attachments {
            content_blocks.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": attachment.mime_type,
                    "data": STANDARD.encode(&attachment.data),
                }
            }));
        }
        if !message.is_empty() {
            content_blocks.push(serde_json::json!({ "type": "text", "text": message }));
        }

        let user_msg = serde_json::json!({
            "type": "user",
            "uuid": uuid::Uuid::new_v4().to_string(),
            "session_id": "",
            "parent_tool_use_id": null,
            "message": { "role": "user", "content": content_blocks },
        });

        let mut payload =
            serde_json::to_vec(&user_msg).map_err(|e| format!("serialize user msg: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_interrupt(&self, request_id: &str) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "interrupt" },
        });
        let mut payload =
            serde_json::to_vec(&envelope).map_err(|e| format!("serialize interrupt: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_set_permission_mode(
        &self,
        request_id: &str,
        mode: &str,
    ) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "set_permission_mode", "mode": mode },
        });
        let mut payload = serde_json::to_vec(&envelope)
            .map_err(|e| format!("serialize set_permission_mode: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn encode_stream_set_model(
        &self,
        request_id: &str,
        model: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let envelope = serde_json::json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "set_model", "model": model },
        });
        let mut payload =
            serde_json::to_vec(&envelope).map_err(|e| format!("serialize set_model: {e}"))?;
        payload.push(b'\n');
        Ok(payload)
    }

    fn discover_skills(&self, scan_root: Option<&Path>, agent_home: &Path) -> Vec<AgentSkill> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<AgentSkill> = Vec::new();

        let mut add = |skills: Vec<AgentSkill>| {
            for skill in skills {
                if seen.insert(skill.name.clone()) {
                    out.push(skill);
                }
            }
        };

        if let Some(root) = scan_root {
            add(scan_skills_dir(&root.join(".claude/skills")));
            add(scan_skills_dir(&root.join(".agents/skills")));
            add(scan_commands_dir(&root.join(".claude/commands")));
        }
        add(scan_skills_dir(&agent_home.join("skills")));
        add(scan_commands_dir(&agent_home.join("commands")));
        add(scan_installed_plugins(agent_home));

        out
    }

    fn account_profile(&self) -> Option<AccountProfile> {
        Some(AccountProfile {
            // Everything that can sign Claude in or route it elsewhere. An
            // account that needs a base URL sets its own.
            scrub_vars: &[
                CONFIG_DIR_VAR,
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "ANTHROPIC_BASE_URL",
            ],
            fixed_env: &[],
            api_key_vars: &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ],
            login_args: Some(&["auth", "login"]),
            logout_args: Some(&["auth", "logout"]),
            login_hint: None,
            logout_hint: None,
            allows_existing_dir: true,
            required_secret: None,
            in_project_env: true,
            min_cli_version: None,
        })
    }

    fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
        vec![(
            CONFIG_DIR_VAR.to_string(),
            dir.to_string_lossy().into_owned(),
        )]
    }

    fn account_standard_home(&self, user_home: &Path) -> Option<PathBuf> {
        // The standard layout, whatever `CLAUDE_CONFIG_DIR` Verun inherited.
        let standard = ClaudeHome::default_home(user_home, None);
        Some(standard.root().to_path_buf())
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        claude_identity(home, std::env::var_os(CONFIG_DIR_VAR))
    }
}

/// Who `claude` is signed in as at `home`. The signed-in account is the
/// `oauthAccount` of `.claude.json`, which logout removes; the tokens are in
/// the keychain and are never read. A home without the file, or without an
/// account in it, has nobody signed in. A file that is there but cannot be
/// read, or is not shaped like Claude's config, says nothing either way, so it
/// is `Unknown` rather than a guess at "signed out".
///
/// `inherited_config_dir` is the `CLAUDE_CONFIG_DIR` Verun itself was started
/// with, passed in so tests need not touch the process env.
fn claude_identity(
    home: AccountHome<'_>,
    inherited_config_dir: Option<OsString>,
) -> AccountIdentity {
    let path = claude_json_path(home, inherited_config_dir);
    let Some(json) = read_json_with_retry(&path) else {
        return unread_file_identity(&path);
    };
    let Some(config) = json.as_object() else {
        return unknown_identity(&path, "is not a JSON object");
    };
    match config.get("oauthAccount") {
        None | Some(serde_json::Value::Null) => {
            AccountIdentity::with_status(SignInStatus::SignedOut)
        }
        Some(account) if account.is_object() => AccountIdentity {
            status: SignInStatus::SignedIn,
            email: non_empty_str(account, "emailAddress"),
            org_name: non_empty_str(account, "organizationName"),
            plan: non_empty_str(account, "organizationType").map(|kind| plan_name(&kind)),
            providers: Vec::new(),
        },
        Some(_) => unknown_identity(&path, "has an oauthAccount that is not an object"),
    }
}

/// The `.claude.json` of a home, wherever `ClaudeHome` puts it: inside the dir
/// of an added account, beside `~/.claude` for Default. Default sessions keep
/// Verun's own env, so a `CLAUDE_CONFIG_DIR` exported where Verun was launched
/// is the Default home; as when sessions resolve their home, a value that is
/// empty or not UTF-8 counts as unset.
fn claude_json_path(home: AccountHome<'_>, inherited_config_dir: Option<OsString>) -> PathBuf {
    let claude_home = match home {
        AccountHome::Dir(dir) => ClaudeHome::for_config_dir(dir),
        AccountHome::Default { user_home } => {
            let inherited = inherited_home_dir(inherited_config_dir);
            ClaudeHome::default_home(user_home, inherited.as_deref())
        }
    };
    claude_home.config_json().to_path_buf()
}

/// The plan name for an `organizationType`; types not listed pass through.
fn plan_name(organization_type: &str) -> String {
    match organization_type {
        "claude_max" => "Max",
        "claude_pro" => "Pro",
        "claude_team" => "Team",
        "claude_enterprise" => "Enterprise",
        other => other,
    }
    .to_string()
}

/// Path of the CLI's global config: `$CLAUDE_CONFIG_DIR/.claude.json` when
/// set, else `~/.claude.json`.
fn claude_global_config_path(home: &Path, config_dir: Option<&Path>) -> std::path::PathBuf {
    config_dir.unwrap_or(home).join(".claude.json")
}

/// Whether the user turned on Claude in Chrome's "Enabled by default"
/// (`claudeInChromeDefaultEnabled`). The CLI only honours it in interactive
/// TUI sessions, so stream-json spawns must pass `--chrome` themselves.
pub fn chrome_default_enabled() -> bool {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return false;
    };
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from);
    chrome_default_enabled_at(&claude_global_config_path(&home, config_dir.as_deref()))
}

fn chrome_default_enabled_at(config_path: &Path) -> bool {
    std::fs::read(config_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("claudeInChromeDefaultEnabled")?.as_bool())
        .unwrap_or(false)
}

/// Reads `<agent_home>/plugins/installed_plugins.json` and scans each
/// active plugin's `skills/` and `commands/` directories. Mirrors how the CLI
/// itself resolves plugin content — catalog entries under `marketplaces/`
/// without a matching manifest entry are ignored.
fn scan_installed_plugins(agent_home: &Path) -> Vec<AgentSkill> {
    let manifest = agent_home.join("plugins/installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(plugins) = json.get("plugins").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entries in plugins.values() {
        let Some(array) = entries.as_array() else {
            continue;
        };
        for entry in array {
            let Some(install_path) = entry.get("installPath").and_then(|v| v.as_str()) else {
                continue;
            };
            let base = Path::new(install_path);
            skills.extend(scan_skills_dir(&base.join("skills")));
            skills.extend(scan_commands_dir(&base.join("commands")));
        }
    }
    skills
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn chrome_default_enabled_reads_global_config_flag() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        fs::write(&path, r#"{"claudeInChromeDefaultEnabled":true}"#).unwrap();
        assert!(chrome_default_enabled_at(&path));
        fs::write(&path, r#"{"claudeInChromeDefaultEnabled":false}"#).unwrap();
        assert!(!chrome_default_enabled_at(&path));
        fs::write(&path, r#"{}"#).unwrap();
        assert!(!chrome_default_enabled_at(&path));
        fs::write(&path, "not json").unwrap();
        assert!(!chrome_default_enabled_at(&path));
        assert!(!chrome_default_enabled_at(&dir.path().join("missing.json")));
    }

    #[test]
    fn claude_global_config_path_honors_config_dir() {
        let home = Path::new("/Users/me");
        assert_eq!(
            claude_global_config_path(home, None),
            home.join(".claude.json")
        );
        assert_eq!(
            claude_global_config_path(home, Some(Path::new("/custom"))),
            Path::new("/custom/.claude.json")
        );
    }

    /// The Default account's Claude home under a temp user home.
    fn claude_dir(home: &TempDir) -> PathBuf {
        home.path().join(".claude")
    }

    fn write_skill(dir: &Path, name: &str, body: &str) {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), body).unwrap();
    }

    fn write_command(dir: &Path, name: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{name}.md")), body).unwrap();
    }

    fn write_installed_plugins(agent_home: &Path, install_paths: &[&Path]) {
        let plugins_dir = agent_home.join("plugins");
        fs::create_dir_all(&plugins_dir).unwrap();
        let entries: Vec<String> = install_paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                format!(
                    r#""plugin-{i}@mp": [{{ "scope": "user", "installPath": "{}", "version": "1.0.0" }}]"#,
                    p.display()
                )
            })
            .collect();
        let json = format!(r#"{{"version":2,"plugins":{{ {} }}}}"#, entries.join(","));
        fs::write(plugins_dir.join("installed_plugins.json"), json).unwrap();
    }

    #[test]
    fn discover_skills_merges_project_global_and_plugins() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();

        let global_dir = home.path().join(".claude/skills");
        fs::create_dir_all(&global_dir).unwrap();
        write_skill(
            &global_dir,
            "global-only",
            "---\nname: global-only\ndescription: g\n---\n",
        );

        let project_dir = project.path().join(".claude/skills");
        fs::create_dir_all(&project_dir).unwrap();
        write_skill(
            &project_dir,
            "project-only",
            "---\nname: project-only\ndescription: p\n---\n",
        );

        let install_path = home.path().join(".claude/plugins/cache/mp/plugin-x/1.0.0");
        let plugin_skills = install_path.join("skills");
        fs::create_dir_all(&plugin_skills).unwrap();
        write_skill(
            &plugin_skills,
            "plugin-only",
            "---\nname: plugin-only\ndescription: pl\n---\n",
        );
        write_installed_plugins(&claude_dir(&home), &[&install_path]);

        let skills = Claude.discover_skills(Some(project.path()), &claude_dir(&home));
        let names: HashSet<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains("global-only"));
        assert!(names.contains("project-only"));
        assert!(names.contains("plugin-only"));
    }

    #[test]
    fn discover_skills_project_wins_on_name_collision() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();

        let global_dir = home.path().join(".claude/skills");
        fs::create_dir_all(&global_dir).unwrap();
        write_skill(
            &global_dir,
            "review",
            "---\nname: review\ndescription: global\n---\n",
        );

        let project_dir = project.path().join(".claude/skills");
        fs::create_dir_all(&project_dir).unwrap();
        write_skill(
            &project_dir,
            "review",
            "---\nname: review\ndescription: project override\n---\n",
        );

        let skills = Claude.discover_skills(Some(project.path()), &claude_dir(&home));
        let review: Vec<&AgentSkill> = skills.iter().filter(|s| s.name == "review").collect();
        assert_eq!(review.len(), 1);
        assert_eq!(review[0].description, "project override");
    }

    #[test]
    fn discover_skills_no_project_scans_only_global_and_plugins() {
        let home = TempDir::new().unwrap();
        let global_dir = home.path().join(".claude/skills");
        fs::create_dir_all(&global_dir).unwrap();
        write_skill(&global_dir, "g1", "---\nname: g1\ndescription: g\n---\n");

        let skills = Claude.discover_skills(None, &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["g1"]);
    }

    #[test]
    fn discover_skills_returns_empty_when_nothing_exists() {
        let home = TempDir::new().unwrap();
        assert!(Claude.discover_skills(None, &claude_dir(&home)).is_empty());
    }

    #[test]
    fn plugin_scan_reads_installed_plugin_cache() {
        let home = TempDir::new().unwrap();
        let install_path = home
            .path()
            .join(".claude/plugins/cache/official/code-review/1.0.0");
        let skills_dir = install_path.join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        write_skill(
            &skills_dir,
            "review",
            "---\nname: review\ndescription: PR review\n---\n",
        );
        write_installed_plugins(&claude_dir(&home), &[&install_path]);

        let skills = Claude.discover_skills(None, &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["review"]);
    }

    #[test]
    fn plugin_scan_ignores_uninstalled_marketplace_entries() {
        let home = TempDir::new().unwrap();
        let stray = home
            .path()
            .join(".claude/plugins/marketplaces/official/plugins/example/skills");
        fs::create_dir_all(&stray).unwrap();
        write_skill(
            &stray,
            "example-skill",
            "---\nname: example-skill\ndescription: catalog only\n---\n",
        );

        let skills = Claude.discover_skills(None, &claude_dir(&home));
        assert!(skills.iter().all(|s| s.name != "example-skill"));
    }

    #[test]
    fn discover_includes_project_commands() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let cmds_dir = project.path().join(".claude/commands");
        write_command(
            &cmds_dir,
            "bump-version",
            "---\nname: bump-version\ndescription: Bump the version\n---\n",
        );

        let skills = Claude.discover_skills(Some(project.path()), &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"bump-version"));
    }

    #[test]
    fn discover_includes_global_commands() {
        let home = TempDir::new().unwrap();
        let cmds_dir = home.path().join(".claude/commands");
        write_command(
            &cmds_dir,
            "my-global-cmd",
            "---\nname: my-global-cmd\ndescription: Global\n---\n",
        );

        let skills = Claude.discover_skills(None, &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"my-global-cmd"));
    }

    #[test]
    fn discover_includes_plugin_commands() {
        let home = TempDir::new().unwrap();
        let install_path = home.path().join(".claude/plugins/cache/mp/plugin-x/1.0.0");
        write_command(
            &install_path.join("commands"),
            "plugin-cmd",
            "---\nname: plugin-cmd\ndescription: from plugin\n---\n",
        );
        write_installed_plugins(&claude_dir(&home), &[&install_path]);

        let skills = Claude.discover_skills(None, &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"plugin-cmd"));
    }

    #[test]
    fn discover_includes_agents_skills_convention() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let agents_dir = project.path().join(".agents/skills");
        fs::create_dir_all(&agents_dir).unwrap();
        write_skill(
            &agents_dir,
            "tauri-v2",
            "---\nname: tauri-v2\ndescription: Tauri v2 helper\n---\n",
        );

        let skills = Claude.discover_skills(Some(project.path()), &claude_dir(&home));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"tauri-v2"));
    }

    #[test]
    fn discover_skills_reads_account_dir_layout() {
        // An account's dir is Claude's home itself: skills, commands and
        // plugins sit directly in it, with no `.claude` level.
        let account = TempDir::new().unwrap();
        write_skill(
            &account.path().join("skills"),
            "x",
            "---\nname: x\ndescription: from the account\n---\n",
        );
        write_command(
            &account.path().join("commands"),
            "deploy",
            "---\nname: deploy\ndescription: account command\n---\n",
        );
        let install_path = account.path().join("plugins/cache/mp/plugin-x/1.0.0");
        write_skill(
            &install_path.join("skills"),
            "from-plugin",
            "---\nname: from-plugin\ndescription: account plugin\n---\n",
        );
        write_installed_plugins(account.path(), &[&install_path]);

        let skills = Claude.discover_skills(None, account.path());
        let names: HashSet<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, HashSet::from(["x", "deploy", "from-plugin"]));
    }

    // ── Accounts ────────────────────────────────────────────────────────

    #[test]
    fn claude_account_profile_values() {
        assert_eq!(
            Claude.account_profile(),
            Some(AccountProfile {
                scrub_vars: &[
                    "CLAUDE_CONFIG_DIR",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                    "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_VERTEX",
                    "ANTHROPIC_BASE_URL",
                ],
                fixed_env: &[],
                api_key_vars: &[
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                ],
                login_args: Some(&["auth", "login"]),
                logout_args: Some(&["auth", "logout"]),
                login_hint: None,
                logout_hint: None,
                allows_existing_dir: true,
                required_secret: None,
                in_project_env: true,
                min_cli_version: None,
            })
        );
    }

    #[test]
    fn claude_home_env_sets_config_dir_verbatim() {
        // Claude hashes the exact string into its keychain entry, so nothing
        // may tidy the spelling on the way to the env.
        for dir in [
            "/x/Client Accounts/acme",
            "/x/Client Accounts/acme/",
            "/x/./acme/../acme",
            "/x/o'brien-é",
        ] {
            assert_eq!(
                Claude.account_home_env(Path::new(dir)),
                vec![("CLAUDE_CONFIG_DIR".to_string(), dir.to_string())],
                "dir: {dir}"
            );
        }
    }

    #[test]
    fn claude_standard_home_is_dot_claude() {
        assert_eq!(
            Claude.account_standard_home(Path::new("/Users/me")),
            Some(PathBuf::from("/Users/me/.claude"))
        );
    }

    #[test]
    fn claude_prepares_a_managed_dir_by_creating_it() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("accounts").join("a1");
        Claude.prepare_account_dir(&dir).unwrap();
        assert!(dir.is_dir());
        // Preparing it again leaves what is there alone.
        fs::write(dir.join("marker"), "").unwrap();
        Claude.prepare_account_dir(&dir).unwrap();
        assert!(dir.join("marker").exists());
    }

    fn write_claude_json(dir: &Path, json: &str) {
        fs::write(dir.join(".claude.json"), json).unwrap();
    }

    #[test]
    fn claude_identity_reads_oauth_account() {
        let dir = TempDir::new().unwrap();
        // Claude keeps much else in the file; only the account matters.
        write_claude_json(
            dir.path(),
            r#"{
                "numStartups": 12,
                "oauthAccount": {
                    "accountUuid": "a-1",
                    "emailAddress": "dev@acme.com",
                    "organizationName": "Acme",
                    "organizationType": "claude_max"
                },
                "projects": {}
            }"#,
        );
        assert_eq!(
            Claude.read_account_identity(AccountHome::Dir(dir.path())),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                email: Some("dev@acme.com".into()),
                org_name: Some("Acme".into()),
                plan: Some("Max".into()),
                providers: Vec::new(),
            }
        );
    }

    #[test]
    fn claude_identity_names_plans_and_passes_other_types_through() {
        for (organization_type, plan) in [
            ("claude_max", "Max"),
            ("claude_pro", "Pro"),
            ("claude_team", "Team"),
            ("claude_enterprise", "Enterprise"),
            ("claude_free", "claude_free"),
        ] {
            let dir = TempDir::new().unwrap();
            write_claude_json(
                dir.path(),
                &format!(r#"{{"oauthAccount":{{"organizationType":"{organization_type}"}}}}"#),
            );
            let identity = Claude.read_account_identity(AccountHome::Dir(dir.path()));
            assert_eq!(
                identity.plan.as_deref(),
                Some(plan),
                "type: {organization_type}"
            );
        }
    }

    #[test]
    fn claude_identity_is_signed_in_by_the_account_alone() {
        let dir = TempDir::new().unwrap();
        write_claude_json(
            dir.path(),
            r#"{"oauthAccount":{"emailAddress":"dev@acme.com","organizationName":""}}"#,
        );
        assert_eq!(
            Claude.read_account_identity(AccountHome::Dir(dir.path())),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                email: Some("dev@acme.com".into()),
                ..AccountIdentity::default()
            }
        );
    }

    #[test]
    fn claude_identity_signed_out_without_oauth_account() {
        // Logout removes the account, and a dir that never saw a login has no
        // file at all.
        for json in [Some("{}"), Some(r#"{"oauthAccount":null}"#), None] {
            let dir = TempDir::new().unwrap();
            if let Some(json) = json {
                write_claude_json(dir.path(), json);
            }
            assert_eq!(
                Claude.read_account_identity(AccountHome::Dir(dir.path())),
                AccountIdentity::with_status(SignInStatus::SignedOut),
                "file: {json:?}"
            );
        }
    }

    #[test]
    fn claude_identity_unknown_when_the_file_cannot_be_read() {
        // The file is there, so someone may well be signed in; "signed out"
        // would refuse the account on a guess.
        let unknown = AccountIdentity::with_status(SignInStatus::Unknown);
        // Not JSON, and empty, which is what a truncating rewrite leaves.
        for json in ["not json", ""] {
            let dir = TempDir::new().unwrap();
            write_claude_json(dir.path(), json);
            assert_eq!(
                Claude.read_account_identity(AccountHome::Dir(dir.path())),
                unknown,
                "file: {json:?}"
            );
        }
        // Not a file.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".claude.json")).unwrap();
        assert_eq!(
            Claude.read_account_identity(AccountHome::Dir(dir.path())),
            unknown
        );
    }

    #[test]
    fn claude_identity_unknown_for_an_unexpected_shape() {
        // Valid JSON, but not what Claude writes: not a logout either.
        for json in [
            r#"{"oauthAccount":"dev@acme.com"}"#,
            r#"{"oauthAccount":42}"#,
            r#"{"oauthAccount":true}"#,
            r#"{"oauthAccount":[]}"#,
            "[]",
            r#""dev@acme.com""#,
            "42",
            "null",
        ] {
            let dir = TempDir::new().unwrap();
            write_claude_json(dir.path(), json);
            assert_eq!(
                Claude.read_account_identity(AccountHome::Dir(dir.path())),
                AccountIdentity::with_status(SignInStatus::Unknown),
                "file: {json}"
            );
        }
    }

    #[test]
    fn claude_identity_default_reads_home_claude_json() {
        let home = TempDir::new().unwrap();
        write_claude_json(
            home.path(),
            r#"{"oauthAccount":{"emailAddress":"me@home.dev"}}"#,
        );
        // `~/.claude.json` sits beside `~/.claude`, not inside it.
        fs::create_dir(home.path().join(".claude")).unwrap();
        write_claude_json(
            &home.path().join(".claude"),
            r#"{"oauthAccount":{"emailAddress":"wrong@home.dev"}}"#,
        );

        let identity = claude_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            None,
        );
        assert_eq!(identity.status, SignInStatus::SignedIn);
        assert_eq!(identity.email.as_deref(), Some("me@home.dev"));
    }

    #[test]
    fn claude_identity_default_follows_the_inherited_config_dir() {
        // Default sessions keep Verun's env, so a CLAUDE_CONFIG_DIR exported
        // where Verun was launched is the Default home.
        let home = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_claude_json(
            home.path(),
            r#"{"oauthAccount":{"emailAddress":"home@x.dev"}}"#,
        );
        write_claude_json(
            inherited.path(),
            r#"{"oauthAccount":{"emailAddress":"inherited@x.dev"}}"#,
        );
        let default_email = |inherited: Option<OsString>| {
            let default = AccountHome::Default {
                user_home: home.path(),
            };
            claude_identity(default, inherited).email
        };

        assert_eq!(
            default_email(Some(inherited.path().into())).as_deref(),
            Some("inherited@x.dev")
        );
        // An empty value counts as unset.
        assert_eq!(
            default_email(Some(OsString::new())).as_deref(),
            Some("home@x.dev")
        );
        assert_eq!(default_email(None).as_deref(), Some("home@x.dev"));
    }

    #[cfg(unix)]
    #[test]
    fn claude_identity_default_treats_a_non_utf8_inherited_config_dir_as_unset() {
        // The same reading sessions give the variable when they resolve their
        // home, so both land on the same `.claude.json`.
        use std::os::unix::ffi::OsStringExt;
        let home = TempDir::new().unwrap();
        write_claude_json(
            home.path(),
            r#"{"oauthAccount":{"emailAddress":"home@x.dev"}}"#,
        );
        let inherited = OsString::from_vec(vec![b'/', 0xff, b'x']);
        let identity = claude_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            Some(inherited),
        );
        assert_eq!(identity.email.as_deref(), Some("home@x.dev"));
    }

    #[test]
    fn claude_identity_of_an_added_dir_ignores_the_inherited_config_dir() {
        let dir = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_claude_json(
            dir.path(),
            r#"{"oauthAccount":{"emailAddress":"acme@x.dev"}}"#,
        );
        write_claude_json(
            inherited.path(),
            r#"{"oauthAccount":{"emailAddress":"inherited@x.dev"}}"#,
        );
        let identity = claude_identity(AccountHome::Dir(dir.path()), Some(inherited.path().into()));
        assert_eq!(identity.email.as_deref(), Some("acme@x.dev"));
    }

    #[test]
    #[ignore]
    fn sanity_real_home() {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap();
        let project = std::env::current_dir()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()));
        let skills = Claude.discover_skills(project.as_deref(), &home.join(".claude"));
        println!("discovered {} skills", skills.len());
        let mut names: Vec<_> = skills.iter().map(|s| s.name.clone()).collect();
        names.sort();
        for n in &names {
            println!("  {n}");
        }
    }
}
