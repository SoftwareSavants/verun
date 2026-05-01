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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_supported_returns_bool() {
        // Smoke test: function returns without panicking. We can't assert
        // true/false because CI may or may not have `claude` on PATH.
        let _ = is_supported();
    }
}
