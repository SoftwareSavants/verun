//! Cross-provider session handoff.
//!
//! A handoff starts a new session on another harness inside the same task
//! (same worktree, same branch) and seeds it with a "handoff packet": a
//! self-contained prompt built from the source session's persisted output and
//! the worktree's git state. Nothing here depends on the source harness being
//! alive, and the packet does not rely on the target having Verun's MCP tools
//! (only Claude gets them), so the full transcript is also written to a file
//! the target agent can read.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

use crate::accounts::{service::resolve_new_session_account, AccountSelection};
use crate::db::{self, DbWriteTx, Session, Task};
use crate::task::AttachmentRef;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Turn {
    pub user: Option<String>,
    pub assistant: Vec<String>,
    pub tools: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct RepoState {
    pub branch: String,
    pub base_branch: Option<String>,
    /// `"<status> <path>"`, e.g. `"M src/lib.rs"`.
    pub changed_files: Vec<String>,
    /// `"<short hash> <subject>"`, newest first.
    pub commits: Vec<String>,
}

pub struct PacketInput<'a> {
    pub source_agent: &'a str,
    pub target_agent: &'a str,
    pub task_name: Option<&'a str>,
    pub worktree_path: &'a str,
    pub repo: &'a RepoState,
    pub turns: &'a [Turn],
    pub transcript_path: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub text: String,
    pub included_turns: usize,
    pub omitted_turns: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandoff {
    pub session: Session,
    /// The packet, stored as a markdown file to attach to the first message.
    pub attachment: AttachmentRef,
    /// The packet text, for callers that send it themselves (MCP).
    #[serde(skip)]
    pub packet: String,
    pub included_turns: usize,
    pub omitted_turns: usize,
    pub transcript_path: Option<String>,
}

/// Most of the packet is spent on the conversation; this caps that section.
/// The framing and repo state come on top of it (a few KB at most).
pub const INLINE_BUDGET: usize = 16_000;
const MAX_CHANGED_FILES: usize = 20;
const MAX_COMMITS: usize = 10;
/// Per-field limits for a turn written in full / in compact form.
const FULL_FIELD: usize = 2_000;
const COMPACT_FIELD: usize = 400;
const TOOL_SUMMARY: usize = 160;

fn display_name(agent_type: &str) -> &'static str {
    use crate::agent::AgentKind;
    AgentKind::parse(agent_type).implementation().display_name()
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

fn tool_summary(tool: &str, input: &str) -> String {
    let detail = match serde_json::from_str::<Value>(input) {
        Ok(v) => crate::policy::summarize_input(tool, &v),
        Err(_) => input.to_string(),
    };
    let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    if detail.is_empty() {
        tool.to_string()
    } else {
        truncate(&format!("{tool} {detail}"), TOOL_SUMMARY)
    }
}

/// Group a session's persisted output lines into turns. Mirrors what the chat
/// shows: thinking, raw lines and successful tool results are dropped, and
/// consecutive text chunks are joined into one assistant message.
pub fn parse_turns(lines: &[String]) -> Vec<Turn> {
    #[derive(Default)]
    struct Builder {
        turns: Vec<Turn>,
        text: String,
    }
    impl Builder {
        fn current(&mut self) -> &mut Turn {
            if self.turns.is_empty() {
                self.turns.push(Turn::default());
            }
            self.turns.last_mut().expect("just pushed")
        }
        fn flush(&mut self) {
            let text = std::mem::take(&mut self.text);
            if !text.trim().is_empty() {
                self.current().assistant.push(text.trim().to_string());
            }
        }
        fn user(&mut self, text: &str) {
            self.flush();
            self.turns.push(Turn {
                user: Some(text.to_string()),
                ..Turn::default()
            });
        }
    }

    let mut b = Builder::default();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let str_of =
            |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v.get("type").and_then(Value::as_str) {
            Some("verun_user_message") => {
                // Scheduled wakeups are the agent talking to itself, not the user.
                if v.get("wakeup_reason").is_none() {
                    b.user(&str_of(&v, "text"));
                }
            }
            Some("verun_items") => {
                let Some(items) = v.get("items").and_then(Value::as_array) else {
                    continue;
                };
                for item in items {
                    match item.get("kind").and_then(Value::as_str) {
                        Some("text") => b.text.push_str(&str_of(item, "text")),
                        Some("userMessage") if item.get("wakeupReason").is_none() => {
                            b.user(&str_of(item, "text"))
                        }
                        Some("transcriptUserMessage")
                            if !item.get("isMeta").and_then(Value::as_bool).unwrap_or(false) =>
                        {
                            b.user(&str_of(item, "text"))
                        }
                        Some("toolStart") => {
                            b.flush();
                            let summary =
                                tool_summary(&str_of(item, "tool"), &str_of(item, "input"));
                            b.current().tools.push(summary);
                        }
                        Some("toolResult")
                            if item
                                .get("isError")
                                .and_then(Value::as_bool)
                                .unwrap_or(false) =>
                        {
                            b.flush();
                            let text = truncate(&str_of(item, "text"), COMPACT_FIELD);
                            b.current().errors.push(format!("Tool error: {text}"));
                        }
                        Some("errorMessage") => {
                            b.flush();
                            let text = str_of(item, "message");
                            b.current().errors.push(text);
                        }
                        Some(_) | None => b.flush(),
                    }
                }
            }
            _ => {}
        }
    }
    b.flush();
    b.turns
}

fn render_turn(index: usize, turn: &Turn, field: usize, with_tools: bool) -> String {
    let mut out = format!("### Turn {}\n", index + 1);
    if let Some(user) = &turn.user {
        out.push_str(&format!("User: {}\n", truncate(user, field)));
    }
    if with_tools {
        for text in &turn.assistant {
            out.push_str(&format!("Assistant: {}\n", truncate(text, field)));
        }
        if !turn.tools.is_empty() {
            out.push_str(&format!("Tools: {}\n", turn.tools.join("; ")));
        }
    } else if let Some(last) = turn.assistant.last() {
        // Compact: the agent's final word on the turn is what matters.
        out.push_str(&format!("Assistant: {}\n", truncate(last, field)));
    }
    for e in &turn.errors {
        out.push_str(&format!("Error: {}\n", truncate(e, COMPACT_FIELD)));
    }
    out
}

/// Fit the newest turns into `budget`: in full while they fit, then compact,
/// then stop. The first turn usually holds the original ask, so it is kept
/// (compact) even when everything between it and the newest turns is dropped.
fn fit_turns(turns: &[Turn], budget: usize) -> (Vec<String>, usize) {
    let Some(last) = turns.len().checked_sub(1) else {
        return (Vec::new(), 0);
    };
    let first = if turns[0].user.is_some() && last > 0 {
        Some(render_turn(0, &turns[0], COMPACT_FIELD, false))
    } else {
        None
    };
    let mut used = first.as_ref().map_or(0, String::len);
    let mut kept: Vec<String> = Vec::new();
    let floor = usize::from(first.is_some());
    for i in (floor..=last).rev() {
        let full = render_turn(i, &turns[i], FULL_FIELD, true);
        let chunk = if used + full.len() <= budget {
            full
        } else {
            let compact = render_turn(i, &turns[i], COMPACT_FIELD, false);
            // The newest turn always goes in, however tight the budget.
            if used + compact.len() > budget && i != last {
                break;
            }
            compact
        };
        used += chunk.len();
        kept.push(chunk);
    }
    kept.reverse();
    let included = kept.len() + floor;
    let mut out = Vec::new();
    if let Some(first) = first {
        out.push(first);
    }
    let omitted = turns.len() - included;
    if omitted > 0 {
        out.push(format!(
            "[{omitted} earlier turns omitted; see the full transcript]\n"
        ));
    }
    out.extend(kept);
    (out, omitted)
}

pub fn build_packet(input: &PacketInput, budget: usize) -> Packet {
    let source = display_name(input.source_agent);
    let target = display_name(input.target_agent);
    let mut p = String::new();
    p.push_str(&format!(
        "You are taking over this task from {source}. You ({target}) are running in the same worktree, \
         so its changes are already on disk. Read the context below, check the current state of the \
         code, and continue the work. Don't redo steps that are already done.\n\n"
    ));

    p.push_str("## Task\n");
    if let Some(name) = input.task_name {
        p.push_str(&format!("Name: {name}\n"));
    }
    p.push_str(&format!("Worktree: {}\n", input.worktree_path));
    if !input.repo.branch.is_empty() {
        match &input.repo.base_branch {
            Some(base) => p.push_str(&format!("Branch: {} (base: {base})\n", input.repo.branch)),
            None => p.push_str(&format!("Branch: {}\n", input.repo.branch)),
        }
    }

    let repo = input.repo;
    if !repo.commits.is_empty() || !repo.changed_files.is_empty() {
        p.push_str("\n## Repo state\n");
        if !repo.commits.is_empty() {
            p.push_str("Commits on this branch (newest first):\n");
            for c in repo.commits.iter().take(MAX_COMMITS) {
                p.push_str(&format!("- {c}\n"));
            }
            if repo.commits.len() > MAX_COMMITS {
                p.push_str(&format!("- …{} more\n", repo.commits.len() - MAX_COMMITS));
            }
        }
        if !repo.changed_files.is_empty() {
            p.push_str(&format!(
                "Uncommitted changes ({} files):\n",
                repo.changed_files.len()
            ));
            for f in repo.changed_files.iter().take(MAX_CHANGED_FILES) {
                p.push_str(&format!("- {f}\n"));
            }
            if repo.changed_files.len() > MAX_CHANGED_FILES {
                p.push_str(&format!(
                    "- …{} more\n",
                    repo.changed_files.len() - MAX_CHANGED_FILES
                ));
            }
        }
    }

    p.push_str(&format!("\n## Conversation with {source}\n"));
    if let Some(path) = input.transcript_path {
        p.push_str(&format!(
            "Full transcript: {path} (read it if you need more than what is below)\n\n"
        ));
    }
    let (chunks, omitted) = fit_turns(input.turns, budget);
    if chunks.is_empty() {
        p.push_str("No conversation was recorded for the previous session.\n");
    }
    for c in chunks {
        p.push_str(&c);
        p.push('\n');
    }

    p.push_str(
        "## Next\nContinue from the latest request above. If it was already completed, \
         say so briefly and wait for the next instruction.\n",
    );
    Packet {
        text: p,
        included_turns: input.turns.len() - omitted,
        omitted_turns: omitted,
    }
}

/// Every turn, with tool calls, for the target agent to read on demand.
pub fn render_full_transcript(source_agent: &str, turns: &[Turn]) -> String {
    let mut out = format!(
        "# Transcript of the {} session\n\n",
        display_name(source_agent)
    );
    for (i, t) in turns.iter().enumerate() {
        out.push_str(&render_turn(i, t, usize::MAX, true));
        out.push('\n');
    }
    out
}

pub struct PreparedHandoff {
    pub session: Session,
    pub packet: Packet,
    pub transcript_path: Option<std::path::PathBuf>,
}

/// Git state of the task's worktree. Best effort: a missing worktree or a
/// failing git call leaves that part out rather than failing the handoff.
fn repo_state(task: &Task, base_branch: Option<String>) -> RepoState {
    if !task.is_git {
        return RepoState::default();
    }
    let changed_files = crate::git_ops::get_git_status(&task.worktree_path)
        .map(|status| {
            status
                .files
                .iter()
                .map(|f| {
                    let code = format!("{}{}", f.index_status, f.worktree_status);
                    format!("{} {}", code.trim(), f.path)
                })
                .collect()
        })
        .unwrap_or_default();
    let commits = base_branch
        .as_deref()
        .and_then(|base| {
            crate::git_ops::get_branch_commits(
                &task.worktree_path,
                base,
                task.merge_base_sha.as_deref(),
            )
            .ok()
        })
        .map(|cs| {
            cs.into_iter()
                .map(|c| format!("{} {}", c.short_hash, c.message))
                .collect()
        })
        .unwrap_or_default();
    RepoState {
        branch: task.branch.clone(),
        base_branch,
        changed_files,
        commits,
    }
}

/// Build the target session (not yet persisted) and its packet. The full
/// transcript is written to `<transcript_dir>/<target session id>.md`.
pub async fn prepare_handoff(
    pool: &SqlitePool,
    source_session_id: &str,
    target_agent_type: &str,
    model: Option<String>,
    account_id: Option<String>,
    transcript_dir: &Path,
) -> Result<PreparedHandoff, String> {
    if crate::agent::AgentKind::try_parse(target_agent_type).is_none() {
        return Err(format!("Unknown agent type '{target_agent_type}'"));
    }
    let source = db::get_session(pool, source_session_id)
        .await?
        .ok_or_else(|| format!("Session {source_session_id} not found"))?;
    if source.agent_type == target_agent_type {
        return Err(format!(
            "Handoff must target a different harness than the source ({}); use New Session or Fork instead",
            source.agent_type
        ));
    }
    let task = db::get_task(pool, &source.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", source.task_id))?;
    let base_branch = db::get_project(pool, &task.project_id)
        .await?
        .map(|p| p.base_branch);
    let lines: Vec<String> = db::get_output_lines(pool, &source.id, None, None)
        .await?
        .into_iter()
        .map(|l| l.line)
        .collect();
    let turns = parse_turns(&lines);

    let mut session = crate::task::new_session(
        task.id.clone(),
        target_agent_type.to_string(),
        model,
        account_id,
    );
    session.parent_session_id = Some(source.id.clone());

    let transcript = (!turns.is_empty()).then(|| {
        (
            transcript_dir.join(format!("{}.md", session.id)),
            render_full_transcript(&source.agent_type, &turns),
        )
    });
    let (repo, transcript_path) = {
        let task = task.clone();
        let dir = transcript_dir.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let path = match transcript {
                Some((path, body)) => {
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| format!("create {}: {e}", dir.display()))?;
                    std::fs::write(&path, body)
                        .map_err(|e| format!("write {}: {e}", path.display()))?;
                    Some(path)
                }
                None => None,
            };
            Ok((repo_state(&task, base_branch), path))
        })
        .await
        .map_err(|e| format!("handoff: {e}"))??
    };

    let path_str = transcript_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let packet = build_packet(
        &PacketInput {
            source_agent: &source.agent_type,
            target_agent: target_agent_type,
            task_name: task.name.as_deref(),
            worktree_path: &task.worktree_path,
            repo: &repo,
            turns: &turns,
            transcript_path: path_str.as_deref(),
        },
        INLINE_BUDGET,
    );
    Ok(PreparedHandoff {
        session,
        packet,
        transcript_path,
    })
}

/// Store the packet in the blob store as a markdown file, ready to attach.
pub async fn store_packet(
    pool: &SqlitePool,
    app_data_dir: &Path,
    source_agent: &str,
    packet: &str,
) -> Result<AttachmentRef, String> {
    const MIME: &str = "text/markdown";
    let blob = crate::blob::write_blob(pool, app_data_dir, MIME, packet.as_bytes()).await?;
    Ok(AttachmentRef {
        hash: blob.hash,
        mime_type: MIME.into(),
        name: format!("Handoff from {}.md", display_name(source_agent)),
        size: blob.size,
    })
}

/// Create the handoff session for real: resolve its account the way a new
/// session's is, persist it, and tell every window. The packet is returned
/// for the caller to draft (UI) or send (MCP); it is not stored.
pub async fn create_session_handoff(
    app: &AppHandle,
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    source_session_id: &str,
    target_agent_type: &str,
    model: Option<String>,
    account: Option<&AccountSelection>,
) -> Result<SessionHandoff, String> {
    let source = db::get_session(pool, source_session_id)
        .await?
        .ok_or_else(|| format!("Session {source_session_id} not found"))?;
    let task = db::get_task(pool, &source.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", source.task_id))?;
    let account_id =
        resolve_new_session_account(pool, &task.project_id, target_agent_type, account)
            .await
            .map_err(|e| e.to_ipc())?;
    let app_data_dir = app.state::<crate::blob::AppDataDir>().0.clone();
    let dir = app_data_dir.join("handoffs");
    let prepared = prepare_handoff(
        pool,
        source_session_id,
        target_agent_type,
        model,
        account_id,
        &dir,
    )
    .await?;
    let attachment = store_packet(
        pool,
        &app_data_dir,
        &source.agent_type,
        &prepared.packet.text,
    )
    .await?;
    db_tx
        .send(db::DbWrite::CreateSession(prepared.session.clone()))
        .await
        .map_err(|e| format!("DB write failed: {e}"))?;
    let _ = app.emit("session-created", &prepared.session);
    Ok(SessionHandoff {
        session: prepared.session,
        attachment,
        packet: prepared.packet.text,
        included_turns: prepared.packet.included_turns,
        omitted_turns: prepared.packet.omitted_turns,
        transcript_path: prepared
            .transcript_path
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> String {
        json!({"type": "verun_user_message", "text": text, "attachments": []}).to_string()
    }

    fn items(items: Value) -> String {
        json!({"type": "verun_items", "items": items}).to_string()
    }

    fn repo() -> RepoState {
        RepoState {
            branch: "brave-otter-12".into(),
            base_branch: Some("main".into()),
            changed_files: vec!["M src/lib.rs".into(), "?? src/new.rs".into()],
            commits: vec!["abc1234 Add parser".into()],
        }
    }

    fn input<'a>(repo: &'a RepoState, turns: &'a [Turn]) -> PacketInput<'a> {
        PacketInput {
            source_agent: "claude",
            target_agent: "codex",
            task_name: Some("Fix the parser"),
            worktree_path: "/tmp/wt",
            repo,
            turns,
            transcript_path: Some("/data/handoffs/s-2.md"),
        }
    }

    #[test]
    fn parse_turns_groups_user_assistant_and_tools() {
        let lines = vec![
            user("fix the bug"),
            items(json!([
                {"kind": "thinking", "text": "secret reasoning"},
                {"kind": "text", "text": "Looking at it."},
                {"kind": "toolStart", "tool": "Edit", "input": "{\"file_path\":\"src/lib.rs\"}"},
                {"kind": "toolResult", "text": "ok", "isError": false},
                {"kind": "toolResult", "text": "boom", "isError": true},
                {"kind": "raw", "text": "noise"},
            ])),
            items(json!([{"kind": "text", "text": "Done."}])),
            user("now add a test"),
            items(json!([{"kind": "errorMessage", "message": "overloaded", "raw": null}])),
        ];
        let turns = parse_turns(&lines);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].user.as_deref(), Some("fix the bug"));
        assert_eq!(turns[0].assistant, vec!["Looking at it.", "Done."]);
        assert_eq!(turns[0].tools.len(), 1);
        assert!(turns[0].tools[0].contains("Edit"));
        assert!(turns[0].tools[0].contains("src/lib.rs"));
        assert_eq!(turns[0].errors, vec!["Tool error: boom"]);
        assert_eq!(turns[1].user.as_deref(), Some("now add a test"));
        assert_eq!(turns[1].errors, vec!["overloaded"]);
        let all = format!("{turns:?}");
        assert!(!all.contains("secret reasoning"));
        assert!(!all.contains("noise"));
    }

    #[test]
    fn parse_turns_reads_external_and_transcript_user_messages_but_skips_meta() {
        let lines = vec![
            items(
                json!([{"kind": "transcriptUserMessage", "text": "from terminal", "isMeta": false}]),
            ),
            items(json!([{"kind": "text", "text": "a"}])),
            items(
                json!([{"kind": "transcriptUserMessage", "text": "<synthetic>", "isMeta": true}]),
            ),
            items(json!([{"kind": "userMessage", "text": "from mcp", "timestamp": 1}])),
            "not json at all".to_string(),
        ];
        let turns = parse_turns(&lines);
        let users: Vec<_> = turns.iter().filter_map(|t| t.user.as_deref()).collect();
        assert_eq!(users, vec!["from terminal", "from mcp"]);
    }

    #[test]
    fn parse_turns_keeps_assistant_output_before_any_user_message() {
        let lines = vec![items(json!([{"kind": "text", "text": "orphan"}]))];
        let turns = parse_turns(&lines);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].user, None);
        assert_eq!(turns[0].assistant, vec!["orphan"]);
    }

    #[test]
    fn packet_carries_providers_repo_state_transcript_and_instruction() {
        let repo = repo();
        let turns = vec![Turn {
            user: Some("fix the bug".into()),
            assistant: vec!["Fixed in src/lib.rs".into()],
            tools: vec!["Edit src/lib.rs".into()],
            errors: vec![],
        }];
        let p = build_packet(&input(&repo, &turns), 20_000);
        for needle in [
            "Claude Code",
            "Codex",
            "Fix the parser",
            "/tmp/wt",
            "brave-otter-12",
            "main",
            "abc1234 Add parser",
            "M src/lib.rs",
            "?? src/new.rs",
            "/data/handoffs/s-2.md",
            "fix the bug",
            "Fixed in src/lib.rs",
            "Edit src/lib.rs",
        ] {
            assert!(
                p.text.contains(needle),
                "packet missing {needle:?}:\n{}",
                p.text
            );
        }
        assert_eq!(p.included_turns, 1);
        assert_eq!(p.omitted_turns, 0);
        assert!(!p.text.contains("omitted"));
    }

    #[test]
    fn packet_without_transcript_still_describes_the_task() {
        let repo = RepoState::default();
        let p = build_packet(
            &PacketInput {
                transcript_path: None,
                ..input(&repo, &[])
            },
            20_000,
        );
        assert!(p.text.contains("/tmp/wt"));
        assert!(p.text.contains("No conversation was recorded"));
        assert_eq!(p.included_turns, 0);
        assert_eq!(p.omitted_turns, 0);
    }

    #[test]
    fn packet_over_budget_keeps_newest_turns_and_original_request() {
        let repo = repo();
        let mut turns: Vec<Turn> = (0..30)
            .map(|i| Turn {
                user: Some(format!("request {i}")),
                assistant: vec![format!("answer {i} {}", "x".repeat(800))],
                tools: vec![],
                errors: vec![],
            })
            .collect();
        turns[0].user = Some("ORIGINAL ASK".into());
        let p = build_packet(&input(&repo, &turns), 6_000);
        assert!(p.text.contains("request 29"), "newest turn must be kept");
        assert!(
            p.text.contains("ORIGINAL ASK"),
            "first request must be kept"
        );
        assert!(p.omitted_turns > 0);
        assert_eq!(p.included_turns + p.omitted_turns, 30);
        assert!(p
            .text
            .contains(&format!("{} earlier turns omitted", p.omitted_turns)));
        // Budget applies to the conversation section; framing adds a little.
        assert!(p.text.len() < 6_000 + 3_000, "len {}", p.text.len());
    }

    #[test]
    fn packet_caps_changed_files() {
        let repo = RepoState {
            changed_files: (0..45).map(|i| format!("M f{i}.rs")).collect(),
            ..repo()
        };
        let p = build_packet(&input(&repo, &[]), 20_000);
        assert!(p.text.contains("M f19.rs"));
        assert!(!p.text.contains("M f20.rs"));
        assert!(p.text.contains("25 more"));
    }

    #[test]
    fn full_transcript_contains_every_turn() {
        let turns: Vec<Turn> = (0..50)
            .map(|i| Turn {
                user: Some(format!("request {i}")),
                assistant: vec![format!("answer {i}")],
                tools: vec![format!("Bash cmd {i}")],
                errors: vec![],
            })
            .collect();
        let t = render_full_transcript("claude", &turns);
        assert!(t.contains("request 0") && t.contains("request 49"));
        assert!(t.contains("Bash cmd 7"));
        assert!(t.contains("Claude Code"));
    }

    mod prepare {
        use super::super::*;
        use crate::db::tests::{make_project, make_session, make_task, test_pool};
        use crate::db::{process_write, DbWrite};
        use serde_json::json;

        async fn seeded(lines: Vec<String>) -> sqlx::SqlitePool {
            let pool = test_pool().await;
            process_write(&pool, DbWrite::InsertProject(make_project()))
                .await
                .unwrap();
            process_write(&pool, DbWrite::InsertTask(make_task("p-001")))
                .await
                .unwrap();
            process_write(&pool, DbWrite::CreateSession(make_session("t-001")))
                .await
                .unwrap();
            let lines = lines.into_iter().map(|l| (l, 1)).collect();
            process_write(
                &pool,
                DbWrite::InsertOutputLines {
                    session_id: "s-001".into(),
                    lines,
                },
            )
            .await
            .unwrap();
            pool
        }

        fn conversation() -> Vec<String> {
            vec![
                json!({"type": "verun_user_message", "text": "add retries"}).to_string(),
                json!({"type": "verun_items", "items": [{"kind": "text", "text": "Added retries to fetch."}]}).to_string(),
            ]
        }

        #[tokio::test]
        async fn target_session_is_a_linked_child_on_the_other_harness() {
            let pool = seeded(conversation()).await;
            let dir = tempfile::tempdir().unwrap();
            let h = prepare_handoff(
                &pool,
                "s-001",
                "codex",
                Some("gpt-5".into()),
                Some("acct".into()),
                dir.path(),
            )
            .await
            .unwrap();
            let s = &h.session;
            assert_ne!(s.id, "s-001");
            assert_eq!(s.task_id, "t-001");
            assert_eq!(s.agent_type, "codex");
            assert_eq!(s.model.as_deref(), Some("gpt-5"));
            assert_eq!(s.account_id.as_deref(), Some("acct"));
            assert_eq!(s.parent_session_id.as_deref(), Some("s-001"));
            assert_eq!(
                s.forked_at_message_uuid, None,
                "a handoff has no fork point"
            );
            assert_eq!(s.resume_session_id, None);
            assert_eq!(s.status, "idle");
        }

        #[tokio::test]
        async fn packet_and_transcript_file_carry_the_conversation() {
            let pool = seeded(conversation()).await;
            let dir = tempfile::tempdir().unwrap();
            let h = prepare_handoff(&pool, "s-001", "gemini", None, None, dir.path())
                .await
                .unwrap();
            let path = h.transcript_path.clone().expect("transcript written");
            assert!(path.starts_with(dir.path()));
            assert!(path.to_string_lossy().contains(&h.session.id));
            let file = std::fs::read_to_string(&path).unwrap();
            assert!(file.contains("add retries") && file.contains("Added retries to fetch."));
            assert!(h.packet.text.contains("add retries"));
            assert!(h.packet.text.contains(&*path.to_string_lossy()));
            assert!(h.packet.text.contains("Gemini CLI"));
            assert_eq!(h.packet.included_turns, 1);
        }

        #[tokio::test]
        async fn empty_source_writes_no_transcript_but_still_drafts() {
            let pool = seeded(vec![]).await;
            let dir = tempfile::tempdir().unwrap();
            let h = prepare_handoff(&pool, "s-001", "codex", None, None, dir.path())
                .await
                .unwrap();
            assert!(h.transcript_path.is_none());
            assert!(h.packet.text.contains("No conversation was recorded"));
        }

        #[tokio::test]
        async fn packet_is_stored_as_a_markdown_attachment() {
            let pool = seeded(vec![]).await;
            let dir = tempfile::tempdir().unwrap();
            let r = store_packet(&pool, dir.path(), "claude", "# Packet\nbody")
                .await
                .unwrap();
            assert_eq!(r.mime_type, "text/markdown");
            assert_eq!(r.name, "Handoff from Claude Code.md");
            assert_eq!(r.size, 13);
            let bytes = crate::blob::read_blob_bytes(dir.path(), &r.hash)
                .await
                .unwrap();
            assert_eq!(bytes, b"# Packet\nbody");
        }

        #[tokio::test]
        async fn same_harness_is_rejected() {
            let pool = seeded(vec![]).await;
            let dir = tempfile::tempdir().unwrap();
            let err = prepare_handoff(&pool, "s-001", "claude", None, None, dir.path())
                .await
                .err()
                .unwrap();
            assert!(err.contains("different harness"), "{err}");
        }

        #[tokio::test]
        async fn unknown_harness_and_session_are_rejected() {
            let pool = seeded(vec![]).await;
            let dir = tempfile::tempdir().unwrap();
            let err = prepare_handoff(&pool, "s-001", "nope", None, None, dir.path())
                .await
                .err()
                .unwrap();
            assert!(err.contains("nope"), "{err}");
            let err = prepare_handoff(&pool, "s-missing", "codex", None, None, dir.path())
                .await
                .err()
                .unwrap();
            assert!(err.contains("s-missing"), "{err}");
        }
    }
}
