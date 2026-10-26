use super::account_files::account_home_dir;
use super::{AccountHome, AccountProfile, Agent, AgentKind, InputMode, ModelOption, SessionArgs};
use crate::accounts::identity::{
    decode_jwt_payload, non_empty_str, read_json_with_retry, unknown_identity,
    unread_file_identity, AccountIdentity, SignInStatus,
};
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

/// Serialize a JSON value into a single newline-delimited JSON-RPC frame.
fn frame(v: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(v).map_err(|e| format!("serialize acp frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

/// Map an ACP `stop_reason` to Verun's turn-end status vocabulary.
fn stop_reason_to_status(sr: &str) -> &'static str {
    match sr {
        "cancelled" | "canceled" | "interrupted" => "interrupted",
        "refusal" | "error" | "max_tokens" | "max_turn_requests" => "error",
        _ => "completed",
    }
}

/// ACP reports cost as integer "usd ticks" where ticks = usd * 1e10.
fn ticks_to_usd(ticks: i64) -> f64 {
    ticks as f64 / 1e10
}

/// Render an ACP `{oldText,newText}` file change as a git-style unified diff
/// string for display. Trims common leading/trailing lines so edits show only
/// the changed region; a brand-new file (empty `old`) yields `+` lines only.
fn render_unified_diff(path: &str, old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut start = 0;
    while start < old_lines.len()
        && start < new_lines.len()
        && old_lines[start] == new_lines[start]
    {
        start += 1;
    }
    let (mut eo, mut en) = (old_lines.len(), new_lines.len());
    while eo > start && en > start && old_lines[eo - 1] == new_lines[en - 1] {
        eo -= 1;
        en -= 1;
    }
    let mut s = format!("--- a/{path}\n+++ b/{path}\n");
    for line in &old_lines[start..eo] {
        s.push('-');
        s.push_str(line);
        s.push('\n');
    }
    for line in &new_lines[start..en] {
        s.push('+');
        s.push_str(line);
        s.push('\n');
    }
    s
}

/// xAI Grok CLI - agentic coding CLI.
///
/// Transport: `grok agent stdio` speaks ACP (Agent Client Protocol),
/// newline-delimited JSON-RPC 2.0 over stdio. One process persists across
/// turns; each turn is a `session/prompt` request. Grok does its own file
/// I/O (we advertise no client `fs` capability), surfaces tool calls, diffs,
/// and interactive permission requests.
///
/// Binary: `grok`
/// Transport: `grok agent stdio` (ACP / JSON-RPC 2.0, NDJSON on stdio)
/// Docs: https://x.ai/cli
pub struct Grok;

impl Agent for Grok {
    fn kind(&self) -> AgentKind {
        AgentKind::Grok
    }
    fn display_name(&self) -> &'static str {
        "Grok"
    }
    fn cli_binary(&self) -> &'static str {
        "grok"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::JsonRpcStdio
    }

    fn install_hint(&self) -> &'static str {
        "curl -fsSL https://x.ai/cli/install.sh | bash"
    }
    fn update_hint(&self) -> &'static str {
        "grok update"
    }
    fn docs_url(&self) -> &'static str {
        "https://x.ai/cli"
    }

    /// Static fallback, used when `grok models` is unavailable (e.g. not
    /// logged in). First entry is the default.
    fn available_models(&self) -> Vec<ModelOption> {
        vec![
            ModelOption::new("grok-4.6", "Grok 4.6", "xAI frontier coding model"),
            ModelOption::new("grok-4.5", "Grok 4.5", "Previous Grok model"),
        ]
    }

    fn model_list_args(&self) -> Option<Vec<String>> {
        Some(vec!["models".into()])
    }

    /// Parse `grok models`. Lines look like `  * grok-4.6 (default)` for the
    /// default and `  - grok-4.5` for the rest; the default is moved first
    /// since Verun treats index 0 as the default.
    fn parse_model_list(&self, output: &str) -> Vec<ModelOption> {
        let mut default: Option<ModelOption> = None;
        let mut rest = Vec::new();
        for line in output.lines() {
            let t = line.trim();
            let (is_default, body) = match t.strip_prefix('*') {
                Some(b) => (true, b),
                None => match t.strip_prefix('-') {
                    Some(b) => (false, b),
                    None => continue,
                },
            };
            let Some(id) = body.split_whitespace().next() else {
                continue;
            };
            let opt = ModelOption::new(id, id, "");
            if is_default {
                default = Some(opt);
            } else {
                rest.push(opt);
            }
        }
        let mut out = Vec::new();
        out.extend(default);
        out.extend(rest);
        out
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["agent".into(), "stdio".into()]
    }

    fn uses_rpc(&self) -> bool {
        true
    }
    fn persists_across_turns(&self) -> bool {
        true
    }
    fn abort_strategy(&self) -> super::AbortStrategy {
        super::AbortStrategy::Interrupt
    }

    fn supports_resume(&self) -> bool {
        true
    }
    fn defers_resume_id_until_turn_end(&self) -> bool {
        false
    }
    fn supports_effort(&self) -> bool {
        false
    }
    fn supports_attachments(&self) -> bool {
        false
    }
    fn supports_plan_mode(&self) -> bool {
        false
    }
    fn supports_skills(&self) -> bool {
        false
    }
    fn supports_fork(&self) -> bool {
        false
    }

    // ── ACP RPC seam ────────────────────────────────────────────────────

    fn rpc_encode_initialize(
        &self,
        req_id: i64,
        ci: &super::RpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // Advertise NO `fs` client capability: Grok then does its own file
        // I/O rather than routing reads/writes back through us.
        frame(&json!({
            "id": req_id,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientInfo": { "name": ci.name, "version": ci.version },
                "clientCapabilities": {}
            }
        }))
    }

    fn rpc_encode_start(&self, req_id: i64, p: &super::RpcStartParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/new",
            "params": { "cwd": p.cwd, "mcpServers": [] }
        }))
    }

    fn rpc_encode_resume(&self, req_id: i64, p: &super::RpcResumeParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/load",
            "params": { "sessionId": p.session_id, "cwd": p.cwd, "mcpServers": [] }
        }))
    }

    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
        frame(&json!({
            "id": req_id,
            "method": "session/prompt",
            "params": {
                "sessionId": p.session_id,
                "prompt": [{ "type": "text", "text": p.prompt }]
            }
        }))
    }

    fn rpc_encode_interrupt(
        &self,
        req_id: i64,
        session_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // ACP cancels by session id; no per-turn id needed.
        frame(&json!({
            "id": req_id,
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }))
        .map(Some)
    }

    fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
        let m = message.to_lowercase();
        m.contains("session")
            && (m.contains("not found")
                || m.contains("does not exist")
                || m.contains("unknown")
                || m.contains("no such"))
    }

    fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
        use crate::stream::OutputItem;
        if method != "session/update" {
            return vec![];
        }
        let Some(u) = params.get("update") else {
            return vec![];
        };
        match u.get("sessionUpdate").and_then(|s| s.as_str()).unwrap_or("") {
            "agent_thought_chunk" => u
                .pointer("/content/text")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .map(|t| vec![OutputItem::Thinking { text: t.to_string() }])
                .unwrap_or_default(),
            "agent_message_chunk" => u
                .pointer("/content/text")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .map(|t| vec![OutputItem::Text { text: t.to_string() }])
                .unwrap_or_default(),
            "tool_call" => {
                let tool = u
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = u
                    .get("rawInput")
                    .map(|a| serde_json::to_string_pretty(a).unwrap_or_default())
                    .unwrap_or_default();
                vec![OutputItem::ToolStart { tool, input }]
            }
            "tool_call_update" => {
                let status = u.get("status").and_then(|s| s.as_str()).unwrap_or("");
                // Only surface a result once the call resolves. Diffs and
                // command output both land on the same tool card started by
                // the earlier `tool_call` event.
                if status != "completed" && status != "failed" {
                    return vec![];
                }
                let is_error = status == "failed";
                let mut out = Vec::new();
                if let Some(items) = u.get("content").and_then(|c| c.as_array()) {
                    for it in items {
                        match it.get("type").and_then(|t| t.as_str()) {
                            Some("diff") => {
                                let path = it.get("path").and_then(|p| p.as_str()).unwrap_or("");
                                let old = it.get("oldText").and_then(|t| t.as_str()).unwrap_or("");
                                let new = it.get("newText").and_then(|t| t.as_str()).unwrap_or("");
                                out.push(OutputItem::ToolResult {
                                    text: render_unified_diff(path, old, new),
                                    is_error,
                                });
                            }
                            Some("content") => {
                                let text = it
                                    .pointer("/content/text")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                out.push(OutputItem::ToolResult { text, is_error });
                            }
                            _ => {}
                        }
                    }
                }
                out
            }
            "turn_completed" => {
                let status =
                    stop_reason_to_status(u.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("end_turn"));
                let usage = u.get("usage");
                let read = |key: &str| {
                    usage
                        .and_then(|g| g.get(key))
                        .and_then(|v| v.as_u64())
                };
                let cost = usage
                    .and_then(|g| g.get("costUsdTicks"))
                    .and_then(|v| v.as_i64())
                    .map(ticks_to_usd)
                    .filter(|c| *c > 0.0);
                vec![OutputItem::TurnEnd {
                    status: status.to_string(),
                    cost,
                    input_tokens: read("inputTokens"),
                    output_tokens: read("outputTokens"),
                    cache_read_tokens: read("cachedReadTokens"),
                    cache_write_tokens: None,
                    error: None,
                }]
            }
            _ => vec![],
        }
    }

    fn rpc_is_approval(&self, method: &str) -> bool {
        method == "session/request_permission"
    }

    fn rpc_build_approval_entry(
        &self,
        session_id: &str,
        request_id: &str,
        _method: &str,
        params: &Value,
    ) -> crate::task::PendingApprovalEntry {
        let tc = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let kind = tc.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let tool_name = match kind {
            "edit" => "Edit",
            "execute" => "Bash",
            "read" => "Read",
            _ => tc.get("title").and_then(|t| t.as_str()).unwrap_or("Tool"),
        }
        .to_string();
        // Stash the ACP option list so the responder can map an allow/deny
        // decision back to a concrete `optionId`.
        let tool_input = json!({
            "toolCall": tc,
            "_grokOptions": params.get("options").cloned().unwrap_or(json!([])),
        });
        crate::task::PendingApprovalEntry {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            tool_name,
            tool_input,
            prompt: None,
        }
    }

    fn rpc_encode_approval_response(
        &self,
        _method: &str,
        server_req_id: &Value,
        response: &crate::task::ApprovalResponse,
        entry_input: &Value,
    ) -> Option<Result<Vec<u8>, String>> {
        let allow = response.behavior == "allow";
        let options = entry_input.get("_grokOptions").and_then(|o| o.as_array())?;
        let want_prefix = if allow { "allow" } else { "reject" };
        // Prefer the *_once option matching the behavior; else any option whose
        // kind starts with the desired prefix.
        let once = format!("{want_prefix}_once");
        let pick = options
            .iter()
            .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some(once.as_str()))
            .or_else(|| {
                options.iter().find(|o| {
                    o.get("kind")
                        .and_then(|k| k.as_str())
                        .map(|k| k.starts_with(want_prefix))
                        .unwrap_or(false)
                })
            });
        let option_id = pick.and_then(|o| o.get("optionId")).cloned().unwrap_or(Value::Null);
        Some(frame(&json!({
            "id": server_req_id,
            "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
        })))
    }

    // ── Accounts ───────────────────────────────────────────────────────
    //
    // prepare_account_dir is the default (make the dir): Grok makes the rest of
    // its home itself and keeps every login in auth.json, with no keychain
    // entry, so there is nothing to seed.

    fn account_profile(&self) -> Option<AccountProfile> {
        Some(AccountProfile {
            // Everything that can point Grok at another home or login file, or
            // sign it in some other way than the account's own login. An
            // account that needs one sets it in its own env.
            scrub_vars: &[GROK_HOME_VAR, "GROK_AUTH", "GROK_AUTH_PATH", "XAI_API_KEY"],
            // Grok downloads its updates into its home, so an account's home
            // would grow a copy of the ~140MB binary of its own. Updating is
            // for the install the user runs.
            fixed_env: &[("GROK_DISABLE_AUTOUPDATER", "1")],
            // The fallback when the home holds no login (a stored login wins).
            // `grok agent stdio`, which Verun spawns, uses it without being
            // asked to authenticate (checked against Grok Build 1.0.34).
            api_key_vars: &["XAI_API_KEY"],
            // `--oauth` is the default flow; it is passed so the login does not
            // depend on that.
            login_args: Some(&["login", "--oauth"]),
            logout_args: Some(&["logout"]),
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
            GROK_HOME_VAR.to_string(),
            dir.to_string_lossy().into_owned(),
        )]
    }

    fn account_standard_home(&self, user_home: &Path) -> Option<PathBuf> {
        // Where Grok's home is when `GROK_HOME` is not set, whatever Verun
        // inherited.
        Some(standard_home(user_home))
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        grok_identity(home, std::env::var_os(GROK_HOME_VAR))
    }

    /// Runs on the process `PATH`, which `detect_all_agents` reloads from the
    /// user's shell first. Blocks on file I/O, like the agent detection that
    /// asks.
    fn account_blocked_reason(&self) -> Option<String> {
        npm_launcher_reason(&std::env::var_os("PATH")?)
    }
}

/// The env var that moves all of Grok's state: config, sessions and the signed-in
/// account. Grok uses its value as it is (no `~` expansion), and an empty value
/// counts as unset.
const GROK_HOME_VAR: &str = "GROK_HOME";

/// The start of the scope of a sign-in with an xAI account in `auth.json`, which
/// is `<issuer>::<client id>`.
const XAI_LOGIN_SCOPE_PREFIX: &str = "https://auth.x.ai::";

/// The scope of a plain API key that Grok stored in `auth.json`.
const API_KEY_SCOPE: &str = "xai::api_key";

/// Grok's home when `GROK_HOME` is not set.
fn standard_home(user_home: &Path) -> PathBuf {
    user_home.join(".grok")
}

/// Who `grok` is signed in as at `home`. `auth.json` is a JSON object with an
/// entry per login, keyed by scope, and logout removes the entry (and the file
/// with the last one). A sign-in with an xAI account is the entry whose scope
/// starts with `https://auth.x.ai::`: it counts only with a `refresh_token`, and
/// gives the `email`. The plan is the numeric `tier` claim of its `key`, a JWT.
/// Without such a login, an `xai::api_key` entry that holds a key is an API key
/// login, and otherwise nobody is signed in. A home without the file has nobody
/// signed in. A file that is there but cannot be read, or is not shaped the way
/// Grok writes it, says nothing either way, so it is `Unknown` rather than a
/// guess at "signed out". Tokens and keys are only checked for being there; the
/// claims of the JWT are what say the plan.
///
/// Grok takes its home to be the dir of an added account, or for Default the
/// `GROK_HOME` Verun inherited, else `~/.grok`: Default sessions keep Verun's
/// own env, so a `GROK_HOME` exported where Verun was launched is the Default
/// home. An empty value counts as unset. So does a non-UTF-8 one, which Grok
/// itself would use as it is, but no such home can exist on macOS.
///
/// `inherited_grok_home` is the `GROK_HOME` Verun itself was started with,
/// passed in so tests need not touch the process env.
fn grok_identity(home: AccountHome<'_>, inherited_grok_home: Option<OsString>) -> AccountIdentity {
    let path = account_home_dir(home, inherited_grok_home, standard_home).join("auth.json");
    let Some(auth) = read_json_with_retry(&path) else {
        return unread_file_identity(&path);
    };
    let Some(entries) = auth.as_object() else {
        return unknown_identity(&path, "is not a JSON object");
    };
    let login = entries
        .iter()
        .filter(|(scope, _)| scope.starts_with(XAI_LOGIN_SCOPE_PREFIX))
        .map(|(_, entry)| entry)
        .find(|entry| non_empty_str(entry, "refresh_token").is_some());
    if let Some(login) = login {
        return AccountIdentity {
            status: SignInStatus::SignedIn,
            email: non_empty_str(login, "email"),
            plan: login_plan(login),
            ..AccountIdentity::default()
        };
    }
    let has_key = entries
        .get(API_KEY_SCOPE)
        .is_some_and(|entry| non_empty_str(entry, "key").is_some());
    AccountIdentity::with_status(if has_key {
        SignInStatus::ApiKey
    } else {
        SignInStatus::SignedOut
    })
}

/// The plan of the login entry `login`, named by the `tier` claim of its `key`.
fn login_plan(login: &Value) -> Option<String> {
    let claims = decode_jwt_payload(&non_empty_str(login, "key")?)?;
    tier_name(claims.get("tier")?.as_u64()?).map(str::to_string)
}

/// The name of a subscription tier, as Grok numbers them in the `tier` claim.
/// A number it does not list has no name.
fn tier_name(tier: u64) -> Option<&'static str> {
    Some(match tier {
        0 => "Free",
        1 => "SuperGrok",
        2 => "X Basic",
        3 => "X Premium",
        4 => "X Premium+",
        5 => "SuperGrok Heavy",
        6 => "SuperGrok Lite",
        7 => "SuperGrok Plus",
        _ => return None,
    })
}

/// Why added accounts cannot work with the `grok` that `path_var` (in the format
/// of `$PATH`) finds first, or `None` when nothing is in the way: that `grok` is
/// the launcher npm installs, which unpacks the ~140MB binary into the home it
/// runs with, so every account would get a copy of its own. The native install
/// has no such step.
fn npm_launcher_reason(path_var: &OsStr) -> Option<String> {
    let resolved = find_on_path(Grok.cli_binary(), path_var)?
        .canonicalize()
        .ok()?;
    is_npm_launcher(&resolved).then(|| {
        format!(
            "Grok was installed through npm. Added accounts need the native install: {}",
            Grok.install_hint()
        )
    })
}

/// The file that running `bin` would start: the first dir of `path_var` that has
/// a file of that name which can be run. A dir that is not there, a folder of
/// that name and a file without the execute bit are passed over, as when a shell
/// looks. An empty entry is passed over too, since it stands for the working
/// dir, which is anyone's guess.
fn find_on_path(bin: &str, path_var: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(bin))
        .find(|candidate| can_run(candidate))
}

/// Whether `path` is a file, or a link to one, that may be executed.
fn can_run(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

/// Whether `resolved`, a path with its links resolved, is inside a
/// `node_modules` folder: where npm puts the Grok launcher, whichever package
/// manager and layout (global prefix, pnpm store, bun) put it there.
fn is_npm_launcher(resolved: &Path) -> bool {
    resolved
        .components()
        .any(|part| matches!(part, Component::Normal(name) if name == "node_modules"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::identity::jwt;
    use std::fs;
    use tempfile::TempDir;

    // ── Accounts ────────────────────────────────────────────────────────

    #[test]
    fn grok_profile_values() {
        assert_eq!(
            Grok.account_profile(),
            Some(AccountProfile {
                scrub_vars: &["GROK_HOME", "GROK_AUTH", "GROK_AUTH_PATH", "XAI_API_KEY"],
                fixed_env: &[("GROK_DISABLE_AUTOUPDATER", "1")],
                api_key_vars: &["XAI_API_KEY"],
                login_args: Some(&["login", "--oauth"]),
                logout_args: Some(&["logout"]),
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
    fn grok_home_env_sets_grok_home_verbatim() {
        for dir in [
            "/x/Client Accounts/acme",
            "/x/Client Accounts/acme/",
            "/x/./acme/../acme",
            "/x/o'brien-é",
        ] {
            assert_eq!(
                Grok.account_home_env(Path::new(dir)),
                vec![("GROK_HOME".to_string(), dir.to_string())],
                "dir: {dir}"
            );
        }
    }

    #[test]
    fn grok_standard_home_is_dot_grok() {
        assert_eq!(
            Grok.account_standard_home(Path::new("/Users/me")),
            Some(PathBuf::from("/Users/me/.grok"))
        );
    }

    #[test]
    fn grok_prepare_dir_makes_the_whole_path_and_seeds_nothing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("accounts").join("g1");
        Grok.prepare_account_dir(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    const LOGIN_SCOPE: &str = "https://auth.x.ai::client-1";

    /// The `auth.json` entry that `grok login --oauth` writes.
    fn login_entry(key: &str) -> Value {
        json!({
            "key": key,
            "auth_mode": "oidc",
            "create_time": "2026-10-25T10:00:00Z",
            "user_id": "user-1",
            "email": "dev@acme.com",
            "refresh_token": "refresh",
            "expires_at": "2026-10-25T20:00:00Z",
            "oidc_issuer": "https://auth.x.ai",
            "oidc_client_id": "client-1",
        })
    }

    fn tier_token(tier: Value) -> String {
        jwt(&json!({"sub": "user-1", "tier": tier}).to_string())
    }

    fn api_key_entry(key: &str) -> Value {
        json!({"key": key, "auth_mode": "api_key", "create_time": "2026-10-25T10:00:00Z", "user_id": ""})
    }

    fn write_auth(dir: &Path, auth: &Value) {
        write_auth_text(dir, &auth.to_string());
    }

    fn write_auth_text(dir: &Path, text: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("auth.json"), text).unwrap();
    }

    fn identity_at(dir: &Path) -> AccountIdentity {
        Grok.read_account_identity(AccountHome::Dir(dir))
    }

    fn only_status(status: SignInStatus) -> AccountIdentity {
        AccountIdentity::with_status(status)
    }

    #[test]
    fn grok_identity_reads_oidc_entry_and_tier() {
        let dir = TempDir::new().unwrap();
        write_auth(
            dir.path(),
            &json!({ LOGIN_SCOPE: login_entry(&tier_token(json!(5))) }),
        );
        assert_eq!(
            identity_at(dir.path()),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                email: Some("dev@acme.com".into()),
                plan: Some("SuperGrok Heavy".into()),
                ..AccountIdentity::default()
            }
        );
    }

    #[test]
    fn grok_identity_names_the_tiers() {
        for (tier, name) in [
            (0, "Free"),
            (1, "SuperGrok"),
            (2, "X Basic"),
            (3, "X Premium"),
            (4, "X Premium+"),
            (5, "SuperGrok Heavy"),
            (6, "SuperGrok Lite"),
            (7, "SuperGrok Plus"),
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(
                dir.path(),
                &json!({ LOGIN_SCOPE: login_entry(&tier_token(json!(tier))) }),
            );
            assert_eq!(
                identity_at(dir.path()).plan.as_deref(),
                Some(name),
                "tier {tier}"
            );
        }
    }

    #[test]
    fn grok_identity_signed_in_without_a_readable_tier_has_no_plan() {
        let no_tier = jwt(r#"{"sub":"user-1"}"#);
        for key in [
            tier_token(json!(8)),
            tier_token(json!("5")),
            tier_token(json!(-1)),
            tier_token(json!(null)),
            no_tier,
            "not-a-jwt".to_string(),
            String::new(),
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), &json!({ LOGIN_SCOPE: login_entry(&key) }));
            let identity = identity_at(dir.path());
            assert_eq!(identity.status, SignInStatus::SignedIn);
            assert_eq!(identity.email.as_deref(), Some("dev@acme.com"));
            assert_eq!(identity.plan, None, "key: {key}");
        }
    }

    #[test]
    fn grok_identity_api_key_and_signed_out() {
        let dir = TempDir::new().unwrap();
        write_auth(
            dir.path(),
            &json!({ "xai::api_key": api_key_entry("xai-key") }),
        );
        assert_eq!(identity_at(dir.path()), only_status(SignInStatus::ApiKey));

        for auth in [
            json!({}),
            // A key entry with no key in it is no login.
            json!({ "xai::api_key": api_key_entry("") }),
            json!({ "xai::api_key": {} }),
            // Logins that Verun does not read as an xAI account.
            json!({ "https://accounts.x.ai/sign-in": login_entry("k") }),
            json!({ "https://idp.acme.example::client-1": login_entry("k") }),
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), &auth);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedOut),
                "file: {auth}"
            );
        }
    }

    #[test]
    fn grok_identity_login_without_a_refresh_token_is_not_signed_in() {
        for refresh in [json!(null), json!(""), json!(5)] {
            let mut entry = login_entry("k");
            entry["refresh_token"] = refresh.clone();
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), &json!({ LOGIN_SCOPE: entry.clone() }));
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedOut),
                "refresh_token: {refresh}"
            );
            // Then a stored key is what the account has.
            write_auth(
                dir.path(),
                &json!({ LOGIN_SCOPE: entry, "xai::api_key": api_key_entry("xai-key") }),
            );
            assert_eq!(identity_at(dir.path()), only_status(SignInStatus::ApiKey));
        }
        let mut entry = login_entry("k");
        entry.as_object_mut().unwrap().remove("refresh_token");
        let dir = TempDir::new().unwrap();
        write_auth(dir.path(), &json!({ LOGIN_SCOPE: entry }));
        assert_eq!(
            identity_at(dir.path()),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn grok_identity_login_wins_over_a_stored_key() {
        let dir = TempDir::new().unwrap();
        write_auth(
            dir.path(),
            &json!({
                "xai::api_key": api_key_entry("xai-key"),
                LOGIN_SCOPE: login_entry(&tier_token(json!(1))),
            }),
        );
        let identity = identity_at(dir.path());
        assert_eq!(identity.status, SignInStatus::SignedIn);
        assert_eq!(identity.plan.as_deref(), Some("SuperGrok"));
    }

    #[test]
    fn grok_identity_missing_is_signed_out() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            identity_at(dir.path()),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn grok_identity_unknown_when_the_file_cannot_be_read() {
        let unknown = only_status(SignInStatus::Unknown);
        for text in ["not json", "", r#"{"xai::api_key":"#] {
            let dir = TempDir::new().unwrap();
            write_auth_text(dir.path(), text);
            assert_eq!(identity_at(dir.path()), unknown, "file: {text:?}");
        }
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("auth.json")).unwrap();
        assert_eq!(identity_at(dir.path()), unknown);
    }

    #[test]
    fn grok_identity_unknown_for_an_unexpected_shape() {
        for text in ["[]", r#""dev@acme.com""#, "42", "null"] {
            let dir = TempDir::new().unwrap();
            write_auth_text(dir.path(), text);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::Unknown),
                "file: {text}"
            );
        }
    }

    fn default_email(
        user_home: &Path,
        inherited: Option<OsString>,
    ) -> (SignInStatus, Option<String>) {
        let identity = grok_identity(AccountHome::Default { user_home }, inherited);
        (identity.status, identity.email)
    }

    #[test]
    fn grok_identity_default_reads_dot_grok_in_the_users_home() {
        let home = TempDir::new().unwrap();
        write_auth(
            &home.path().join(".grok"),
            &json!({ LOGIN_SCOPE: login_entry("k") }),
        );
        // An auth.json in the home folder itself is not Grok's.
        write_auth(home.path(), &json!({}));
        assert_eq!(
            default_email(home.path(), None),
            (SignInStatus::SignedIn, Some("dev@acme.com".into()))
        );
    }

    #[test]
    fn grok_identity_default_without_a_login_is_signed_out() {
        let home = TempDir::new().unwrap();
        assert_eq!(default_email(home.path(), None).0, SignInStatus::SignedOut);
    }

    #[test]
    fn grok_identity_default_follows_the_inherited_grok_home() {
        let home = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_auth(
            &home.path().join(".grok"),
            &json!({ LOGIN_SCOPE: login_entry("k") }),
        );
        let mut other = login_entry("k");
        other["email"] = json!("inherited@x.dev");
        write_auth(inherited.path(), &json!({ LOGIN_SCOPE: other }));

        assert_eq!(
            default_email(home.path(), Some(inherited.path().into()))
                .1
                .as_deref(),
            Some("inherited@x.dev")
        );
        // An empty value counts as unset, as Grok reads it.
        for unset in [Some(OsString::new()), None] {
            assert_eq!(
                default_email(home.path(), unset).1.as_deref(),
                Some("dev@acme.com")
            );
        }
    }

    #[test]
    fn grok_identity_of_an_added_dir_ignores_the_inherited_grok_home() {
        let dir = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_auth(dir.path(), &json!({ LOGIN_SCOPE: login_entry("k") }));
        write_auth(inherited.path(), &json!({}));

        let identity = grok_identity(AccountHome::Dir(dir.path()), Some(inherited.path().into()));

        assert_eq!(identity.status, SignInStatus::SignedIn);
    }

    // ── Blocked by an npm install ───────────────────────────────────────

    #[test]
    fn is_npm_launcher_detects_node_modules() {
        for path in [
            "/Users/me/.nvm/versions/node/v24.20.0/lib/node_modules/@xai-official/grok/bin/grok",
            "/opt/homebrew/lib/node_modules/@xai-official/grok/bin/grok",
            "/Users/me/Library/pnpm/global/5/node_modules/.pnpm/@xai-official+grok@1.0.34/node_modules/@xai-official/grok/bin/grok",
            "/Users/me/.bun/install/global/node_modules/@xai-official/grok/bin/grok",
        ] {
            assert!(is_npm_launcher(Path::new(path)), "{path}");
        }
        for path in [
            "/Users/me/.grok/bin/grok-1.0.34",
            "/opt/homebrew/bin/grok",
            "/Users/me/node_modules_old/grok",
            "/Users/me/my-node_modules/grok",
        ] {
            assert!(!is_npm_launcher(Path::new(path)), "{path}");
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn path_of(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_searches_dirs_in_order() {
        let (first, second, empty) = (
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
        );
        write_executable(&first.path().join("grok"));
        write_executable(&second.path().join("grok"));

        let path = path_of(&[empty.path(), first.path(), second.path()]);
        assert_eq!(find_on_path("grok", &path), Some(first.path().join("grok")));
        let path = path_of(&[second.path(), first.path()]);
        assert_eq!(
            find_on_path("grok", &path),
            Some(second.path().join("grok"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_skips_what_cannot_be_run() {
        use std::os::unix::fs::PermissionsExt;
        let (plain, folder, good) = (
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
            TempDir::new().unwrap(),
        );
        fs::write(plain.path().join("grok"), "").unwrap();
        fs::set_permissions(plain.path().join("grok"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::create_dir(folder.path().join("grok")).unwrap();
        write_executable(&good.path().join("grok"));
        let missing = good.path().join("nope");

        let path = path_of(&[&missing, plain.path(), folder.path(), good.path()]);
        assert_eq!(find_on_path("grok", &path), Some(good.path().join("grok")));
        assert_eq!(find_on_path("other", &path), None);
        assert_eq!(find_on_path("grok", OsStr::new("")), None);
        assert_eq!(
            find_on_path("grok", &path_of(&[plain.path(), folder.path()])),
            None
        );
    }

    /// The layouts of an npm install (`bin/grok` links into `node_modules`) and
    /// of the native one (`~/.local/bin/grok` -> `~/.grok/bin/grok` -> binary).
    /// Returns the `bin` dirs of the two.
    #[cfg(unix)]
    fn both_installs(root: &Path) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::symlink;
        let launcher = root.join("npm/lib/node_modules/@xai-official/grok/bin/grok");
        write_executable(&launcher);
        fs::create_dir_all(root.join("npm/bin")).unwrap();
        symlink(
            "../lib/node_modules/@xai-official/grok/bin/grok",
            root.join("npm/bin/grok"),
        )
        .unwrap();

        write_executable(&root.join("home/.grok/bin/grok-1.0.34"));
        symlink("grok-1.0.34", root.join("home/.grok/bin/grok")).unwrap();
        fs::create_dir_all(root.join("home/.local/bin")).unwrap();
        symlink(
            root.join("home/.grok/bin/grok"),
            root.join("home/.local/bin/grok"),
        )
        .unwrap();
        (root.join("npm/bin"), root.join("home/.local/bin"))
    }

    #[cfg(unix)]
    #[test]
    fn blocked_reason_names_the_npm_launcher_the_path_finds_first() {
        let root = TempDir::new().unwrap();
        let (npm, native) = both_installs(root.path());

        assert_eq!(
            npm_launcher_reason(&path_of(&[&npm, &native])).as_deref(),
            Some("Grok was installed through npm. Added accounts need the native install: curl -fsSL https://x.ai/cli/install.sh | bash")
        );
        // Only the first `grok` is the one that runs.
        assert_eq!(npm_launcher_reason(&path_of(&[&native, &npm])), None);
        assert_eq!(npm_launcher_reason(&path_of(&[&native])), None);
    }

    #[cfg(unix)]
    #[test]
    fn blocked_reason_is_none_without_a_grok_on_the_path() {
        let root = TempDir::new().unwrap();
        assert_eq!(npm_launcher_reason(&path_of(&[root.path()])), None);
        assert_eq!(npm_launcher_reason(OsStr::new("")), None);
    }
}
