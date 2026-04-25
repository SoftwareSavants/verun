use super::{AbortStrategy, Agent, AgentKind, AgentSkill, InputMode, SessionArgs};
use crate::markdown_skills::{scan_commands_dir, scan_skills_dir};
use std::collections::HashSet;
use std::path::Path;

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
                "claude-opus-4-7",
                "Claude Opus 4.7",
                "Latest and most capable",
            )
            .with_min_version("2.1.111"),
            ModelOption::new(
                "claude-opus-4-6",
                "Claude Opus 4.6",
                "Most capable for complex tasks",
            ),
            ModelOption::new(
                "claude-sonnet-4-6",
                "Claude Sonnet 4.6",
                "Best for everyday tasks",
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

    fn discover_skills(
        &self,
        scan_root: Option<&Path>,
        user_home: &Path,
    ) -> Vec<AgentSkill> {
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
        add(scan_skills_dir(&user_home.join(".claude/skills")));
        add(scan_commands_dir(&user_home.join(".claude/commands")));
        add(scan_installed_plugins(user_home));

        out
    }
}

/// Reads `<user_home>/.claude/plugins/installed_plugins.json` and scans each
/// active plugin's `skills/` and `commands/` directories. Mirrors how the CLI
/// itself resolves plugin content — catalog entries under `marketplaces/`
/// without a matching manifest entry are ignored.
fn scan_installed_plugins(user_home: &Path) -> Vec<AgentSkill> {
    let manifest = user_home.join(".claude/plugins/installed_plugins.json");
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

    fn write_skill(dir: &Path, name: &str, body: &str) {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), body).unwrap();
    }

    fn write_command(dir: &Path, name: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{name}.md")), body).unwrap();
    }

    fn write_installed_plugins(home: &Path, install_paths: &[&Path]) {
        let plugins_dir = home.join(".claude/plugins");
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
        let json = format!(
            r#"{{"version":2,"plugins":{{ {} }}}}"#,
            entries.join(",")
        );
        fs::write(plugins_dir.join("installed_plugins.json"), json).unwrap();
    }

    #[test]
    fn discover_skills_merges_project_global_and_plugins() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();

        let global_dir = home.path().join(".claude/skills");
        fs::create_dir_all(&global_dir).unwrap();
        write_skill(&global_dir, "global-only", "---\nname: global-only\ndescription: g\n---\n");

        let project_dir = project.path().join(".claude/skills");
        fs::create_dir_all(&project_dir).unwrap();
        write_skill(&project_dir, "project-only", "---\nname: project-only\ndescription: p\n---\n");

        let install_path = home.path().join(".claude/plugins/cache/mp/plugin-x/1.0.0");
        let plugin_skills = install_path.join("skills");
        fs::create_dir_all(&plugin_skills).unwrap();
        write_skill(&plugin_skills, "plugin-only", "---\nname: plugin-only\ndescription: pl\n---\n");
        write_installed_plugins(home.path(), &[&install_path]);

        let skills = Claude.discover_skills(Some(project.path()), home.path());
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
        write_skill(&global_dir, "review", "---\nname: review\ndescription: global\n---\n");

        let project_dir = project.path().join(".claude/skills");
        fs::create_dir_all(&project_dir).unwrap();
        write_skill(&project_dir, "review", "---\nname: review\ndescription: project override\n---\n");

        let skills = Claude.discover_skills(Some(project.path()), home.path());
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

        let skills = Claude.discover_skills(None, home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["g1"]);
    }

    #[test]
    fn discover_skills_returns_empty_when_nothing_exists() {
        let home = TempDir::new().unwrap();
        assert!(Claude.discover_skills(None, home.path()).is_empty());
    }

    #[test]
    fn plugin_scan_reads_installed_plugin_cache() {
        let home = TempDir::new().unwrap();
        let install_path = home.path().join(".claude/plugins/cache/official/code-review/1.0.0");
        let skills_dir = install_path.join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        write_skill(&skills_dir, "review", "---\nname: review\ndescription: PR review\n---\n");
        write_installed_plugins(home.path(), &[&install_path]);

        let skills = Claude.discover_skills(None, home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["review"]);
    }

    #[test]
    fn plugin_scan_ignores_uninstalled_marketplace_entries() {
        let home = TempDir::new().unwrap();
        let stray = home.path().join(".claude/plugins/marketplaces/official/plugins/example/skills");
        fs::create_dir_all(&stray).unwrap();
        write_skill(&stray, "example-skill", "---\nname: example-skill\ndescription: catalog only\n---\n");

        let skills = Claude.discover_skills(None, home.path());
        assert!(skills.iter().all(|s| s.name != "example-skill"));
    }

    #[test]
    fn discover_includes_project_commands() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let cmds_dir = project.path().join(".claude/commands");
        write_command(&cmds_dir, "bump-version", "---\nname: bump-version\ndescription: Bump the version\n---\n");

        let skills = Claude.discover_skills(Some(project.path()), home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"bump-version"));
    }

    #[test]
    fn discover_includes_global_commands() {
        let home = TempDir::new().unwrap();
        let cmds_dir = home.path().join(".claude/commands");
        write_command(&cmds_dir, "my-global-cmd", "---\nname: my-global-cmd\ndescription: Global\n---\n");

        let skills = Claude.discover_skills(None, home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"my-global-cmd"));
    }

    #[test]
    fn discover_includes_plugin_commands() {
        let home = TempDir::new().unwrap();
        let install_path = home.path().join(".claude/plugins/cache/mp/plugin-x/1.0.0");
        write_command(&install_path.join("commands"), "plugin-cmd", "---\nname: plugin-cmd\ndescription: from plugin\n---\n");
        write_installed_plugins(home.path(), &[&install_path]);

        let skills = Claude.discover_skills(None, home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"plugin-cmd"));
    }

    #[test]
    fn discover_includes_agents_skills_convention() {
        let home = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let agents_dir = project.path().join(".agents/skills");
        fs::create_dir_all(&agents_dir).unwrap();
        write_skill(&agents_dir, "tauri-v2", "---\nname: tauri-v2\ndescription: Tauri v2 helper\n---\n");

        let skills = Claude.discover_skills(Some(project.path()), home.path());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"tauri-v2"));
    }

    #[test]
    #[ignore]
    fn sanity_real_home() {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap();
        let project = std::env::current_dir().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));
        let skills = Claude.discover_skills(project.as_deref(), &home);
        println!("discovered {} skills", skills.len());
        let mut names: Vec<_> = skills.iter().map(|s| s.name.clone()).collect();
        names.sort();
        for n in &names {
            println!("  {n}");
        }
    }
}
