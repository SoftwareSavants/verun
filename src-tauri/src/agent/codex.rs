use super::account_files::account_home_dir;
use super::codex_developer_instructions::{
    CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
};
use super::{
    AccountHome, AccountProfile, Agent, AgentKind, CodexRpcDecision, CodexRpcItemDecision,
    CodexRpcPermissionsDecision, InputMode, SessionArgs,
};
use crate::accounts::identity::{
    decode_jwt_payload, non_empty_str, read_json_with_retry, unknown_identity,
    unread_file_identity, AccountIdentity, SignInStatus,
};
use crate::policy::TrustLevel;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The env var that moves all of Codex's state: config, sessions and the
/// signed-in account. Codex takes its value literally and exits when the dir
/// does not exist.
const CODEX_HOME_VAR: &str = "CODEX_HOME";

/// What Verun puts in the `config.toml` of a home it makes. Codex keeps the
/// OAuth tokens of MCP servers in one keychain entry that every home shares,
/// unless it is told to use a file in the home, so without this two accounts
/// would be signed in to the same MCP servers.
const MANAGED_HOME_CONFIG: &str = "mcp_oauth_credentials_store = \"file\"\n";

/// OpenAI Codex CLI - open-source coding agent.
///
/// Transport: `codex app-server` speaks newline-delimited JSON-RPC 2.0 over
/// stdio. One CLI process persists across turns; each user turn is a
/// `turn/start` request on the same stdin. Plan mode is a `turn/start`
/// parameter (`collaborationMode.mode = "plan"`), not a CLI flag.
///
/// Binary: `codex`
/// Transport: `codex app-server` (JSON-RPC 2.0, NDJSON on stdio)
/// Docs: https://github.com/openai/codex
pub struct Codex;

fn trust_level_to_approval_policy(trust: TrustLevel) -> &'static str {
    match trust {
        TrustLevel::Supervised => "untrusted",
        TrustLevel::Normal => "on-request",
        TrustLevel::FullAuto => "never",
    }
}

fn trust_level_to_thread_sandbox(trust: TrustLevel) -> &'static str {
    match trust {
        TrustLevel::Supervised => "read-only",
        TrustLevel::Normal => "workspace-write",
        TrustLevel::FullAuto => "danger-full-access",
    }
}

fn trust_level_to_turn_sandbox_policy(trust: TrustLevel) -> Value {
    match trust {
        TrustLevel::Supervised => json!({ "type": "readOnly" }),
        TrustLevel::Normal => json!({ "type": "workspaceWrite" }),
        TrustLevel::FullAuto => json!({ "type": "dangerFullAccess" }),
    }
}

fn encode_rpc_frame(message: &Value) -> Result<Vec<u8>, String> {
    let mut buf = serde_json::to_vec(message).map_err(|e| format!("serialize rpc frame: {e}"))?;
    buf.push(b'\n');
    Ok(buf)
}

impl Agent for Codex {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn display_name(&self) -> &'static str {
        "Codex"
    }
    fn cli_binary(&self) -> &'static str {
        "codex"
    }
    fn input_mode(&self) -> InputMode {
        InputMode::JsonRpcStdio
    }

    fn install_hint(&self) -> &'static str {
        "npm i -g @openai/codex"
    }

    fn docs_url(&self) -> &'static str {
        "https://github.com/openai/codex#installation"
    }

    fn available_models(&self) -> Vec<crate::agent::ModelOption> {
        use crate::agent::ModelOption;
        vec![
            ModelOption::new(
                "gpt-6-astra",
                "GPT-6 Astra",
                "Most capable for complex code, apps, and research",
            ),
            ModelOption::new(
                "gpt-6.1-sol",
                "GPT-6.1 Sol",
                "Latest workhorse model for coding and everyday work",
            ),
            ModelOption::new(
                "gpt-5.6-sol",
                "GPT-5.6 Sol",
                "Most capable GPT-5.6 for complex coding and research",
            ),
            ModelOption::new(
                "gpt-5.6-terra",
                "GPT-5.6 Terra",
                "Balanced everyday model at lower cost",
            ),
            ModelOption::new(
                "gpt-5.6-luna",
                "GPT-5.6 Luna",
                "Fast and affordable",
            ),
            ModelOption::new(
                "gpt-5.5",
                "GPT-5.5",
                "Previous-generation flagship (retires Oct 2026)",
            ),
        ]
    }

    fn build_session_args(&self, _args: &SessionArgs<'_>) -> Vec<String> {
        vec!["app-server".into()]
    }

    fn persists_across_turns(&self) -> bool {
        true
    }
    fn abort_strategy(&self) -> super::AbortStrategy {
        super::AbortStrategy::Interrupt
    }

    fn supports_attachments(&self) -> bool {
        true
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
    fn supports_fork(&self) -> bool {
        true
    }

    fn extract_resume_id(&self, v: &serde_json::Value) -> Option<String> {
        // Legacy `codex exec --json` line shape — kept so historical
        // transcripts still round-trip through `extract_resume_id`.
        if v.get("type").and_then(|t| t.as_str()) == Some("thread.started") {
            if let Some(id) = v.get("thread_id").and_then(|s| s.as_str()) {
                return Some(id.to_string());
            }
        }
        // JSON-RPC `thread/started` notification shape:
        //   { "method": "thread/started", "params": { "thread": { "id": "..." } } }
        if v.get("method").and_then(|m| m.as_str()) == Some("thread/started") {
            if let Some(id) = v.pointer("/params/thread/id").and_then(|s| s.as_str()) {
                return Some(id.to_string());
            }
        }
        None
    }

    fn defers_resume_id_until_turn_end(&self) -> bool {
        // `thread/started` now carries a persisted thread id — no need to
        // wait for `turn/completed` the way `exec --json` did.
        false
    }

    // ── JSON-RPC approval-response encoders ───────────────────────────
    // (Handshake/turn encoders live on the generic `rpc_*` methods below.
    // These three response encoders are still shared via
    // `stream::encode_codex_approval_response`.)

    fn encode_rpc_review_decision_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcDecision,
    ) -> Result<Vec<u8>, String> {
        let frame = json!({
            "id": server_request_id,
            "result": { "decision": decision.as_str() },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_item_approval_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcItemDecision,
    ) -> Result<Vec<u8>, String> {
        let frame = json!({
            "id": server_request_id,
            "result": { "decision": decision.as_str() },
        });
        encode_rpc_frame(&frame)
    }

    fn encode_rpc_permissions_response(
        &self,
        server_request_id: &Value,
        decision: CodexRpcPermissionsDecision,
    ) -> Result<Vec<u8>, String> {
        // `item/permissions/requestApproval` expects
        // `{permissions: GrantedPermissionProfile, scope}` — NOT `{decision}`.
        // The deny path is an empty permissions object.
        let result = match decision {
            CodexRpcPermissionsDecision::Deny => json!({
                "permissions": {},
                "scope": "turn",
            }),
        };
        let frame = json!({
            "id": server_request_id,
            "result": result,
        });
        encode_rpc_frame(&frame)
    }

    // ── Generic RPC seam ────────────────────────────────────────────────
    fn uses_rpc(&self) -> bool {
        true
    }

    fn rpc_encode_initialize(
        &self,
        req_id: i64,
        ci: &super::RpcClientInfo<'_>,
    ) -> Result<Vec<u8>, String> {
        // `experimentalApi` is required by codex app-server >= 0.120 to accept
        // `collaborationMode` on `turn/start`; without it turn/start is
        // rejected with "requires experimentalApi capability".
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": ci.name, "version": ci.version },
                "capabilities": { "experimentalApi": true },
            },
        }))
    }

    fn rpc_encode_initialized(&self) -> Option<Result<Vec<u8>, String>> {
        Some(encode_rpc_frame(&json!({ "method": "initialized" })))
    }

    fn rpc_encode_start(
        &self,
        req_id: i64,
        p: &super::RpcStartParams<'_>,
    ) -> Result<Vec<u8>, String> {
        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), json!(p.cwd));
        params.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(p.trust_level)),
        );
        params.insert(
            "sandbox".into(),
            json!(trust_level_to_thread_sandbox(p.trust_level)),
        );
        if let Some(model) = p.model {
            params.insert("model".into(), json!(model));
        }
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "thread/start",
            "params": Value::Object(params),
        }))
    }

    fn rpc_encode_resume(
        &self,
        req_id: i64,
        p: &super::RpcResumeParams<'_>,
    ) -> Result<Vec<u8>, String> {
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "thread/resume",
            "params": {
                "threadId": p.session_id,
                "cwd": p.cwd,
                "approvalPolicy": trust_level_to_approval_policy(p.trust_level),
                "sandbox": trust_level_to_thread_sandbox(p.trust_level),
            },
        }))
    }

    fn rpc_parse_session_id(&self, r: &Value) -> Option<String> {
        r.pointer("/thread/id").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_turn(&self, req_id: i64, p: &super::RpcTurnParams<'_>) -> Result<Vec<u8>, String> {
        let mut input: Vec<Value> = Vec::new();
        if !p.prompt.is_empty() {
            input.push(json!({ "type": "text", "text": p.prompt }));
        }
        for url in p.image_urls {
            input.push(json!({ "type": "image", "url": url }));
        }

        let mut params = serde_json::Map::new();
        params.insert("threadId".into(), json!(p.session_id));
        params.insert("input".into(), Value::Array(input));
        params.insert(
            "approvalPolicy".into(),
            json!(trust_level_to_approval_policy(p.trust_level)),
        );
        params.insert(
            "sandboxPolicy".into(),
            trust_level_to_turn_sandbox_policy(p.trust_level),
        );
        if let Some(model) = p.model {
            params.insert("model".into(), json!(model));
        }
        if let Some(effort) = p.effort {
            params.insert("effort".into(), json!(effort));
        }

        let collab_mode = if p.plan_mode { "plan" } else { "default" };
        let developer_instructions = if p.plan_mode {
            CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        } else {
            CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS
        };
        let settings = json!({
            "model": p.model.unwrap_or("gpt-6-astra"),
            "reasoning_effort": p.effort.unwrap_or("medium"),
            "developer_instructions": developer_instructions,
        });
        params.insert(
            "collaborationMode".into(),
            json!({ "mode": collab_mode, "settings": settings }),
        );

        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "turn/start",
            "params": Value::Object(params),
        }))
    }

    fn rpc_parse_turn_id(&self, r: &Value) -> Option<String> {
        r.pointer("/turn/id").and_then(|s| s.as_str()).map(|s| s.to_string())
    }

    fn rpc_encode_interrupt(
        &self,
        req_id: i64,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // codex app-server rejects `turn/interrupt` without BOTH ids; if we
        // don't yet know the turn id there is nothing to cancel.
        let Some(turn_id) = turn_id else {
            return Ok(None);
        };
        encode_rpc_frame(&json!({
            "id": req_id,
            "method": "turn/interrupt",
            "params": { "threadId": session_id, "turnId": turn_id },
        }))
        .map(Some)
    }

    fn rpc_is_recoverable_resume_error(&self, message: &str) -> bool {
        super::rpc::is_recoverable_thread_resume_error(message)
    }

    fn rpc_decode_notification(&self, method: &str, params: &Value) -> Vec<crate::stream::OutputItem> {
        crate::stream::process_codex_rpc_notification(method, params)
    }

    fn rpc_extract_usage(&self, method: &str, params: &Value) -> Option<super::RpcTokenUsage> {
        if method != "thread/tokenUsage/updated" {
            return None;
        }
        crate::stream::extract_codex_token_usage(params).map(|u| super::RpcTokenUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_input_tokens,
        })
    }

    fn rpc_is_approval(&self, method: &str) -> bool {
        crate::stream::is_codex_approval_method(method)
    }

    fn rpc_build_approval_entry(
        &self,
        session_id: &str,
        request_id: &str,
        method: &str,
        params: &Value,
    ) -> crate::task::PendingApprovalEntry {
        crate::stream::build_codex_approval_entry(session_id, request_id, method, params)
    }

    fn rpc_encode_approval_response(
        &self,
        method: &str,
        server_req_id: &Value,
        response: &crate::task::ApprovalResponse,
        _entry_input: &Value,
    ) -> Option<Result<Vec<u8>, String>> {
        // Codex derives everything from method + response; entry_input is a
        // Grok-only concern.
        crate::stream::encode_codex_approval_response(self, method, server_req_id, response)
    }

    // ── Accounts ───────────────────────────────────────────────────────

    fn account_profile(&self) -> Option<AccountProfile> {
        Some(AccountProfile {
            // Everything that can sign Codex in or point it at another
            // identity. An account that needs one sets it in its own env.
            scrub_vars: &[
                CODEX_HOME_VAR,
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "OPENAI_FEDERATION_RULE_ID",
                "OPENAI_IDENTITY_TOKEN_FILE",
            ],
            fixed_env: &[],
            // None: `codex app-server`, which Verun spawns, does not sign in
            // from a key in the env (`account/read` reports no account), so
            // such a key is no login. An API-key account signs in with
            // `codex login --with-api-key`, which writes auth.json, and that
            // file is what reads as ApiKey. An inherited key is still scrubbed
            // above, so it cannot reach an added account.
            api_key_vars: &[],
            login_args: Some(&["login"]),
            logout_args: Some(&["logout"]),
            // The login terminal runs `codex login`, the browser sign-in. A key
            // login is `codex login --with-api-key`, which reads the key from
            // stdin, so the user runs it by hand where CODEX_HOME is the
            // account's: in a task shell of a project that uses it.
            login_hint: Some(
                "To use an API key instead, run `codex login --with-api-key` in a task shell of a project that uses this account.",
            ),
            logout_hint: None,
            allows_existing_dir: true,
            required_secret: None,
            in_project_env: true,
            min_cli_version: None,
        })
    }

    fn account_home_env(&self, dir: &Path) -> Vec<(String, String)> {
        vec![(
            CODEX_HOME_VAR.to_string(),
            dir.to_string_lossy().into_owned(),
        )]
    }

    fn account_standard_home(&self, user_home: &Path) -> Option<PathBuf> {
        // Where Codex's home is when `CODEX_HOME` is not set, whatever Verun
        // inherited.
        Some(standard_home(user_home))
    }

    fn prepare_account_dir(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        write_if_absent(&dir.join("config.toml"), MANAGED_HOME_CONFIG)
    }

    fn read_account_identity(&self, home: AccountHome<'_>) -> AccountIdentity {
        codex_identity(home, std::env::var_os(CODEX_HOME_VAR))
    }
}

/// Codex's home when `CODEX_HOME` is not set.
fn standard_home(user_home: &Path) -> PathBuf {
    user_home.join(".codex")
}

/// Writes `contents` to `path` unless something is there already, and leaves
/// what is there alone. The file is created only if it does not exist, in one
/// step, so one that appears after a look at the path is not overwritten
/// either.
fn write_if_absent(path: &Path, contents: &str) -> std::io::Result<()> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file.write_all(contents.as_bytes()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

/// Who `codex` is signed in as at `home`. The login is `auth.json`, which
/// logout deletes, so a home without the file has nobody signed in. A file that
/// is there but cannot be read, or is not shaped the way Codex writes it, says
/// nothing either way, so it is `Unknown` rather than a guess at "signed out".
///
/// The file's `auth_mode` says which login it holds: `chatgpt` (an account) or
/// `apikey`. A file from before Codex recorded a mode is read as Codex reads
/// it, by whether a key is there. A login with nothing to sign in with (no
/// tokens, no key) is signed out. Tokens are never used, only the claims of the
/// `id_token` that say who the account is.
///
/// The login is in the dir of an added account, or for Default in the
/// `CODEX_HOME` Verun inherited, else `~/.codex`: Default sessions keep Verun's
/// own env, so a `CODEX_HOME` exported where Verun was launched is the Default
/// home. As Codex reads the variable, a value that is empty or not UTF-8 counts
/// as unset.
///
/// `inherited_codex_home` is the `CODEX_HOME` Verun itself was started with,
/// passed in so tests need not touch the process env.
fn codex_identity(
    home: AccountHome<'_>,
    inherited_codex_home: Option<OsString>,
) -> AccountIdentity {
    let path = account_home_dir(home, inherited_codex_home, standard_home).join("auth.json");
    let Some(auth) = read_json_with_retry(&path) else {
        return unread_file_identity(&path);
    };
    if !auth.is_object() {
        return unknown_identity(&path, "is not a JSON object");
    }
    let has_key = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty());
    let mode = match auth.get("auth_mode") {
        None | Some(Value::Null) => Some(if has_key { "apikey" } else { "chatgpt" }),
        Some(mode) => mode.as_str(),
    };
    match mode {
        Some("chatgpt") => chatgpt_identity(&path, &auth),
        Some("apikey") => AccountIdentity::with_status(if has_key {
            SignInStatus::ApiKey
        } else {
            SignInStatus::SignedOut
        }),
        _ => unknown_identity(&path, "has an auth_mode that is neither chatgpt nor apikey"),
    }
}

/// The identity of the ChatGPT login in `auth`, a parsed `auth.json`: signed
/// out without tokens, and otherwise whoever the `id_token` says. Tokens that
/// Codex itself would refuse leave it unknown.
fn chatgpt_identity(path: &Path, auth: &Value) -> AccountIdentity {
    let tokens = match auth.get("tokens") {
        None | Some(Value::Null) => return AccountIdentity::with_status(SignInStatus::SignedOut),
        Some(tokens) => tokens,
    };
    let Some(claims) = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload)
    else {
        return unknown_identity(path, "has tokens without an id_token that can be read");
    };
    AccountIdentity {
        status: SignInStatus::SignedIn,
        email: non_empty_str(&claims, "email"),
        plan: claims
            .get("https://api.openai.com/auth")
            .and_then(|openai| non_empty_str(openai, "chatgpt_plan_type"))
            .map(|plan_type| plan_name(&plan_type)),
        ..AccountIdentity::default()
    }
}

/// The plan name for a `chatgpt_plan_type`, as the ChatGPT plans are called;
/// types not listed pass through.
fn plan_name(plan_type: &str) -> String {
    match plan_type {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "pro" => "Pro",
        "prolite" => "Pro Lite",
        "promax" => "Pro Max",
        "team" => "Team",
        "business" => "Business",
        "enterprise" => "Enterprise",
        "edu" => "Edu",
        "edu_plus" => "Edu Plus",
        other => other,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::identity::jwt;
    use std::fs;
    use tempfile::TempDir;

    // ── Accounts ────────────────────────────────────────────────────────

    #[test]
    fn codex_profile_values() {
        assert_eq!(
            Codex.account_profile(),
            Some(AccountProfile {
                scrub_vars: &[
                    "CODEX_HOME",
                    "CODEX_API_KEY",
                    "CODEX_ACCESS_TOKEN",
                    "OPENAI_FEDERATION_RULE_ID",
                    "OPENAI_IDENTITY_TOKEN_FILE",
                ],
                fixed_env: &[],
                // Codex's app-server signs in from its login file only.
                api_key_vars: &[],
                login_args: Some(&["login"]),
                logout_args: Some(&["logout"]),
                login_hint: Some(
                    "To use an API key instead, run `codex login --with-api-key` in a task shell of a project that uses this account."
                ),
                logout_hint: None,
                allows_existing_dir: true,
                required_secret: None,
                in_project_env: true,
                min_cli_version: None,
            })
        );
    }

    #[test]
    fn codex_home_env_sets_codex_home_verbatim() {
        // Codex takes the value literally, so nothing may tidy the spelling on
        // the way to the env.
        for dir in [
            "/x/Client Accounts/acme",
            "/x/Client Accounts/acme/",
            "/x/./acme/../acme",
            "/x/o'brien-é",
        ] {
            assert_eq!(
                Codex.account_home_env(Path::new(dir)),
                vec![("CODEX_HOME".to_string(), dir.to_string())],
                "dir: {dir}"
            );
        }
    }

    #[test]
    fn codex_standard_home_is_dot_codex() {
        assert_eq!(
            Codex.account_standard_home(Path::new("/Users/me")),
            Some(PathBuf::from("/Users/me/.codex"))
        );
    }

    #[test]
    fn codex_prepare_dir_seeds_mcp_file_store_once() {
        let tmp = TempDir::new().unwrap();
        // Codex exits when CODEX_HOME does not exist, so the whole path is made.
        let dir = tmp.path().join("accounts").join("c1");
        Codex.prepare_account_dir(&dir).unwrap();
        let config = dir.join("config.toml");
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "mcp_oauth_credentials_store = \"file\"\n"
        );

        // Preparing it again leaves what is there alone, edits included.
        fs::write(&config, "model = \"gpt-6-astra\"\n").unwrap();
        fs::write(dir.join("marker"), "").unwrap();
        Codex.prepare_account_dir(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "model = \"gpt-6-astra\"\n"
        );
        assert!(dir.join("marker").exists());
    }

    #[test]
    fn codex_prepare_dir_leaves_an_existing_config_as_it_is() {
        // Whoever wrote it, a config.toml that is there is not Verun's to
        // change, and an empty one is as much there as any.
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        for contents in ["", "model = \"gpt-6-astra\"\n"] {
            fs::write(&config, contents).unwrap();
            Codex.prepare_account_dir(tmp.path()).unwrap();
            assert_eq!(fs::read_to_string(&config).unwrap(), contents);
        }
    }

    #[test]
    fn write_if_absent_writes_a_file_that_is_not_there() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");

        write_if_absent(&path, "a = 1\n").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "a = 1\n");
    }

    #[test]
    fn write_if_absent_leaves_what_is_there_alone() {
        // Whoever wrote it, and an empty file is as much there as any.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        for contents in ["", "b = 2\n"] {
            fs::write(&path, contents).unwrap();

            write_if_absent(&path, "a = 1\n").unwrap();

            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_if_absent_does_not_write_through_a_symlink() {
        // A link that points nowhere is still something that is there, and the
        // file it names is not created.
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("target.toml");
        let link = tmp.path().join("config.toml");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_if_absent(&link, "a = 1\n").unwrap();

        assert!(!target.exists());
    }

    #[test]
    fn write_if_absent_reports_a_write_that_cannot_happen() {
        // No folder to put the file in: that is not "already there".
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing").join("config.toml");

        let error = write_if_absent(&path, "a = 1\n").unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    /// An `id_token` whose claims are `claims`.
    fn id_token(claims: Value) -> String {
        jwt(&claims.to_string())
    }

    /// The `auth.json` of a ChatGPT login, as `codex login` writes it.
    fn chatgpt_auth(id_token: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": id_token,
                "access_token": "access",
                "refresh_token": "refresh",
                "account_id": "acct-1",
            },
            "last_refresh": "2026-10-25T10:00:00Z",
        })
    }

    /// An `id_token` of somebody signed in as dev@acme.com.
    fn dev_token() -> String {
        id_token(json!({
            "email": "dev@acme.com",
            "https://api.openai.com/auth": {"chatgpt_plan_type": "pro"},
        }))
    }

    fn write_auth(dir: &Path, json: &str) {
        fs::write(dir.join("auth.json"), json).unwrap();
    }

    fn identity_at(dir: &Path) -> AccountIdentity {
        Codex.read_account_identity(AccountHome::Dir(dir))
    }

    fn only_status(status: SignInStatus) -> AccountIdentity {
        AccountIdentity::with_status(status)
    }

    #[test]
    fn codex_identity_reads_id_token_claims() {
        let dir = TempDir::new().unwrap();
        // The token carries much else; only the email and the plan are read.
        let token = id_token(json!({
            "email": "dev@acme.com",
            "email_verified": true,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct-1",
                "chatgpt_plan_type": "pro",
                "organizations": [{"id": "org-1", "title": "Personal"}],
            },
        }));
        write_auth(dir.path(), &chatgpt_auth(&token).to_string());

        assert_eq!(
            identity_at(dir.path()),
            AccountIdentity {
                status: SignInStatus::SignedIn,
                email: Some("dev@acme.com".into()),
                org_name: None,
                plan: Some("Pro".into()),
                providers: Vec::new(),
            }
        );
    }

    #[test]
    fn codex_identity_names_plans_and_passes_other_types_through() {
        for (plan_type, plan) in [
            ("free", "Free"),
            ("go", "Go"),
            ("plus", "Plus"),
            ("pro", "Pro"),
            ("prolite", "Pro Lite"),
            ("promax", "Pro Max"),
            ("team", "Team"),
            ("business", "Business"),
            ("enterprise", "Enterprise"),
            ("edu", "Edu"),
            ("edu_plus", "Edu Plus"),
            // A plan this reader does not know is shown as Codex spells it.
            ("some_new_plan", "some_new_plan"),
        ] {
            let dir = TempDir::new().unwrap();
            let token = id_token(json!({
                "https://api.openai.com/auth": {"chatgpt_plan_type": plan_type},
            }));
            write_auth(dir.path(), &chatgpt_auth(&token).to_string());
            assert_eq!(
                identity_at(dir.path()).plan.as_deref(),
                Some(plan),
                "type: {plan_type}"
            );
        }
    }

    #[test]
    fn codex_identity_is_signed_in_by_the_token_alone() {
        // A token without an email or a plan, or with empty ones, is still a
        // login.
        for claims in [
            json!({}),
            json!({"email": "", "https://api.openai.com/auth": {"chatgpt_plan_type": ""}}),
            json!({"https://api.openai.com/auth": "not an object"}),
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(
                dir.path(),
                &chatgpt_auth(&id_token(claims.clone())).to_string(),
            );
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedIn),
                "claims: {claims}"
            );
        }
    }

    #[test]
    fn codex_identity_api_key_mode() {
        let dir = TempDir::new().unwrap();
        // What `codex login --with-api-key` writes.
        write_auth(
            dir.path(),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test-123"}"#,
        );
        assert_eq!(identity_at(dir.path()), only_status(SignInStatus::ApiKey));
    }

    #[test]
    fn codex_identity_without_a_mode_goes_by_the_key() {
        // Files from before the CLI recorded a mode are still read, and the
        // CLI takes them for an API key login when a key is there and for a
        // ChatGPT one when it is not.
        let token = dev_token();
        let tokens = json!({"id_token": token, "access_token": "a", "refresh_token": "r"});
        let cases = [
            (
                json!({"OPENAI_API_KEY": "sk-test-123"}),
                only_status(SignInStatus::ApiKey),
            ),
            (
                json!({"OPENAI_API_KEY": "sk-test-123", "tokens": tokens}),
                only_status(SignInStatus::ApiKey),
            ),
            (
                json!({"OPENAI_API_KEY": null, "tokens": tokens}),
                AccountIdentity {
                    status: SignInStatus::SignedIn,
                    email: Some("dev@acme.com".into()),
                    plan: Some("Pro".into()),
                    ..AccountIdentity::default()
                },
            ),
        ];
        for (json, expected) in cases {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), &json.to_string());
            assert_eq!(identity_at(dir.path()), expected, "file: {json}");
        }
    }

    #[test]
    fn codex_identity_mode_wins_over_a_key_in_the_file() {
        // `chatgpt` with a key beside the tokens is a ChatGPT login.
        let dir = TempDir::new().unwrap();
        let mut auth = chatgpt_auth(&dev_token());
        auth["OPENAI_API_KEY"] = "sk-test-123".into();
        write_auth(dir.path(), &auth.to_string());

        let identity = identity_at(dir.path());

        assert_eq!(identity.status, SignInStatus::SignedIn);
        assert_eq!(identity.email.as_deref(), Some("dev@acme.com"));
    }

    #[test]
    fn codex_identity_missing_is_signed_out() {
        // Logout deletes auth.json, and a dir that never saw a login has none.
        let dir = TempDir::new().unwrap();
        assert_eq!(
            identity_at(dir.path()),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn codex_identity_signed_out_when_the_file_holds_no_credentials() {
        // The file reads fine and has nothing in it to sign in with: no tokens
        // for a ChatGPT login, no key for an API key one.
        for json in [
            "{}",
            r#"{"auth_mode":"chatgpt"}"#,
            r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":null}"#,
            r#"{"auth_mode":"apikey"}"#,
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":null}"#,
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":""}"#,
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), json);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::SignedOut),
                "file: {json}"
            );
        }
    }

    #[test]
    fn codex_identity_unknown_when_the_file_cannot_be_read() {
        // The file is there, so someone may well be signed in; "signed out"
        // would refuse the account on a guess.
        let unknown = only_status(SignInStatus::Unknown);
        // Not JSON, and empty, which is what a truncating rewrite leaves.
        for json in ["not json", "", r#"{"auth_mode":"#] {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), json);
            assert_eq!(identity_at(dir.path()), unknown, "file: {json:?}");
        }
        // Not a file.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("auth.json")).unwrap();
        assert_eq!(identity_at(dir.path()), unknown);
    }

    #[test]
    fn codex_identity_unknown_for_an_unexpected_shape() {
        // Valid JSON, but not what Codex writes: not a logout either.
        let not_json_claims = format!(
            r#"{{"auth_mode":"chatgpt","tokens":{{"id_token":"{}"}}}}"#,
            jwt("not json")
        );
        for json in [
            "[]",
            r#""dev@acme.com""#,
            "42",
            "null",
            // A mode this reader does not know.
            r#"{"auth_mode":"agentIdentity"}"#,
            r#"{"auth_mode":42}"#,
            // Tokens Codex itself refuses.
            r#"{"auth_mode":"chatgpt","tokens":"abc"}"#,
            r#"{"auth_mode":"chatgpt","tokens":{}}"#,
            r#"{"auth_mode":"chatgpt","tokens":{"access_token":"a","refresh_token":"r"}}"#,
            r#"{"auth_mode":"chatgpt","tokens":{"id_token":"not a jwt"}}"#,
            r#"{"auth_mode":"chatgpt","tokens":{"id_token":42}}"#,
            not_json_claims.as_str(),
        ] {
            let dir = TempDir::new().unwrap();
            write_auth(dir.path(), json);
            assert_eq!(
                identity_at(dir.path()),
                only_status(SignInStatus::Unknown),
                "file: {json}"
            );
        }
    }

    #[test]
    fn codex_identity_default_reads_dot_codex_in_the_users_home() {
        let home = TempDir::new().unwrap();
        let codex_dir = home.path().join(".codex");
        fs::create_dir(&codex_dir).unwrap();
        write_auth(&codex_dir, &chatgpt_auth(&dev_token()).to_string());
        // An auth.json in the home folder itself is not Codex's.
        write_auth(
            home.path(),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk"}"#,
        );

        let identity = codex_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            None,
        );

        assert_eq!(identity.status, SignInStatus::SignedIn);
        assert_eq!(identity.email.as_deref(), Some("dev@acme.com"));
    }

    #[test]
    fn codex_identity_default_without_a_login_is_signed_out() {
        let home = TempDir::new().unwrap();
        assert_eq!(
            codex_identity(
                AccountHome::Default {
                    user_home: home.path(),
                },
                None,
            ),
            only_status(SignInStatus::SignedOut)
        );
    }

    #[test]
    fn codex_identity_default_follows_the_inherited_codex_home() {
        // Default sessions keep Verun's env, so a CODEX_HOME exported where
        // Verun was launched is the Default home.
        let home = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        fs::create_dir(home.path().join(".codex")).unwrap();
        write_auth(
            &home.path().join(".codex"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk"}"#,
        );
        write_auth(inherited.path(), &chatgpt_auth(&dev_token()).to_string());
        let default_status = |inherited: Option<OsString>| {
            let default = AccountHome::Default {
                user_home: home.path(),
            };
            codex_identity(default, inherited).status
        };

        assert_eq!(
            default_status(Some(inherited.path().into())),
            SignInStatus::SignedIn
        );
        // An empty value counts as unset, as it does for Codex.
        assert_eq!(default_status(Some(OsString::new())), SignInStatus::ApiKey);
        assert_eq!(default_status(None), SignInStatus::ApiKey);
    }

    #[cfg(unix)]
    #[test]
    fn codex_identity_default_treats_a_non_utf8_inherited_codex_home_as_unset() {
        // Codex reads the variable as a string and falls back to ~/.codex when
        // that fails, so both land on the same auth.json.
        use std::os::unix::ffi::OsStringExt;
        let home = TempDir::new().unwrap();
        fs::create_dir(home.path().join(".codex")).unwrap();
        write_auth(
            &home.path().join(".codex"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk"}"#,
        );
        let inherited = OsString::from_vec(vec![b'/', 0xff, b'x']);

        let identity = codex_identity(
            AccountHome::Default {
                user_home: home.path(),
            },
            Some(inherited),
        );

        assert_eq!(identity.status, SignInStatus::ApiKey);
    }

    #[test]
    fn codex_identity_of_an_added_dir_ignores_the_inherited_codex_home() {
        let dir = TempDir::new().unwrap();
        let inherited = TempDir::new().unwrap();
        write_auth(dir.path(), &chatgpt_auth(&dev_token()).to_string());
        write_auth(
            inherited.path(),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk"}"#,
        );

        let identity = codex_identity(AccountHome::Dir(dir.path()), Some(inherited.path().into()));

        assert_eq!(identity.status, SignInStatus::SignedIn);
    }
}
