# Plugin Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plugins" page to Verun that lists every Claude Code plugin from configured marketplaces, lets the user search/filter/sort, and installs or uninstalls a plugin with one click into a chosen scope (user / project / local).

**Architecture:** Thin frontend over the `claude plugin ...` CLI. A new `plugin_marketplace` Rust module shells out to `claude plugin list/install/uninstall/enable/disable/marketplace ...`, parses the JSON, and exposes typed Tauri commands. The frontend adds a top-level page (toggled like SettingsPage / ArchivedPage) with a card grid powered by a Solid store that mirrors the catalog and tracks pending operations. No persistence: the catalog is held in memory, refreshed on user action; the source of truth for installed/enabled state is whatever `claude plugin list --json` returns.

**Tech Stack:** Rust (`tokio::task::spawn_blocking` + `std::process::Command`, `serde_json`), Solid.js (`createStore`, `<For>`, `createMemo`), UnoCSS, Tauri commands wired through `src-tauri/src/ipc.rs` and `src/lib/ipc.ts`. Tests run via `cargo test` and `pnpm test`.

**Out of scope for v1 (deferred):**
- Per-plugin detail drawer reading `plugin.json` from cache.
- UI for adding/removing marketplaces (users can still use `claude plugin marketplace add` directly).
- Update flow / enable+disable toggle on already-installed plugins (uninstall + reinstall is the v1 path).

---

## File Structure

**Rust (backend):**
- Create: `src-tauri/src/plugin_marketplace.rs` — subprocess wrappers, parsing, types. Mirrors the shape of `github.rs`: synchronous `pub fn` helpers that build a `Command`, run it, and parse `--json` output.
- Modify: `src-tauri/src/lib.rs` — `mod plugin_marketplace;` declaration and 8 new entries in the `tauri::generate_handler![...]` block.
- Modify: `src-tauri/src/ipc.rs` — 8 new `#[tauri::command] pub async fn` thin wrappers that call `tokio::task::spawn_blocking` with the helpers from `plugin_marketplace.rs`.

**TypeScript (frontend):**
- Modify: `src/types/index.ts` — append plugin types (`PluginInfo`, `PluginCatalog`, `PluginSource`, `MarketplaceInfo`, `PluginScope`).
- Modify: `src/lib/ipc.ts` — append 8 typed `invoke` wrappers under a new `// Plugins` section.
- Modify: `src/lib/ipc.test.ts` — add a `test('all plugin functions are exported', ...)` block.
- Create: `src/store/plugins.ts` — Solid store holding `catalog`, `marketplaces`, a `pending: Set<string>` for in-flight install/uninstall ops, and a `loadCatalog()` action.
- Modify: `src/store/ui.ts` — add `showPlugins` signal alongside `showSettings` / `showArchived`.
- Create: `src/components/PluginsPage.tsx` — full-screen page (search + filter + sort + grid).
- Create: `src/components/PluginCard.tsx` — single card with install/uninstall button + scope picker.
- Create: `src/components/PluginCard.test.tsx` — render + click tests.
- Create: `src/components/PluginsPage.test.tsx` — filtering/sorting/search tests.
- Modify: `src/components/Layout.tsx` — mount `<PluginsPage />` when `showPlugins()` is true (same `<Show when=...>` shape as Settings/Archived).
- Modify: `src/components/Sidebar.tsx` — add a Puzzle icon button that calls `setShowPlugins(true)`, placed beside the gear/archive buttons.

**Docs:**
- Modify: `CHANGELOG.md` — append a bullet under `## Unreleased`.
- Modify: `README.md` — add one bullet under the Features list.

---

## Task 1: Rust subprocess wrapper, types, and version check

**Files:**
- Create: `src-tauri/src/plugin_marketplace.rs`
- Modify: `src-tauri/src/lib.rs` (add module declaration only — handler registration is Task 5)

**What this task delivers:** A self-contained Rust module that can answer "is `claude plugin` available?" plus the type definitions every later task will use. No IPC wiring yet.

- [ ] **Step 1: Write the failing test for `is_supported()`**

Append to a new `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/plugin_marketplace.rs`:

```rust
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p verun_lib plugin_marketplace::tests::is_supported_returns_bool
```

Expected: FAIL with "no function named is_supported" (or similar — the module doesn't exist yet).

- [ ] **Step 3: Create the module with types and `is_supported`**

Create `src-tauri/src/plugin_marketplace.rs`:

```rust
//! Wraps the `claude plugin ...` CLI to power Verun's in-app plugin
//! marketplace browser. We deliberately avoid re-implementing install
//! mechanics — the CLI is the source of truth for what's installed,
//! enabled, and which marketplaces are configured.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    /// e.g. "git-subdir" | "url" | "github" | "local". Optional because
    /// some entries report `source` as a bare relative path string.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(rename = "ref", default)]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub marketplace_name: String,
    /// `source` may be either an object or a bare string (e.g. "./plugins/foo")
    /// in the CLI output. We keep it loose as `serde_json::Value` so callers
    /// can render whatever's available.
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
    pub scope: String, // "user" | "project" | "local"
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
    /// "github" | "url" | "local" | etc.
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
        let _ = is_supported();
    }
}
```

- [ ] **Step 4: Register the module**

In `src-tauri/src/lib.rs`, find the `mod` declarations (around line 1-24) and add `mod plugin_marketplace;` alphabetically (after `mod policy;`):

```rust
mod policy;
mod plugin_marketplace;
mod pty;
```

- [ ] **Step 5: Run tests to verify pass + zero clippy warnings**

```bash
cargo test -p verun_lib plugin_marketplace
cargo clippy -p verun_lib -- -D warnings
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/plugin_marketplace.rs src-tauri/src/lib.rs
git commit -m "feat(plugins): add plugin_marketplace module with types and version check"
```

---

## Task 2: Catalog and marketplace listing (parsing + shell-out)

**Files:**
- Modify: `src-tauri/src/plugin_marketplace.rs`

**What this task delivers:** Two functions — `list_catalog()` and `list_marketplaces()` — backed by parsing tests against frozen JSON fixtures so we don't depend on the live CLI.

- [ ] **Step 1: Write the failing parser tests**

Append to the `mod tests` block in `src-tauri/src/plugin_marketplace.rs`:

```rust
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
    // String-form source still parses (kept as Value)
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
    assert_eq!(list[0].repo.as_deref(), Some("anthropics/claude-plugins-official"));
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cargo test -p verun_lib plugin_marketplace
```

Expected: PASS for both new tests (the types from Task 1 already cover the shape).

- [ ] **Step 3: Add the shell-out functions**

In `src-tauri/src/plugin_marketplace.rs`, below `is_supported`, add:

```rust
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
```

- [ ] **Step 4: Verify everything still compiles and tests still pass**

```bash
cargo test -p verun_lib plugin_marketplace
cargo clippy -p verun_lib -- -D warnings
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_marketplace.rs
git commit -m "feat(plugins): list catalog and marketplaces via claude CLI"
```

---

## Task 3: Install / uninstall / enable / disable

**Files:**
- Modify: `src-tauri/src/plugin_marketplace.rs`

**What this task delivers:** Mutating actions. Each shells out to `claude plugin <verb> ...` and surfaces stderr on failure. Args composition is unit-tested so we don't have to actually mutate state in CI.

- [ ] **Step 1: Write the failing args-builder test**

Append to the `mod tests` block:

```rust
#[test]
fn install_args_compose_correctly() {
    assert_eq!(
        install_args("asana@claude-plugins-official", "user"),
        vec!["plugin", "install", "asana@claude-plugins-official", "--scope", "user"]
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
```

- [ ] **Step 2: Run it to verify fail**

```bash
cargo test -p verun_lib plugin_marketplace::tests::install_args_compose_correctly
```

Expected: FAIL — `install_args` not defined.

- [ ] **Step 3: Implement args builders + shell-out functions**

Below `list_marketplaces` in `src-tauri/src/plugin_marketplace.rs`:

```rust
pub(crate) fn install_args<'a>(plugin_id: &'a str, scope: &'a str) -> Vec<&'a str> {
    vec!["plugin", "install", plugin_id, "--scope", scope]
}

pub(crate) fn uninstall_args(plugin_id: &str) -> Vec<&str> {
    vec!["plugin", "uninstall", plugin_id]
}

/// `claude plugin install <pluginId> --scope user|project|local`.
/// `cwd` is the directory the install runs from — required so project /
/// local scopes write to the right `.claude/settings.json`.
pub fn install(plugin_id: &str, scope: &str, cwd: &str) -> Result<(), String> {
    let args = install_args(plugin_id, scope);
    let output = Command::new("claude")
        .current_dir(cwd)
        .args(&args)
        .output()
        .map_err(|e| format!("install spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `claude plugin uninstall <pluginId>`.
pub fn uninstall(plugin_id: &str, cwd: &str) -> Result<(), String> {
    let args = uninstall_args(plugin_id);
    let output = Command::new("claude")
        .current_dir(cwd)
        .args(&args)
        .output()
        .map_err(|e| format!("uninstall spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `claude plugin enable <pluginId>`.
pub fn enable(plugin_id: &str, cwd: &str) -> Result<(), String> {
    let output = Command::new("claude")
        .current_dir(cwd)
        .args(["plugin", "enable", plugin_id])
        .output()
        .map_err(|e| format!("enable spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `claude plugin disable <pluginId>`.
pub fn disable(plugin_id: &str, cwd: &str) -> Result<(), String> {
    let output = Command::new("claude")
        .current_dir(cwd)
        .args(["plugin", "disable", plugin_id])
        .output()
        .map_err(|e| format!("disable spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p verun_lib plugin_marketplace
cargo clippy -p verun_lib -- -D warnings
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugin_marketplace.rs
git commit -m "feat(plugins): install, uninstall, enable, and disable wrappers"
```

---

## Task 4: Tauri IPC commands

**Files:**
- Modify: `src-tauri/src/ipc.rs` (add 6 commands)
- Modify: `src-tauri/src/lib.rs` (register them in `generate_handler!`)

**What this task delivers:** The Rust functions from Tasks 1-3 callable from the frontend via `invoke(...)`. Each command runs the blocking shell-out in `spawn_blocking` to keep the tokio runtime free.

- [ ] **Step 1: Add the 6 commands to ipc.rs**

Append to the bottom of `src-tauri/src/ipc.rs`:

```rust
// ---------------------------------------------------------------------------
// Plugin marketplace
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn plugin_is_supported() -> Result<bool, String> {
    tokio::task::spawn_blocking(crate::plugin_marketplace::is_supported)
        .await
        .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
pub async fn plugin_list_catalog() -> Result<crate::plugin_marketplace::PluginCatalog, String> {
    flatten_join(tokio::task::spawn_blocking(crate::plugin_marketplace::list_catalog).await)
}

#[tauri::command]
pub async fn plugin_list_marketplaces() -> Result<Vec<crate::plugin_marketplace::MarketplaceInfo>, String> {
    flatten_join(tokio::task::spawn_blocking(crate::plugin_marketplace::list_marketplaces).await)
}

#[tauri::command]
pub async fn plugin_install(plugin_id: String, scope: String, cwd: String) -> Result<(), String> {
    flatten_join(
        tokio::task::spawn_blocking(move || {
            crate::plugin_marketplace::install(&plugin_id, &scope, &cwd)
        })
        .await,
    )
}

#[tauri::command]
pub async fn plugin_uninstall(plugin_id: String, cwd: String) -> Result<(), String> {
    flatten_join(
        tokio::task::spawn_blocking(move || {
            crate::plugin_marketplace::uninstall(&plugin_id, &cwd)
        })
        .await,
    )
}

#[tauri::command]
pub async fn plugin_set_enabled(plugin_id: String, enabled: bool, cwd: String) -> Result<(), String> {
    flatten_join(
        tokio::task::spawn_blocking(move || {
            if enabled {
                crate::plugin_marketplace::enable(&plugin_id, &cwd)
            } else {
                crate::plugin_marketplace::disable(&plugin_id, &cwd)
            }
        })
        .await,
    )
}
```

- [ ] **Step 2: Register the 6 commands**

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler![...]` block (starts around line 256). Append at the end of the list (right before the closing `])`):

```rust
            ipc::plugin_is_supported,
            ipc::plugin_list_catalog,
            ipc::plugin_list_marketplaces,
            ipc::plugin_install,
            ipc::plugin_uninstall,
            ipc::plugin_set_enabled,
```

- [ ] **Step 3: Compile and lint**

```bash
cargo check -p verun_lib
cargo clippy -p verun_lib -- -D warnings
```

Expected: green.

- [ ] **Step 4: Smoke test the new commands manually**

In a scratch terminal:

```bash
pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications
```

Open devtools console in the running app and run:

```js
await window.__TAURI__.core.invoke('plugin_is_supported')
// expect: true (since claude CLI is installed locally)
const cat = await window.__TAURI__.core.invoke('plugin_list_catalog')
// expect: { installed: [...], available: [...170+ items] }
```

Stop the dev server when satisfied.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(plugins): expose plugin marketplace commands over IPC"
```

---

## Task 5: Frontend types and IPC wrappers

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/ipc.test.ts`

**What this task delivers:** Typed `invoke` wrappers so the rest of the frontend never types the string `'plugin_list_catalog'` again.

- [ ] **Step 1: Write the failing wrapper-export test**

In `src/lib/ipc.test.ts`, append a new `test` block inside the existing `describe('ipc', ...)`:

```ts
test('all plugin functions are exported', () => {
    expect(typeof ipc.pluginIsSupported).toBe('function')
    expect(typeof ipc.pluginListCatalog).toBe('function')
    expect(typeof ipc.pluginListMarketplaces).toBe('function')
    expect(typeof ipc.pluginInstall).toBe('function')
    expect(typeof ipc.pluginUninstall).toBe('function')
    expect(typeof ipc.pluginSetEnabled).toBe('function')
})
```

- [ ] **Step 2: Run it to verify fail**

```bash
pnpm test src/lib/ipc.test.ts
```

Expected: FAIL — properties don't exist.

- [ ] **Step 3: Add the types**

Append to `src/types/index.ts`:

```ts
// ---------- Plugins ----------

export type PluginScope = 'user' | 'project' | 'local'

export interface PluginSourceObject {
  source?: string
  url?: string
  repo?: string
  path?: string
  ref?: string
  sha?: string
}

// Source can be either a structured object or a bare path string.
export type PluginSource = PluginSourceObject | string

export interface AvailablePlugin {
  pluginId: string
  name: string
  description: string
  marketplaceName: string
  source: PluginSource
  version?: string
  installCount?: number
}

export interface InstalledPlugin {
  id: string
  version?: string
  scope: PluginScope
  enabled: boolean
  installPath?: string
  installedAt?: string
  lastUpdated?: string
}

export interface PluginCatalog {
  installed: InstalledPlugin[]
  available: AvailablePlugin[]
}

export interface MarketplaceInfo {
  name: string
  source?: string
  repo?: string
  url?: string
  installLocation?: string
}
```

- [ ] **Step 4: Add the IPC wrappers**

Append to `src/lib/ipc.ts` (and add the new types to the existing `import type { ... }` line at the top):

```ts
// Plugins
export const pluginIsSupported = () =>
  invoke<boolean>('plugin_is_supported')

export const pluginListCatalog = () =>
  invoke<PluginCatalog>('plugin_list_catalog')

export const pluginListMarketplaces = () =>
  invoke<MarketplaceInfo[]>('plugin_list_marketplaces')

export const pluginInstall = (pluginId: string, scope: PluginScope, cwd: string) =>
  invoke<void>('plugin_install', { pluginId, scope, cwd })

export const pluginUninstall = (pluginId: string, cwd: string) =>
  invoke<void>('plugin_uninstall', { pluginId, cwd })

export const pluginSetEnabled = (pluginId: string, enabled: boolean, cwd: string) =>
  invoke<void>('plugin_set_enabled', { pluginId, enabled, cwd })
```

Update the import line at the top of `src/lib/ipc.ts` to add `PluginCatalog, MarketplaceInfo, PluginScope` to the existing type import.

- [ ] **Step 5: Run tests to verify pass + typecheck**

```bash
pnpm test src/lib/ipc.test.ts
pnpm check
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(plugins): typed IPC wrappers for plugin marketplace"
```

---

## Task 6: Plugins store + UI signal + Layout / Sidebar wiring

**Files:**
- Create: `src/store/plugins.ts`
- Modify: `src/store/ui.ts`
- Modify: `src/components/Layout.tsx`
- Modify: `src/components/Sidebar.tsx`

**What this task delivers:** Visible empty page wired to a refresh-on-mount store. The page itself (Task 7) is a placeholder for now; this task puts the navigation in place and fetches the catalog.

- [ ] **Step 1: Create the store**

Create `src/store/plugins.ts`:

```ts
import { createStore } from 'solid-js/store'
import { createSignal } from 'solid-js'
import type { PluginCatalog, MarketplaceInfo, PluginScope } from '../types'
import * as ipc from '../lib/ipc'
import { addToast } from './ui'

export const [catalog, setCatalog] = createStore<PluginCatalog>({ installed: [], available: [] })
export const [marketplaces, setMarketplaces] = createStore<MarketplaceInfo[]>([])
export const [isSupported, setIsSupported] = createSignal<boolean | null>(null)
export const [isLoading, setIsLoading] = createSignal(false)
export const [pending, setPending] = createStore<Record<string, true>>({})

export function isPending(pluginId: string): boolean {
  return !!pending[pluginId]
}

export function isInstalled(pluginId: string): boolean {
  return catalog.installed.some(p => p.id === pluginId)
}

export async function loadCatalog() {
  setIsLoading(true)
  try {
    const supported = await ipc.pluginIsSupported()
    setIsSupported(supported)
    if (!supported) return
    const [cat, mps] = await Promise.all([
      ipc.pluginListCatalog(),
      ipc.pluginListMarketplaces(),
    ])
    setCatalog(cat)
    setMarketplaces(mps)
  } catch (e) {
    addToast({ kind: 'error', message: `Failed to load plugin catalog: ${e}` })
  } finally {
    setIsLoading(false)
  }
}

export async function installPlugin(pluginId: string, scope: PluginScope, cwd: string) {
  setPending(pluginId, true)
  try {
    await ipc.pluginInstall(pluginId, scope, cwd)
    await loadCatalog()
    addToast({ kind: 'success', message: `Installed ${pluginId}` })
  } catch (e) {
    addToast({ kind: 'error', message: `Install failed: ${e}` })
  } finally {
    setPending(pluginId, undefined as unknown as true)
  }
}

export async function uninstallPlugin(pluginId: string, cwd: string) {
  setPending(pluginId, true)
  try {
    await ipc.pluginUninstall(pluginId, cwd)
    await loadCatalog()
    addToast({ kind: 'success', message: `Uninstalled ${pluginId}` })
  } catch (e) {
    addToast({ kind: 'error', message: `Uninstall failed: ${e}` })
  } finally {
    setPending(pluginId, undefined as unknown as true)
  }
}
```

- [ ] **Step 2: Add the UI signal**

In `src/store/ui.ts`, find the line `export const [showSettings, setShowSettings] = createSignal(false)` and add directly below it:

```ts
export const [showPlugins, setShowPlugins] = createSignal(false)
```

- [ ] **Step 3: Add a placeholder PluginsPage so we can mount it**

Create `src/components/PluginsPage.tsx`:

```tsx
import { Component, onMount, Show } from 'solid-js'
import { loadCatalog, isLoading, isSupported } from '../store/plugins'
import { setShowPlugins } from '../store/ui'
import { X } from 'lucide-solid'

export const PluginsPage: Component = () => {
  onMount(() => { void loadCatalog() })
  return (
    <div class="absolute inset-0 bg-bg z-20 flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b-1 border-b-solid border-b-white/8">
        <h1 class="text-lg font-medium">Plugins</h1>
        <button class="p-1 rounded hover:bg-white/5" onClick={() => setShowPlugins(false)} aria-label="Close">
          <X class="w-4 h-4" />
        </button>
      </div>
      <div class="flex-1 overflow-auto p-4">
        <Show when={isSupported() === false}>
          <p class="text-sm text-fg/60">Update Claude Code to 2.0+ to use the plugin marketplace.</p>
        </Show>
        <Show when={isLoading()}>
          <p class="text-sm text-fg/60">Loading…</p>
        </Show>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it in Layout**

In `src/components/Layout.tsx`, add `showPlugins` to the existing imports from `'../store/ui'`, import `PluginsPage`, and add a `<Show when={showPlugins()}><PluginsPage /></Show>` next to the existing `<Show when={showSettings()}>` block.

- [ ] **Step 5: Add a sidebar button**

In `src/components/Sidebar.tsx`, add `Puzzle` to the existing `lucide-solid` imports, add `setShowPlugins` to the imports from `'../store/ui'`, and add a button beside the existing Settings/Archive buttons:

```tsx
<button
  class="p-1.5 rounded hover:bg-white/5"
  title="Plugins"
  onClick={() => setShowPlugins(true)}
>
  <Puzzle class="w-4 h-4" />
</button>
```

- [ ] **Step 6: Verify it renders end-to-end**

```bash
pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications
```

Click the Puzzle icon in the sidebar. Expect: a full-screen "Plugins" page with a close X. Console should show no errors. Close, reopen — works.

- [ ] **Step 7: Commit**

```bash
git add src/store/plugins.ts src/store/ui.ts src/components/PluginsPage.tsx src/components/Layout.tsx src/components/Sidebar.tsx
git commit -m "feat(plugins): plugins store and full-screen page placeholder"
```

---

## Task 7: PluginCard with one-click install

**Files:**
- Create: `src/components/PluginCard.tsx`
- Create: `src/components/PluginCard.test.tsx`

**What this task delivers:** The unit the user clicks. Default install scope is `user`. A scope picker is reachable via a small dropdown next to the install button. Pending state shows a spinner.

- [ ] **Step 1: Write the failing render test**

Create `src/components/PluginCard.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { PluginCard } from './PluginCard'
import type { AvailablePlugin } from '../types'

vi.mock('../store/plugins', () => ({
  isInstalled: vi.fn(() => false),
  isPending: vi.fn(() => false),
  installPlugin: vi.fn().mockResolvedValue(undefined),
  uninstallPlugin: vi.fn().mockResolvedValue(undefined),
}))

const sample: AvailablePlugin = {
  pluginId: 'asana@claude-plugins-official',
  name: 'asana',
  description: 'Asana integration',
  marketplaceName: 'claude-plugins-official',
  source: './external_plugins/asana',
  installCount: 8126,
}

describe('PluginCard', () => {
  beforeEach(() => vi.clearAllMocks())

  test('renders name, description, and install count', () => {
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" />)
    expect(getByText('asana')).toBeTruthy()
    expect(getByText(/Asana integration/)).toBeTruthy()
    expect(getByText(/8,126/)).toBeTruthy()
  })

  test('clicking Install calls installPlugin with default scope user', async () => {
    const { installPlugin } = await import('../store/plugins')
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" />)
    fireEvent.click(getByText('Install'))
    expect(installPlugin).toHaveBeenCalledWith('asana@claude-plugins-official', 'user', '/tmp')
  })

  test('shows Uninstall when already installed', async () => {
    const mod = await import('../store/plugins')
    ;(mod.isInstalled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" />)
    expect(getByText('Uninstall')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify fail**

```bash
pnpm test src/components/PluginCard.test.tsx
```

Expected: FAIL — `PluginCard` not found.

- [ ] **Step 3: Implement the card**

Create `src/components/PluginCard.tsx`:

```tsx
import { Component, Show, createSignal } from 'solid-js'
import { Loader2, Download, Trash2, ChevronDown } from 'lucide-solid'
import type { AvailablePlugin, PluginScope } from '../types'
import { installPlugin, uninstallPlugin, isInstalled, isPending } from '../store/plugins'

interface Props {
  plugin: AvailablePlugin
  cwd: string
}

export const PluginCard: Component<Props> = (props) => {
  const [scope, setScope] = createSignal<PluginScope>('user')
  const [scopeOpen, setScopeOpen] = createSignal(false)

  const installed = () => isInstalled(props.plugin.pluginId)
  const pending = () => isPending(props.plugin.pluginId)

  return (
    <div class="ring-1 ring-white/8 rounded-lg p-4 flex flex-col gap-3 bg-bg">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="font-medium truncate">{props.plugin.name}</h3>
          <p class="text-xs text-fg/50 truncate">{props.plugin.marketplaceName}</p>
        </div>
        <Show when={props.plugin.installCount != null}>
          <span class="text-xs text-fg/60 shrink-0">
            {props.plugin.installCount!.toLocaleString()} installs
          </span>
        </Show>
      </div>
      <p class="text-sm text-fg/80 line-clamp-3">{props.plugin.description}</p>
      <div class="flex items-center gap-2 mt-auto">
        <Show
          when={!installed()}
          fallback={
            <button
              class="flex-1 px-3 py-1.5 rounded ring-1 ring-white/10 hover:bg-white/5 text-sm flex items-center justify-center gap-1.5"
              disabled={pending()}
              onClick={() => uninstallPlugin(props.plugin.pluginId, props.cwd)}
            >
              <Show when={pending()} fallback={<Trash2 class="w-3.5 h-3.5" />}>
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
              </Show>
              Uninstall
            </button>
          }
        >
          <button
            class="flex-1 px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
            disabled={pending()}
            onClick={() => installPlugin(props.plugin.pluginId, scope(), props.cwd)}
          >
            <Show when={pending()} fallback={<Download class="w-3.5 h-3.5" />}>
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
            </Show>
            Install
          </button>
          <div class="relative">
            <button
              class="px-2 py-1.5 rounded ring-1 ring-white/10 hover:bg-white/5 text-xs flex items-center gap-1"
              onClick={() => setScopeOpen(o => !o)}
              title="Install scope"
            >
              {scope()} <ChevronDown class="w-3 h-3" />
            </button>
            <Show when={scopeOpen()}>
              <div class="absolute right-0 top-full mt-1 ring-1 ring-white/10 rounded bg-bg z-10 min-w-24">
                {(['user', 'project', 'local'] as const).map(s => (
                  <button
                    class="block w-full px-3 py-1.5 text-left text-xs hover:bg-white/5"
                    onClick={() => { setScope(s); setScopeOpen(false) }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test src/components/PluginCard.test.tsx
pnpm check
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PluginCard.tsx src/components/PluginCard.test.tsx
git commit -m "feat(plugins): plugin card with one-click install and scope picker"
```

---

## Task 8: PluginsPage — search, filter, sort, grid

**Files:**
- Modify: `src/components/PluginsPage.tsx`
- Create: `src/components/PluginsPage.test.tsx`

**What this task delivers:** The actual browseable page. Search box on top, marketplace multi-select pills, "installed only" toggle, sort dropdown, grid of `PluginCard`s.

- [ ] **Step 1: Write the failing tests**

Create `src/components/PluginsPage.test.tsx`:

```tsx
import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@solidjs/testing-library'
import { PluginsPage } from './PluginsPage'

vi.mock('../store/plugins', () => {
  const { createStore } = require('solid-js/store')
  const [catalog] = createStore({
    installed: [{ id: 'asana@claude-plugins-official', scope: 'user', enabled: true }],
    available: [
      { pluginId: 'asana@claude-plugins-official', name: 'asana', description: 'Asana stuff', marketplaceName: 'claude-plugins-official', source: '', installCount: 100 },
      { pluginId: 'amplitude@claude-plugins-official', name: 'amplitude', description: 'Analytics', marketplaceName: 'claude-plugins-official', source: '', installCount: 50 },
      { pluginId: 'foo@other-mp', name: 'foo', description: 'A foo plugin', marketplaceName: 'other-mp', source: '', installCount: 999 },
    ],
  })
  return {
    catalog,
    marketplaces: [
      { name: 'claude-plugins-official' },
      { name: 'other-mp' },
    ],
    isSupported: () => true,
    isLoading: () => false,
    isInstalled: (id: string) => id === 'asana@claude-plugins-official',
    isPending: () => false,
    loadCatalog: vi.fn().mockResolvedValue(undefined),
    installPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
  }
})
vi.mock('../store/ui', () => ({ setShowPlugins: vi.fn(), addToast: vi.fn() }))

describe('PluginsPage', () => {
  test('renders all available plugins by default', async () => {
    const { findByText } = render(() => <PluginsPage />)
    expect(await findByText('asana')).toBeTruthy()
    expect(await findByText('amplitude')).toBeTruthy()
    expect(await findByText('foo')).toBeTruthy()
  })

  test('search filters by name', async () => {
    const { findByPlaceholderText, queryByText, findByText } = render(() => <PluginsPage />)
    const search = await findByPlaceholderText(/search/i)
    fireEvent.input(search, { target: { value: 'amp' } })
    await waitFor(() => {
      expect(queryByText('asana')).toBeNull()
      expect(queryByText('foo')).toBeNull()
    })
    expect(await findByText('amplitude')).toBeTruthy()
  })

  test('installed-only toggle hides un-installed', async () => {
    const { findByLabelText, queryByText, findByText } = render(() => <PluginsPage />)
    const toggle = await findByLabelText(/installed only/i)
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(queryByText('amplitude')).toBeNull()
      expect(queryByText('foo')).toBeNull()
    })
    expect(await findByText('asana')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify fail**

```bash
pnpm test src/components/PluginsPage.test.tsx
```

Expected: FAIL — search box / toggle don't exist yet.

- [ ] **Step 3: Replace PluginsPage with the full implementation**

Overwrite `src/components/PluginsPage.tsx`:

```tsx
import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { X, Search, RefreshCw } from 'lucide-solid'
import { catalog, marketplaces, isSupported, isLoading, isInstalled, loadCatalog } from '../store/plugins'
import { setShowPlugins } from '../store/ui'
import { PluginCard } from './PluginCard'
import { selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'

type SortKey = 'installs' | 'name'

export const PluginsPage: Component = () => {
  const [query, setQuery] = createSignal('')
  const [installedOnly, setInstalledOnly] = createSignal(false)
  const [marketplaceFilter, setMarketplaceFilter] = createSignal<Set<string>>(new Set())
  const [sortKey, setSortKey] = createSignal<SortKey>('installs')

  onMount(() => { void loadCatalog() })

  const cwd = createMemo(() => {
    const pid = selectedProjectId()
    if (pid) {
      const proj = projects.find(p => p.id === pid)
      if (proj) return proj.repoPath
    }
    // Fall back to home — claude reads/writes ~/.claude/settings.json regardless
    // when --scope user, which is the default.
    return '/'
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    const mpFilter = marketplaceFilter()
    const onlyInstalled = installedOnly()
    let list = catalog.available.filter(p => {
      if (onlyInstalled && !isInstalled(p.pluginId)) return false
      if (mpFilter.size > 0 && !mpFilter.has(p.marketplaceName)) return false
      if (q && !p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false
      return true
    })
    if (sortKey() === 'installs') {
      list = [...list].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    return list
  })

  const toggleMp = (name: string) => {
    setMarketplaceFilter(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div class="absolute inset-0 bg-bg z-20 flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b-1 border-b-solid border-b-white/8">
        <h1 class="text-lg font-medium">Plugins</h1>
        <div class="flex items-center gap-2">
          <button
            class="p-1 rounded hover:bg-white/5"
            onClick={() => loadCatalog()}
            title="Refresh"
            disabled={isLoading()}
          >
            <RefreshCw class={`w-4 h-4 ${isLoading() ? 'animate-spin' : ''}`} />
          </button>
          <button class="p-1 rounded hover:bg-white/5" onClick={() => setShowPlugins(false)} aria-label="Close">
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <Show when={isSupported() === false}>
        <div class="p-8 text-center text-sm text-fg/60">
          Update Claude Code to 2.0+ to use the plugin marketplace.
        </div>
      </Show>

      <Show when={isSupported() !== false}>
        <div class="px-4 py-3 flex items-center gap-3 flex-wrap border-b-1 border-b-solid border-b-white/8">
          <div class="relative flex-1 min-w-60">
            <Search class="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-fg/40" />
            <input
              type="text"
              placeholder="Search plugins…"
              class="w-full pl-8 pr-3 py-1.5 rounded ring-1 ring-white/10 bg-bg text-sm focus:ring-accent focus:outline-none"
              value={query()}
              onInput={e => setQuery(e.currentTarget.value)}
            />
          </div>
          <label class="flex items-center gap-1.5 text-sm text-fg/80">
            <input
              type="checkbox"
              checked={installedOnly()}
              onChange={e => setInstalledOnly(e.currentTarget.checked)}
              aria-label="Installed only"
            />
            Installed only
          </label>
          <select
            class="px-2 py-1.5 rounded ring-1 ring-white/10 bg-bg text-sm"
            value={sortKey()}
            onChange={e => setSortKey(e.currentTarget.value as SortKey)}
          >
            <option value="installs">Most installed</option>
            <option value="name">Name</option>
          </select>
        </div>

        <Show when={marketplaces.length > 1}>
          <div class="px-4 py-2 flex items-center gap-2 flex-wrap border-b-1 border-b-solid border-b-white/8">
            <span class="text-xs text-fg/50">Marketplaces:</span>
            <For each={marketplaces}>
              {mp => {
                const active = () => marketplaceFilter().has(mp.name)
                return (
                  <button
                    class={`px-2 py-0.5 rounded-full text-xs ring-1 ${active() ? 'ring-accent bg-accent/10 text-accent' : 'ring-white/10 hover:bg-white/5'}`}
                    onClick={() => toggleMp(mp.name)}
                  >
                    {mp.name}
                  </button>
                )
              }}
            </For>
          </div>
        </Show>

        <div class="flex-1 overflow-auto p-4">
          <Show when={!isLoading() && filtered().length === 0}>
            <p class="text-sm text-fg/60 text-center py-8">No plugins match your filters.</p>
          </Show>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            <For each={filtered()}>
              {p => <PluginCard plugin={p} cwd={cwd()} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify pass + typecheck**

```bash
pnpm test src/components/PluginsPage.test.tsx
pnpm check
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PluginsPage.tsx src/components/PluginsPage.test.tsx
git commit -m "feat(plugins): plugin browser with search, filter, and sort"
```

---

## Task 9: End-to-end manual verification

**Files:** none (no code changes — just verifying the user-visible feature works in dev)

- [ ] **Step 1: Run dev**

```bash
pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications
```

- [ ] **Step 2: Walk the golden path**

1. Click the Puzzle icon in the sidebar — Plugins page opens.
2. The grid loads ~170 cards within ~1s (the catalog fetch).
3. Type "amplitude" in the search box — only matching cards remain.
4. Toggle "Installed only" — see just your 3 already-installed plugins.
5. Click the marketplace pill `claude-plugins-official` — only that marketplace's plugins show.
6. Click Install on a small plugin you don't already have (e.g. `agent-sdk-dev`). Spinner appears, then a success toast. Card flips to Uninstall.
7. Click Uninstall on it. Spinner, toast, card flips back to Install.
8. Click Refresh — spinner runs, list re-renders.
9. Close the page with the X — back to the main view, no console errors.

- [ ] **Step 3: Walk one error path**

In a separate terminal: `mv ~/.local/bin/claude ~/.local/bin/claude.bak` (or rename whichever path `which claude` returns), then click Refresh in Verun. Expect: "Update Claude Code to 2.0+" empty state. Restore the binary.

- [ ] **Step 4: Run the full project check**

```bash
make check
```

Expected: zero errors, zero clippy warnings, no TS errors.

- [ ] **Step 5: Commit (no-op if no changes — this task is verification only)**

If you made any small tweaks during manual testing:

```bash
git add -p
git commit -m "fix(plugins): <whatever needed adjusting>"
```

---

## Task 10: Docs

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Append to CHANGELOG.md under `## Unreleased`**

```markdown
- Plugins page lists every plugin from configured Claude Code marketplaces, with search, marketplace filter, sort by install count, and one-click install/uninstall into user / project / local scope. Backed by a thin Rust wrapper around `claude plugin list/install/uninstall` so the CLI remains the source of truth for what's installed.
```

- [ ] **Step 2: Add a feature bullet to README.md**

Find the Features list and append:

```markdown
- **Plugin marketplace browser** - browse, search, and install Claude Code plugins from any configured marketplace without leaving Verun
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and readme entry for plugin marketplace"
```

---

## Self-Review Notes

**Spec coverage:**
- "List all plugins" → Tasks 2 + 8 (catalog fetch + grid render).
- "Filters" → Task 8 (marketplace pills, installed-only toggle).
- "Search" → Task 8 (name + description match).
- "Install with one click" → Task 7 (single button, default scope = user).
- Out-of-scope items are listed at the top of the plan and intentionally not assigned tasks.

**Naming consistency:**
- `pluginId` (string) is used identically in Rust types, TS types, IPC commands, store keys, and component props.
- `scope` is `'user' | 'project' | 'local'` everywhere — Rust accepts a `&str` and the TS type narrows it.

**Risk notes for the engineer:**
- `claude plugin install` may take up to ~30s on first install (git clone). The spinner in the card covers this; no timeout is set in our wrapper.
- `cwd` for installs falls back to `/` when no project is selected. That's fine for `--scope user` (writes to `~/.claude/settings.json`), but `--scope project` / `--scope local` from that fallback directory would write to `/.claude/settings.json` — investigate before exposing those scopes when no project is active. If unsure, gate project/local on `selectedProjectId() != null` in `PluginCard.tsx` step 3 of Task 7.
