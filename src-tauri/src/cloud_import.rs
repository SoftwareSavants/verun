//! Claude cloud handoff. Import in a disposable clone before publishing a task.

use crate::{
    claude_jsonl, claude_terminal,
    db::{DbWrite, DbWriteTx, Project, Session, Task},
    pty::{self, ActivePtyMap},
    stream::OutputItem,
    task, worktree,
};
use serde::Serialize;
use sqlx::SqlitePool;
use std::{collections::HashMap, path::Path, process::Command, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

pub type CloudImportMap = Arc<Mutex<HashMap<String, CloudImport>>>;

pub struct CloudImport {
    _temp: tempfile::TempDir,
    staging: String,
    task: Task,
    terminal_id: String,
    sessions: Vec<CloudSessionChoice>,
    selected: bool,
    completed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub import_id: String,
    pub sessions: Vec<CloudSessionChoice>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSessionChoice {
    pub index: usize,
    pub title: String,
    pub updated: String,
}

// Parse only the completed CLI picker, never conversation output. Keep the
// CLI's ordinal as identity: duplicate titles are valid, and IDs aren't exposed.
fn picker_rows(screen: &str) -> Option<Vec<CloudSessionChoice>> {
    if screen
        .lines()
        .any(|l| l.trim().starts_with("No Claude Code sessions found"))
    {
        return Some(vec![]);
    }
    if !screen.contains("Select a session to resume") || !screen.contains("Esc to cancel") {
        return None;
    }
    let header = screen
        .lines()
        .find(|l| l.contains("Updated") && l.contains("Session Title"))?;
    let title_col = header[..header.find("Session Title")?].chars().count();
    let updated_col = header[..header.find("Updated")?].chars().count();
    let mut rows = Vec::new();
    for line in screen.lines() {
        let prefix: String = line.chars().take(updated_col).collect();
        let prefix = prefix.trim().trim_start_matches('❯').trim();
        let Some(index) = prefix
            .strip_suffix('.')
            .and_then(|s| s.parse::<usize>().ok())
        else {
            continue;
        };
        let updated: String = line
            .chars()
            .skip(updated_col)
            .take(title_col.checked_sub(updated_col)?)
            .collect();
        let title: String = line.chars().skip(title_col).collect();
        if title.trim().is_empty() || updated.trim().is_empty() {
            return None;
        }
        rows.push(CloudSessionChoice {
            index,
            title: title.trim().into(),
            updated: updated.trim().into(),
        });
    }
    if rows.is_empty() || rows.iter().enumerate().any(|(i, row)| row.index != i + 1) {
        return None;
    }
    // The PTY is tall enough for normal lists. Never silently select from a
    // clipped/scrolling list, whose ordinals may change as it scrolls.
    if screen.lines().next().is_some_and(|l| l.contains(" of ")) {
        return None;
    }
    Some(rows)
}

const PICKER_ROWS: u16 = 200;
const PICKER_COLS: u16 = 200;

struct CliScreen {
    parser: vt100::Parser,
    sequence: u64,
}

impl CliScreen {
    fn new() -> Self {
        Self {
            parser: vt100::Parser::new(PICKER_ROWS, PICKER_COLS, 0),
            sequence: 0,
        }
    }

    fn read(&mut self, map: &ActivePtyMap, terminal: &str) -> Result<(String, bool), String> {
        let handle = map.get(terminal).ok_or("Cloud import was cancelled")?;
        let (text, written) = handle.output.snapshot();
        let start = written.saturating_sub(text.len() as u64);
        if start > self.sequence {
            return Err("Claude output exceeded the import buffer. Please retry.".into());
        }
        let offset = (self.sequence - start) as usize;
        self.parser.process(
            text.get(offset..)
                .ok_or("Invalid Claude output checkpoint")?
                .as_bytes(),
        );
        self.sequence = written;
        Ok((self.parser.screen().contents(), handle.output.has_exited()))
    }
}

fn trust_prompt_input(text: &str) -> Option<&'static [u8]> {
    if !text.contains("Quick safety check:") || !text.contains("Enter to confirm") {
        return None;
    }
    let focused = text
        .lines()
        .find_map(|line| line.trim().strip_prefix('❯'))?
        .trim();
    match focused {
        "No, exit" => Some(b"\x1b[B"),
        "Yes, I trust this folder" => Some(b"\r"),
        _ => None,
    }
}

fn picker_focus(text: &str) -> Option<usize> {
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix('❯')?
            .trim()
            .split_once('.')?
            .0
            .parse()
            .ok()
    })
}

async fn wait_for_picker(
    map: &ActivePtyMap,
    terminal: &str,
) -> Result<Vec<CloudSessionChoice>, String> {
    let mut screen = CliScreen::new();
    let mut last_input = tokio::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let (text, exited) = screen.read(map, terminal)?;
            if let Some(rows) = picker_rows(&text) { return Ok(rows); }
            if exited { return Err("Claude exited before listing cloud sessions. Check `claude --teleport` in your terminal.".into()); }
            // The staging checkout is our disposable clone of the selected project.
            if last_input.elapsed() >= std::time::Duration::from_secs(1) {
                if let Some(input) = trust_prompt_input(&text) {
                    pty::write_pty(map, terminal, input)?;
                    last_input = tokio::time::Instant::now();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }).await.map_err(|_| "Claude’s cloud picker did not load. Check `claude --teleport` in your terminal, then retry.".to_string())?
}

pub async fn select(
    map: &CloudImportMap,
    pty_map: &ActivePtyMap,
    project_id: &str,
    id: &str,
    index: usize,
) -> Result<(), String> {
    let (terminal, choices) = {
        let mut imports = map.lock().await;
        let import = imports.get_mut(id).ok_or("Import no longer exists")?;
        if import.task.project_id != project_id {
            return Err("Import project mismatch".into());
        }
        if import.selected {
            return Err("This import has already been selected. Refresh to try again.".into());
        }
        let choice = import
            .sessions
            .iter()
            .find(|s| s.index == index)
            .ok_or("Cloud session not found")?;
        import.task.name = Some(choice.title.clone());
        import.selected = true;
        (import.terminal_id.clone(), import.sessions.clone())
    };
    let mut screen = CliScreen::new();
    let (text, _) = screen.read(pty_map, &terminal)?;
    if picker_rows(&text).as_ref() != Some(&choices) {
        return Err("Claude’s session list changed. Refresh and select again.".into());
    }
    // Observe focus after each navigation key before confirming the choice.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let (text, exited) = screen.read(pty_map, &terminal)?;
            if exited || picker_rows(&text).as_ref() != Some(&choices) {
                return Err("Claude’s session list changed. Refresh and select again.".to_string());
            }
            let focus = picker_focus(&text).ok_or("Cannot locate Claude’s selected session")?;
            if focus == index {
                pty::write_pty(pty_map, &terminal, b"\r")?;
                return Ok::<(), String>(());
            }
            pty::write_pty(
                pty_map,
                &terminal,
                if focus < index { b"\x1b[B" } else { b"\x1b[A" },
            )?;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    })
    .await
    .map_err(|_| "Claude’s session selection timed out. Refresh and try again.".to_string())??;
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let mut exiting = false;
        loop {
            let (text, exited) = screen.read(pty_map, &terminal)?;
            if exited {
                return if exiting { Ok::<(), String>(()) } else { Err("Claude exited before the cloud conversation was imported. Refresh to try again.".into()) };
            }
            if !exiting && text.lines().any(|l| l.trim() == "⏺ Session resumed") {
                pty::write_pty(pty_map, &terminal, b"/exit\r")?;
                exiting = true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }).await.map_err(|_| "Claude could not finish the import. Refresh and try again.".to_string())??;
    let mut imports = map.lock().await;
    let import = imports.get_mut(id).ok_or("Cloud import was cancelled")?;
    import.completed = true;
    Ok(())
}

#[derive(Serialize)]
pub struct Availability {
    pub available: bool,
    pub reason: Option<String>,
}

fn cloud_available(status: &serde_json::Value) -> bool {
    status["loggedIn"] == true
        && status["authMethod"] == "claude.ai"
        && status["apiProvider"] == "firstParty"
}

pub async fn availability() -> Availability {
    match auth_status().await {
        Ok(status) if cloud_available(&status) => Availability {
            available: true,
            reason: None,
        },
        Ok(_) => Availability {
            available: false,
            reason: Some("Sign in with `claude auth login` using a Claude subscription.".into()),
        },
        Err(reason) => Availability {
            available: false,
            reason: Some(reason),
        },
    }
}

async fn auth_status() -> Result<serde_json::Value, String> {
    let auth = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new("claude")
            .args(["auth", "status"])
            .env_remove("CLAUDECODE")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Claude authentication check timed out")?
    .map_err(|e| format!("Cannot run Claude Code: {e}"))?;
    serde_json::from_slice(&auth.stdout)
        .map_err(|_| "Update Claude Code to use cloud import".into())
}

struct ImportedHistory {
    resume_id: String,
    items: Vec<OutputItem>,
}

fn git(path: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn imported_history(text: &str, branch: &str) -> Result<ImportedHistory, String> {
    if branch.is_empty() {
        return Err("Cloud branch was not checked out".into());
    }
    let mut id = None;
    let mut items = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let value: serde_json::Value = serde_json::from_str(line)
            .map_err(|_| "Conversation import is incomplete; finish teleport first")?;
        if value["remoteSourced"] != true
            || !matches!(value["type"].as_str(), Some("user" | "assistant"))
        {
            continue;
        }
        let rid = value["sessionId"]
            .as_str()
            .ok_or("Missing local conversation ID")?;
        Uuid::parse_str(rid).map_err(|_| "Invalid local conversation ID")?;
        if id.as_deref().is_some_and(|old| old != rid) {
            return Err("Conversation contains mixed session IDs".into());
        }
        if value["gitBranch"].as_str() != Some(branch) {
            return Err("Conversation and workspace branches do not match".into());
        }
        id = Some(rid.to_string());
        items.extend(claude_jsonl::parse_transcript_line(line));
    }
    Ok(ImportedHistory {
        resume_id: id.ok_or("No imported cloud conversation found; choose a session first")?,
        items,
    })
}

/// Fetch the verified commit from the isolated clone, never check out its cloud
/// branch in the user's repository. Retries accept only the exact prepared task.
fn prepare_worktree(
    repo: &str,
    staging: &str,
    target: &str,
    branch: &str,
    allow_detached: bool,
) -> Result<(), String> {
    worktree::validate_branch_name(branch)?;
    if !git(staging, &["status", "--porcelain"])?.is_empty() {
        return Err("Imported workspace has uncommitted changes".into());
    }
    if !allow_detached && git(staging, &["branch", "--show-current"])?.is_empty() {
        return Err("Cloud branch was not checked out".into());
    }
    let sha = git(staging, &["rev-parse", "HEAD"])?;
    if Path::new(target).exists() {
        if git(target, &["status", "--porcelain"])?.is_empty()
            && git(target, &["branch", "--show-current"])? == branch
            && git(target, &["rev-parse", "HEAD"])? == sha
        {
            return Ok(());
        }
        return Err("Existing task workspace does not match the cloud commit".into());
    }
    git(repo, &["fetch", "--no-tags", staging, &sha])?;
    git(repo, &["worktree", "add", "-b", branch, target, &sha])?;
    if git(target, &["branch", "--show-current"])? != branch
        || git(target, &["rev-parse", "HEAD"])? != sha
    {
        return Err("Could not verify the local task branch".into());
    }
    Ok(())
}

pub async fn begin(
    app: AppHandle,
    project: Project,
    port_offset: i64,
    map: CloudImportMap,
    pty_map: ActivePtyMap,
) -> Result<BeginResult, String> {
    let status = auth_status().await?;
    if !cloud_available(&status) {
        return Err("Sign in with `claude auth login` to import cloud sessions. A Claude subscription is required.".into());
    }
    let id = Uuid::new_v4().to_string();
    let repo = project.repo_path.clone();
    let (temp, staging, branch) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let temp = tempfile::Builder::new()
            .prefix("verun-cloud-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let staging = temp.path().join("repo").to_string_lossy().into_owned();
        let remote = git(&repo, &["remote", "get-url", "origin"])?;
        git(
            &repo,
            &[
                "clone",
                "--no-hardlinks",
                "--no-checkout",
                "--",
                &repo,
                &staging,
            ],
        )?;
        git(&staging, &["remote", "set-url", "origin", &remote])?;
        git(&staging, &["checkout", "--detach", "HEAD"])?;
        let staging = std::fs::canonicalize(staging)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        Ok((temp, staging, task::generate_branch_name(&repo)))
    })
    .await
    .map_err(|e| e.to_string())??;
    let task = Task {
        id: id.clone(),
        project_id: project.id,
        name: None,
        worktree_path: format!("{}/.verun/worktrees/{}", project.repo_path, branch),
        branch,
        created_at: task::epoch_ms(),
        merge_base_sha: None,
        port_offset,
        archived: false,
        archived_at: None,
        last_commit_message: None,
        parent_task_id: None,
        agent_type: "claude".into(),
        last_pushed_sha: None,
    };
    let spawn = tokio::task::spawn_blocking({
        let staging = staging.clone();
        let id = id.clone();
        let pty_map = pty_map.clone();
        move || {
            pty::spawn_pty(
                app,
                pty_map,
                id,
                staging,
                PICKER_ROWS,
                PICKER_COLS,
                Some("exec claude --safe-mode --teleport".into()),
                vec![],
                true,
                Some("Import from Claude cloud".into()),
                false,
                None,
            )
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let terminal_id = spawn.terminal_id;
    map.lock().await.insert(
        id.clone(),
        CloudImport {
            _temp: temp,
            staging,
            task,
            terminal_id: terminal_id.clone(),
            sessions: vec![],
            selected: false,
            completed: false,
        },
    );
    let sessions = match wait_for_picker(&pty_map, &terminal_id).await {
        Ok(sessions) => sessions,
        Err(error) => {
            let _ = cancel(&map, &pty_map, &id).await;
            return Err(error);
        }
    };
    if let Some(import) = map.lock().await.get_mut(&id) {
        import.sessions = sessions.clone();
    }
    Ok(BeginResult {
        import_id: id,
        sessions,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn finish(
    app: &AppHandle,
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    map: &CloudImportMap,
    pty_map: &ActivePtyMap,
    id: &str,
    project: &Project,
) -> Result<(Task, Session), String> {
    let mut imports = map.lock().await;
    let import = imports.get(id).ok_or("Import no longer exists")?;
    if !import.completed {
        return Err("Choose a cloud session and wait for its import to finish.".into());
    }
    if import.task.project_id != project.id {
        return Err("Import project mismatch".into());
    }
    if pty_map
        .get(&import.terminal_id)
        .is_some_and(|pty| !pty.output.has_exited())
    {
        return Err("Claude is still completing the import. Please retry shortly.".into());
    }
    let progress = |phase: &str| {
        let _ = app.emit(
            "cloud-import-progress",
            serde_json::json!({ "importId": id, "phase": phase }),
        );
    };
    progress("Importing conversation");
    let staging = import.staging.clone();
    let task = import.task.clone();
    let repo = project.repo_path.clone();
    let app_clone = app.clone();
    let import_id = id.to_string();
    let history = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let branch = git(&staging, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        let dir = claude_jsonl::projects_dir(Path::new(&staging)).ok_or("HOME is not set")?;
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(|_| "No imported conversation found")? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            if let Ok(history) = imported_history(&text, &branch) {
                found.push((history, text));
            }
        }
        if found.len() != 1 {
            return Err("Select exactly one cloud session before continuing locally".into());
        }
        let (history, text) = found.remove(0);
        let _ = app_clone.emit(
            "cloud-import-progress",
            serde_json::json!({ "importId": import_id, "phase": "Preparing worktree" }),
        );
        prepare_worktree(
            &repo,
            &staging,
            &task.worktree_path,
            &task.branch,
            branch == "HEAD",
        )?;
        let dest = claude_jsonl::session_path(Path::new(&task.worktree_path), &history.resume_id)
            .ok_or("HOME is not set")?;
        std::fs::create_dir_all(dest.parent().ok_or("Invalid transcript path")?)
            .map_err(|e| e.to_string())?;
        let mut rewritten = String::new();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let mut value: serde_json::Value =
                serde_json::from_str(line).map_err(|e| e.to_string())?;
            if value.get("cwd").is_some() {
                value["cwd"] = task.worktree_path.clone().into();
            }
            if value.get("gitBranch").is_some() {
                value["gitBranch"] = task.branch.clone().into();
            }
            rewritten.push_str(&value.to_string());
            rewritten.push('\n');
        }
        std::fs::write(dest, rewritten).map_err(|e| e.to_string())?;
        Ok(history)
    })
    .await
    .map_err(|e| e.to_string())??;
    let task = import.task.clone();
    let now = task::epoch_ms();
    let session = Session {
        id: Uuid::new_v4().to_string(),
        task_id: task.id.clone(),
        name: Some("From Claude cloud".into()),
        resume_session_id: Some(history.resume_id),
        status: "idle".into(),
        started_at: now,
        ended_at: None,
        total_cost: 0.0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        parent_session_id: None,
        forked_at_message_uuid: None,
        agent_type: "claude".into(),
        model: None,
        closed_at: None,
    };
    let data_dir = {
        use tauri::Manager;
        app.state::<crate::blob::AppDataDir>().0.clone()
    };
    #[cfg(unix)]
    {
        let app_data = data_dir.clone();
        let task_id = task.id.clone();
        let configured = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let relay = crate::mcp::relay_binary_path().map_err(|e| e.to_string())?;
            crate::mcp::write_verun_mcp_config(
                &app_data,
                &task_id,
                &crate::mcp::socket_path(&app_data),
                &relay,
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Err(error) = configured {
            eprintln!("[verun][cloud-import] MCP configuration: {error}");
        }
    }
    let lines = claude_terminal::build_persist_lines(
        pool,
        &data_dir,
        claude_terminal::partition_tail_batch(&history.items),
    )
    .await;
    // Enqueue writes together; a receipt confirms persistence before exposing the task.
    let (done, received) = tokio::sync::oneshot::channel();
    db_tx
        .send(DbWrite::ImportCloudTask {
            task: Box::new(task.clone()),
            session: Box::new(session.clone()),
            lines: lines.into_iter().map(|l| (l, now)).collect(),
            done,
        })
        .await
        .map_err(|e| e.to_string())?;
    received.await.map_err(|e| e.to_string())??;
    let pty_map = pty_map.clone();
    let terminal_id = import.terminal_id.clone();
    let completed = imports.remove(id);
    tokio::task::spawn_blocking(move || {
        let _ = pty::close_pty(&pty_map, &terminal_id);
        drop(completed);
    });
    progress("Ready");
    Ok((task, session))
}

pub async fn cancel(map: &CloudImportMap, pty_map: &ActivePtyMap, id: &str) -> Result<(), String> {
    let mut imports = map.lock().await;
    if let Some(import) = imports.get(id) {
        let pty_map = pty_map.clone();
        let terminal = import.terminal_id.clone();
        let path = import.task.worktree_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            pty::close_pty(&pty_map, &terminal)?;
            // A failed finish can leave a prepared worktree. Never force-remove edits.
            if Path::new(&path).exists() {
                git(&path, &["worktree", "remove", &path])?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    // TempDir performs synchronous cleanup away from the runtime.
    if let Some(import) = imports.remove(id) {
        tokio::task::spawn_blocking(move || drop(import))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[tokio::test]
    async fn selected_cloud_title_names_the_task_before_publication() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "import", "projectId": "project", "worktreePath": "/tmp/task",
            "branch": "test", "createdAt": 0, "portOffset": 0,
            "archived": false, "agentType": "claude"
        }))
        .unwrap();
        let map = CloudImportMap::default();
        map.lock().await.insert(
            "import".into(),
            CloudImport {
                _temp: tempfile::tempdir().unwrap(),
                staging: String::new(),
                task,
                terminal_id: "missing".into(),
                sessions: vec![CloudSessionChoice {
                    index: 2,
                    title: "Rebrand name brainstorming".into(),
                    updated: "1d ago".into(),
                }],
                selected: false,
                completed: false,
            },
        );
        // No terminal is needed to check that selection preserves the title on
        // the task that finish() later persists and returns.
        let _ = select(&map, &ActivePtyMap::default(), "project", "import", 2).await;
        assert_eq!(
            map.lock().await["import"].task.name.as_deref(),
            Some("Rebrand name brainstorming")
        );
    }

    #[test]
    fn trust_prompt_is_driven_by_observed_focus_not_an_unacknowledged_keypress() {
        let prompt = "Accessing workspace:\nQuick safety check:\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel";
        assert_eq!(trust_prompt_input(prompt), Some(&b"\x1b[B"[..]));
        assert_eq!(
            trust_prompt_input(&prompt.replace("❯ No, exit\nYes", "No, exit\n❯ Yes")),
            Some(&b"\r"[..])
        );
        assert_eq!(trust_prompt_input("Yes, I trust this folder"), None);
    }

    #[test]
    fn picker_tracks_focus_before_confirming_a_session() {
        assert_eq!(picker_focus(" ❯ 2. 1w ago  Some session"), Some(2));
        assert_eq!(picker_focus(" 2. 1w ago Some session"), None);
    }

    #[test]
    fn imported_history_supports_cloud_conversations_without_code_changes() {
        let text = r#"{"type":"assistant","remoteSourced":true,"sessionId":"8c9e87c5-ce31-4e82-9760-bc10e7cd75a6","gitBranch":"HEAD","message":{"content":[{"type":"text","text":"brainstorm"}]}}"#;
        assert!(imported_history(text, "HEAD").is_ok());
    }

    #[test]
    fn picker_extracts_cli_rows_and_preserves_selection_identity() {
        let screen = "Select a session to resume (SoftwareSavants/mouyassir):\n\n      Updated  Session Title\n  ❯ 1. 1d ago  Rebrand name brainstorming\n    2. 1w ago  Mouyassir’s Notifications\n\n ↑/↓ to select · Enter to confirm · Esc to cancel";
        let rows = picker_rows(screen).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].index, 1);
        assert_eq!(rows[0].title, "Rebrand name brainstorming");
        assert_eq!(rows[1].updated, "1w ago");
        assert!(picker_rows("Loading Claude Code sessions…").is_none());
        assert_eq!(
            picker_rows("No Claude Code sessions found for owner/repo")
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn picker_rejects_partial_or_changed_cli_layout() {
        assert!(
            picker_rows("Select a session to resume:\n Updated Session Title\n 1. title only")
                .is_none()
        );
        assert!(picker_rows("Select a session to resume:\n Updated Session Title\n 1. 1d ago  Title\nEnter to confirm").is_none());
    }

    #[test]
    fn cloud_availability_requires_subscription_auth_and_first_party_provider() {
        assert!(cloud_available(
            &serde_json::json!({"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"})
        ));
        assert!(!cloud_available(
            &serde_json::json!({"loggedIn":false,"authMethod":"none"})
        ));
        assert!(!cloud_available(
            &serde_json::json!({"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"})
        ));
        assert!(!cloud_available(
            &serde_json::json!({"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"})
        ));
    }

    fn git(path: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(path)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn imported_history_requires_cloud_messages_and_a_valid_local_uuid() {
        let id = "8c9e87c5-ce31-4e82-9760-bc10e7cd75a6";
        let text = format!(
            r#"{{"type":"assistant","remoteSourced":true,"sessionId":"{id}","gitBranch":"claude/cloud","message":{{"content":[{{"type":"text","text":"cloud history"}}]}}}}"#
        );
        let history = imported_history(&text, "claude/cloud").unwrap();
        assert_eq!(history.resume_id, id);
        assert!(!history.items.is_empty());
        assert!(imported_history(&text, "HEAD").is_err());
        assert!(imported_history(&text, "wrong-branch").is_err());
        assert!(imported_history(&text.replace(id, "../../escape"), "claude/cloud").is_err());
        assert!(imported_history(&text.replace("true", "false"), "claude/cloud").is_err());
    }

    #[test]
    fn isolated_task_branch_uses_cloud_commit_even_when_cloud_branch_is_open_elsewhere() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let staging = root.path().join("staging");
        let target = root.path().join("task");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["commit", "--allow-empty", "-m", "base"]);
        git(&repo, &["switch", "-c", "claude/cloud"]);
        git(&repo, &["commit", "--allow-empty", "-m", "cloud"]);
        let sha = git(&repo, &["rev-parse", "HEAD"]);
        git(
            root.path(),
            &[
                "clone",
                "--no-hardlinks",
                repo.to_str().unwrap(),
                staging.to_str().unwrap(),
            ],
        );
        prepare_worktree(
            repo.to_str().unwrap(),
            staging.to_str().unwrap(),
            target.to_str().unwrap(),
            "funny-task",
            false,
        )
        .unwrap();
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), sha);
        assert_eq!(git(&target, &["branch", "--show-current"]), "funny-task");
        assert_eq!(git(&repo, &["branch", "--show-current"]), "claude/cloud");
        assert!(
            prepare_worktree(
                repo.to_str().unwrap(),
                staging.to_str().unwrap(),
                target.to_str().unwrap(),
                "funny-task",
                false
            )
            .is_ok(),
            "retry must be idempotent"
        );
    }

    #[test]
    fn workspace_preparation_refuses_dirty_or_detached_imports() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().to_str().unwrap();
        git(root.path(), &["init", "-b", "main"]);
        git(root.path(), &["commit", "--allow-empty", "-m", "base"]);
        let target = root.path().join("target");
        git(root.path(), &["checkout", "--detach"]);
        assert!(prepare_worktree(repo, repo, target.to_str().unwrap(), "task", false).is_err());
        git(root.path(), &["switch", "main"]);
        std::fs::write(root.path().join("uncommitted"), "keep me").unwrap();
        assert!(prepare_worktree(repo, repo, target.to_str().unwrap(), "task", false).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("uncommitted")).unwrap(),
            "keep me"
        );
    }
}
