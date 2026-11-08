//! Claude Code sessions started outside Verun (plain `claude` in a terminal)
//! for a task's folder, so they can be continued inside Verun.
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutsideSession {
    pub agent_type: String,
    pub resume_id: String,
    pub title: String,
    pub updated_at: i64,
    /// Folder the session ran in; differs from the task's when it ran in the repo root.
    pub source_cwd: String,
    pub account_id: Option<String>,
}

/// List resumable sessions in one Claude projects folder, skipping ids Verun already tracks.
pub fn scan_claude_dir(
    dir: &Path,
    known: &HashSet<String>,
    source_cwd: &str,
    account_id: Option<&str>,
) -> Vec<OutsideSession> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() || known.contains(id) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(title) = transcript_title(&text) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        found.push(OutsideSession {
            agent_type: "claude".into(),
            resume_id: id.to_string(),
            title,
            updated_at,
            source_cwd: source_cwd.to_string(),
            account_id: account_id.map(str::to_string),
        });
    }
    found
}

/// A summary if Claude wrote one, else the first real prompt. `None` when the
/// transcript has no user prompt at all (nothing to continue).
fn transcript_title(text: &str) -> Option<String> {
    let mut summary = None;
    let mut first_prompt = None;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v["type"].as_str() {
            Some("summary") if summary.is_none() => {
                summary = v["summary"].as_str().map(str::to_string);
            }
            Some("user") if first_prompt.is_none() && v["isMeta"] != true => {
                let content = &v["message"]["content"];
                let text = content.as_str().map(str::to_string).or_else(|| {
                    content.as_array().and_then(|parts| {
                        parts
                            .iter()
                            .find(|p| p["type"] == "text")
                            .and_then(|p| p["text"].as_str())
                            .map(str::to_string)
                    })
                });
                // Slash commands and hook output are wrapped in <tags>; they aren't prompts.
                if let Some(t) = text.map(|t| t.trim().to_string()) {
                    if !t.is_empty() && !t.starts_with('<') {
                        first_prompt = Some(t);
                    }
                }
            }
            _ => {}
        }
    }
    let has_prompt = first_prompt.is_some() || text.lines().any(|l| l.contains("\"type\":\"user\""));
    if !has_prompt {
        return None;
    }
    let title = summary.or(first_prompt)?;
    let line = title.lines().next().unwrap_or("").trim();
    Some(line.chars().take(80).collect())
}

/// Make the transcript resumable from `to_cwd` and return its conversation as chat items.
pub fn adopt_claude_transcript(
    home: &crate::claude_home::ClaudeHome,
    from_cwd: &Path,
    to_cwd: &Path,
    resume_id: &str,
) -> Result<Vec<crate::stream::OutputItem>, String> {
    uuid::Uuid::parse_str(resume_id).map_err(|_| "Not a Claude session id".to_string())?;
    let source = crate::claude_home::transcript_in(&home.projects_dir(from_cwd), resume_id);
    let text = std::fs::read_to_string(&source)
        .map_err(|e| format!("Can't read the session transcript: {e}"))?;
    if from_cwd != to_cwd {
        // Claude resumes only transcripts filed under the current folder.
        let dest_dir = home.projects_dir(to_cwd);
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = crate::claude_home::transcript_in(&dest_dir, resume_id);
        if !dest.exists() {
            std::fs::copy(&source, &dest).map_err(|e| format!("Can't copy the transcript: {e}"))?;
        }
    }
    Ok(text
        .lines()
        .flat_map(crate::claude_jsonl::parse_transcript_line)
        .collect())
}

/// Folders whose outside sessions belong to a task: its own, and for a worktree
/// task also the project's main checkout, where `claude` is usually run by hand.
fn task_folders(task: &crate::db::Task, project: &crate::db::Project) -> Vec<String> {
    let mut folders = vec![task.worktree_path.clone()];
    if project.repo_path != task.worktree_path {
        folders.push(project.repo_path.clone());
    }
    folders
}

async fn claude_homes(
    pool: &sqlx::SqlitePool,
) -> Vec<(Option<String>, crate::claude_home::ClaudeHome)> {
    let mut homes = Vec::new();
    if let Some(home) = crate::claude_home::process_default() {
        homes.push((None, home));
    }
    for account in crate::db::list_accounts(pool).await.unwrap_or_default() {
        if account.agent_type == "claude" && account.removed_at.is_none() {
            if let Ok(home) = crate::claude_home::for_account(pool, Some(&account.id)).await {
                homes.push((Some(account.id), home));
            }
        }
    }
    homes
}

async fn task_and_project(
    pool: &sqlx::SqlitePool,
    task_id: &str,
) -> Result<(crate::db::Task, crate::db::Project), String> {
    let task = crate::db::get_task(pool, task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let project = crate::db::get_project(pool, &task.project_id)
        .await?
        .ok_or_else(|| format!("Project {} not found", task.project_id))?;
    Ok((task, project))
}

/// Newest first, across the Default and added Claude accounts.
pub async fn list_for_task(
    pool: &sqlx::SqlitePool,
    task_id: &str,
) -> Result<Vec<OutsideSession>, String> {
    let (task, project) = task_and_project(pool, task_id).await?;
    let known: HashSet<String> = crate::db::list_resume_session_ids(pool)
        .await?
        .into_iter()
        .collect();
    let homes = claude_homes(pool).await;
    let folders = task_folders(&task, &project);
    let mut found = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        for (account, home) in &homes {
            for folder in &folders {
                let dir = home.projects_dir(Path::new(folder));
                found.extend(scan_claude_dir(&dir, &known, folder, account.as_deref()));
            }
        }
        found
    })
    .await
    .map_err(|e| e.to_string())?;
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found.dedup_by(|a, b| a.resume_id == b.resume_id);
    found.truncate(50);
    Ok(found)
}

/// Continue an outside session as a new Verun session in the task, with its history.
pub async fn adopt(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    db_tx: &crate::db::DbWriteTx,
    task_id: &str,
    session: &OutsideSession,
) -> Result<crate::db::Session, String> {
    use tauri::{Emitter, Manager};
    let (task, project) = task_and_project(pool, task_id).await?;
    // Only the folders this task owns; never an arbitrary path from the UI.
    if !task_folders(&task, &project).contains(&session.source_cwd) {
        return Err("That session isn't from this task's folders".into());
    }
    let home = crate::claude_home::for_account(pool, session.account_id.as_deref()).await?;
    let (from, to, id) = (
        session.source_cwd.clone(),
        task.worktree_path.clone(),
        session.resume_id.clone(),
    );
    let items = tokio::task::spawn_blocking(move || {
        adopt_claude_transcript(&home, Path::new(&from), Path::new(&to), &id)
    })
    .await
    .map_err(|e| e.to_string())??;
    let now = crate::task::epoch_ms();
    let mut created = crate::task::new_session(
        task.id.clone(),
        "claude".into(),
        None,
        session.account_id.clone(),
    );
    created.resume_session_id = Some(session.resume_id.clone());
    created.name = Some(session.title.clone());
    let data_dir = app.state::<crate::blob::AppDataDir>().0.clone();
    let lines = crate::claude_terminal::build_persist_lines(
        pool,
        &data_dir,
        crate::claude_terminal::partition_tail_batch(&items),
    )
    .await;
    let (done, received) = tokio::sync::oneshot::channel();
    db_tx
        .send(crate::db::DbWrite::InsertSessionWithLines {
            session: Box::new(created.clone()),
            lines: lines.into_iter().map(|l| (l, now)).collect(),
            done,
        })
        .await
        .map_err(|e| e.to_string())?;
    received.await.map_err(|e| e.to_string())??;
    let _ = app.emit("session-created", &created);
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_home::ClaudeHome;
    use std::fs;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";

    fn user(text: &str) -> String {
        serde_json::json!({"type":"user","message":{"role":"user","content":text},"sessionId":A}).to_string()
    }
    fn assistant(text: &str) -> String {
        serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]},"sessionId":A}).to_string()
    }

    #[test]
    fn lists_unknown_sessions_with_a_readable_title_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(format!("{A}.jsonl")), [user("<command-name>/clear</command-name>"), user("Fix the flaky login test"), assistant("On it")].join("\n")).unwrap();
        let summary = serde_json::json!({"type":"summary","summary":"Login test cleanup"}).to_string();
        fs::write(dir.path().join(format!("{B}.jsonl")), [summary, user("hello")].join("\n")).unwrap();
        // Already tracked by Verun, and one with no user message: both hidden.
        fs::write(dir.path().join(format!("{C}.jsonl")), user("tracked")).unwrap();
        fs::write(dir.path().join("44444444-4444-4444-8444-444444444444.jsonl"), assistant("no prompt")).unwrap();
        fs::write(dir.path().join("notes.txt"), "x").unwrap();

        let known = HashSet::from([C.to_string()]);
        let mut found = scan_claude_dir(dir.path(), &known, "/repo", Some("acct"));
        found.sort_by(|a, b| a.resume_id.cmp(&b.resume_id));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].title, "Fix the flaky login test");
        assert_eq!(found[1].title, "Login test cleanup");
        assert_eq!(found[0].source_cwd, "/repo");
        assert_eq!(found[0].account_id.as_deref(), Some("acct"));
        assert_eq!(found[0].agent_type, "claude");
    }

    #[test]
    fn missing_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan_claude_dir(&dir.path().join("nope"), &HashSet::new(), "/repo", None).is_empty());
    }

    #[test]
    fn adopting_from_the_repo_root_copies_the_transcript_into_the_task_folder() {
        let root = tempfile::tempdir().unwrap();
        let home = ClaudeHome::for_config_dir(root.path().join(".claude"));
        let (repo, wt) = (root.path().join("repo"), root.path().join("wt"));
        let src = home.projects_dir(&repo);
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join(format!("{A}.jsonl")), [user("Fix it"), assistant("Done")].join("\n")).unwrap();

        let items = adopt_claude_transcript(&home, &repo, &wt, A).unwrap();
        assert!(!items.is_empty());
        let copied = home.projects_dir(&wt).join(format!("{A}.jsonl"));
        assert!(copied.exists(), "transcript must be resumable from the task folder");
        assert!(src.join(format!("{A}.jsonl")).exists(), "the original stays put");
    }

    #[test]
    fn adopting_in_place_needs_no_copy_and_rejects_bad_ids() {
        let root = tempfile::tempdir().unwrap();
        let home = ClaudeHome::for_config_dir(root.path().join(".claude"));
        let repo = root.path().join("repo");
        fs::create_dir_all(home.projects_dir(&repo)).unwrap();
        fs::write(home.projects_dir(&repo).join(format!("{A}.jsonl")), user("Hi")).unwrap();
        assert!(adopt_claude_transcript(&home, &repo, &repo, A).is_ok());
        assert!(adopt_claude_transcript(&home, &repo, &repo, "../../etc/passwd").is_err());
    }
}
