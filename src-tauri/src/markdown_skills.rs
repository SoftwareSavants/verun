//! Agent-agnostic helpers for discovering markdown-frontmatter skills and
//! slash-commands from filesystem conventions. Each agent that uses this
//! format (e.g. Claude) composes from these helpers inside its own
//! `Agent::discover_skills` impl.

use crate::agent::AgentSkill;
use std::fs;
use std::path::Path;

/// Parses the YAML frontmatter block at the top of a SKILL.md file and
/// extracts the skill `name` and `description`. Returns None if there is no
/// frontmatter or no name.
///
/// Only handles the limited subset that SKILL.md files use in practice:
/// single-line `key: value` entries with optional wrapping quotes. Full YAML
/// would require a dependency we don't need for two fields.
pub fn parse_skill_frontmatter(text: &str) -> Option<AgentSkill> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let block = &rest[..end];

    let mut name: Option<String> = None;
    let mut description = String::new();
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = unquote(value.trim());
        match key {
            "name" => name = Some(value),
            "description" => description = value,
            _ => {}
        }
    }
    let name = name.filter(|n| !n.is_empty())?;
    Some(AgentSkill { name, description })
}

fn unquote(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Reads a single field's value from a markdown file's YAML-ish frontmatter
/// block. Returns `None` if there's no frontmatter or the field is absent.
fn parse_frontmatter_field(text: &str, field: &str) -> Option<String> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let block = &rest[..end];
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == field {
            return Some(unquote(value.trim()));
        }
    }
    None
}

/// Enumerates `<dir>/*/SKILL.md`, returning a skill for each subdirectory that
/// has a parseable SKILL.md. Returns empty if the directory doesn't exist.
pub fn scan_skills_dir(dir: &Path) -> Vec<AgentSkill> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        let Ok(text) = fs::read_to_string(&skill_md) else {
            continue;
        };
        if let Some(skill) = parse_skill_frontmatter(&text) {
            skills.push(skill);
        }
    }
    skills
}

/// Enumerates `<dir>/*.md`, returning a skill for each top-level markdown file
/// that has parseable frontmatter. Slash commands use this flat layout
/// (`.claude/commands/<name>.md`) rather than the per-skill subdirectory
/// layout. Returns empty if the directory doesn't exist.
pub fn scan_commands_dir(dir: &Path) -> Vec<AgentSkill> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Filename is the canonical command name (matches how Claude Code's
        // plugin spec resolves slash commands). Frontmatter `name:` is honoured
        // when present so user-authored commands that set it explicitly still
        // win, but it's no longer required — most plugin command files only
        // declare `description:` and friends.
        let name = parse_frontmatter_field(&text, "name")
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| stem.to_string());
        let description = parse_frontmatter_field(&text, "description").unwrap_or_default();
        skills.push(AgentSkill { name, description });
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

    #[test]
    fn parses_name_and_description_from_frontmatter() {
        let md = "---\n\
                  name: review\n\
                  description: Review a pull request\n\
                  user-invocable: true\n\
                  ---\n\
                  \n\
                  # Review\n";
        let skill = parse_skill_frontmatter(md).expect("should parse");
        assert_eq!(skill.name, "review");
        assert_eq!(skill.description, "Review a pull request");
    }

    #[test]
    fn strips_wrapping_quotes_from_values() {
        let md = "---\n\
                  name: \"ship\"\n\
                  description: 'Ship workflow: merge, test, deploy'\n\
                  ---\n";
        let skill = parse_skill_frontmatter(md).expect("should parse");
        assert_eq!(skill.name, "ship");
        assert_eq!(skill.description, "Ship workflow: merge, test, deploy");
    }

    #[test]
    fn missing_description_parses_with_empty_string() {
        let md = "---\n\
                  name: barebones\n\
                  ---\n";
        let skill = parse_skill_frontmatter(md).expect("should parse");
        assert_eq!(skill.name, "barebones");
        assert_eq!(skill.description, "");
    }

    #[test]
    fn returns_none_when_name_missing() {
        let md = "---\n\
                  description: nameless\n\
                  ---\n";
        assert!(parse_skill_frontmatter(md).is_none());
    }

    #[test]
    fn parses_crlf_frontmatter_without_leaking_carriage_return() {
        let md = "---\r\nname: review\r\ndescription: Review a PR\r\n---\r\n# Review\r\n";
        let skill = parse_skill_frontmatter(md).expect("should parse CRLF frontmatter");
        assert_eq!(skill.name, "review");
        assert_eq!(skill.description, "Review a PR");
    }

    #[test]
    fn returns_none_when_no_frontmatter() {
        assert!(parse_skill_frontmatter("# just a heading\n").is_none());
    }

    #[test]
    fn scan_skills_dir_finds_each_subdirs_skill_md() {
        let tmp = TempDir::new().unwrap();
        write_skill(
            tmp.path(),
            "alpha",
            "---\nname: alpha\ndescription: A\n---\n",
        );
        write_skill(tmp.path(), "beta", "---\nname: beta\ndescription: B\n---\n");
        fs::create_dir_all(tmp.path().join("not-a-skill")).unwrap();

        let mut skills = scan_skills_dir(tmp.path());
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
    }

    #[test]
    fn scan_skills_dir_returns_empty_for_missing_dir() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_skills_dir(&tmp.path().join("nonexistent")).is_empty());
    }

    #[test]
    fn scan_commands_dir_finds_each_md_file() {
        let tmp = TempDir::new().unwrap();
        write_command(
            tmp.path(),
            "bump-version",
            "---\nname: bump-version\ndescription: Bump the version\n---\n",
        );
        write_command(
            tmp.path(),
            "ship",
            "---\nname: ship\ndescription: Ship it\n---\n",
        );
        fs::write(tmp.path().join("readme.txt"), "nope").unwrap();
        // No frontmatter — should still register, with name from filename.
        fs::write(tmp.path().join("stray.md"), "# no frontmatter\n").unwrap();

        let mut cmds = scan_commands_dir(tmp.path());
        cmds.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = cmds.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["bump-version", "ship", "stray"]);
    }

    #[test]
    fn scan_commands_dir_falls_back_to_filename_when_frontmatter_omits_name() {
        let tmp = TempDir::new().unwrap();
        // Anthropic plugin command shape: description-only frontmatter, no name.
        write_command(
            tmp.path(),
            "code-review",
            "---\nallowed-tools: Bash(gh pr view:*)\ndescription: Code review a pull request\n---\n",
        );

        let cmds = scan_commands_dir(tmp.path());
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "code-review");
        assert_eq!(cmds[0].description, "Code review a pull request");
    }

    #[test]
    fn scan_commands_dir_returns_empty_for_missing_dir() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_commands_dir(&tmp.path().join("nonexistent")).is_empty());
    }
}
