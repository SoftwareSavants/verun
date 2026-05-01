//! Wraps the `claude plugin ...` CLI to power Verun's in-app plugin
//! marketplace browser. We deliberately avoid re-implementing install
//! mechanics — the CLI is the source of truth for what's installed,
//! enabled, and which marketplaces are configured.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub marketplace_name: String,
    /// `source` may be either an object or a bare string (e.g. "./plugins/foo")
    /// in the CLI output. Kept as `serde_json::Value` so callers can render
    /// whatever's available without losing data.
    #[serde(default)]
    pub source: serde_json::Value,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub install_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// Format: "<name>@<marketplace>"
    pub id: String,
    #[serde(default)]
    pub version: Option<String>,
    pub scope: String,
    pub enabled: bool,
    #[serde(default)]
    pub install_path: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
    #[serde(default)]
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub installed: Vec<InstalledPlugin>,
    pub available: Vec<AvailablePlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceInfo {
    pub name: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub install_location: Option<String>,
}

/// Returns true if `claude plugin --help` exits 0 — i.e. the installed
/// `claude` CLI is new enough to have the plugin subcommand.
pub fn is_supported() -> bool {
    Command::new("claude")
        .args(["plugin", "--help"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run_capture(args: &[&str]) -> Result<String, String> {
    let output = Command::new("claude")
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn `claude {}`: {e}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("`claude {}` failed: {detail}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `claude plugin list --json --available`
pub fn list_catalog() -> Result<PluginCatalog, String> {
    let out = run_capture(&["plugin", "list", "--json", "--available"])?;
    serde_json::from_str(&out).map_err(|e| format!("parse catalog json: {e}"))
}

/// `claude plugin marketplace list --json`
pub fn list_marketplaces() -> Result<Vec<MarketplaceInfo>, String> {
    let out = run_capture(&["plugin", "marketplace", "list", "--json"])?;
    serde_json::from_str(&out).map_err(|e| format!("parse marketplaces json: {e}"))
}

pub(crate) fn install_args<'a>(plugin_id: &'a str, scope: &'a str) -> Vec<&'a str> {
    vec!["plugin", "install", plugin_id, "--scope", scope]
}

pub(crate) fn uninstall_args(plugin_id: &str) -> Vec<&str> {
    vec!["plugin", "uninstall", plugin_id]
}

fn run_in(cwd: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("claude")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn `claude {}`: {e}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(detail);
    }
    Ok(())
}

/// `claude plugin install <pluginId> --scope user|project|local`.
/// `cwd` is the directory the install runs from — required so project /
/// local scopes write to the right `.claude/settings.json`.
pub fn install(plugin_id: &str, scope: &str, cwd: &str) -> Result<(), String> {
    run_in(cwd, &install_args(plugin_id, scope))
}

/// `claude plugin uninstall <pluginId>`.
pub fn uninstall(plugin_id: &str, cwd: &str) -> Result<(), String> {
    run_in(cwd, &uninstall_args(plugin_id))
}

/// `claude plugin enable <pluginId>`.
pub fn enable(plugin_id: &str, cwd: &str) -> Result<(), String> {
    run_in(cwd, &["plugin", "enable", plugin_id])
}

/// `claude plugin disable <pluginId>`.
pub fn disable(plugin_id: &str, cwd: &str) -> Result<(), String> {
    run_in(cwd, &["plugin", "disable", plugin_id])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_supported_returns_bool() {
        // Smoke test: function returns without panicking. We can't assert
        // true/false because CI may or may not have `claude` on PATH.
        let _ = is_supported();
    }

    #[test]
    fn parses_catalog_json() {
        let raw = r#"{
          "installed": [{
            "id": "superpowers@claude-plugins-official",
            "version": "5.0.7",
            "scope": "user",
            "enabled": true,
            "installPath": "/x/y/z",
            "installedAt": "2026-05-01T00:00:00Z",
            "lastUpdated": "2026-05-01T00:00:00Z"
          }],
          "available": [{
            "pluginId": "asana@claude-plugins-official",
            "name": "asana",
            "description": "Asana integration",
            "marketplaceName": "claude-plugins-official",
            "source": "./external_plugins/asana",
            "installCount": 8126
          },{
            "pluginId": "alloydb@claude-plugins-official",
            "name": "alloydb",
            "description": "AlloyDB",
            "marketplaceName": "claude-plugins-official",
            "source": {"source":"url","url":"https://example.com/x.git"}
          }]
        }"#;
        let cat: PluginCatalog = serde_json::from_str(raw).unwrap();
        assert_eq!(cat.installed.len(), 1);
        assert_eq!(cat.installed[0].id, "superpowers@claude-plugins-official");
        assert!(cat.installed[0].enabled);
        assert_eq!(cat.available.len(), 2);
        assert_eq!(cat.available[0].name, "asana");
        assert_eq!(cat.available[0].install_count, Some(8126));
        assert!(cat.available[0].source.is_string());
        assert!(cat.available[1].source.is_object());
    }

    #[test]
    fn parses_marketplaces_json() {
        let raw = r#"[{
          "name": "claude-plugins-official",
          "source": "github",
          "repo": "anthropics/claude-plugins-official",
          "installLocation": "/Users/x/.claude/plugins/marketplaces/claude-plugins-official"
        }]"#;
        let list: Vec<MarketplaceInfo> = serde_json::from_str(raw).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "claude-plugins-official");
        assert_eq!(list[0].source.as_deref(), Some("github"));
        assert_eq!(
            list[0].repo.as_deref(),
            Some("anthropics/claude-plugins-official")
        );
    }

    #[test]
    fn install_args_compose_correctly() {
        assert_eq!(
            install_args("asana@claude-plugins-official", "user"),
            vec![
                "plugin",
                "install",
                "asana@claude-plugins-official",
                "--scope",
                "user"
            ]
        );
        assert_eq!(
            install_args("foo@bar", "project"),
            vec!["plugin", "install", "foo@bar", "--scope", "project"]
        );
    }

    #[test]
    fn uninstall_args_compose_correctly() {
        assert_eq!(
            uninstall_args("asana@claude-plugins-official"),
            vec!["plugin", "uninstall", "asana@claude-plugins-official"]
        );
    }
}
