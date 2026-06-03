//! Scheduled session wakeups (issue #230).
//!
//! When the Claude model calls the `ScheduleWakeup` tool, it asks Verun to
//! resume the same session with a follow-up prompt after a delay. The CLI
//! cannot do this on its own — it exits at the end of every turn — so Verun
//! records the request in `scheduled_wakeups`, then a background scheduler
//! fires due rows by routing them through `task::send_message`.

use crate::db::{self, DbWrite, DbWriteTx, ScheduledWakeup};
use crate::stream::OutputItem;
use sqlx::SqlitePool;
use std::future::Future;
use std::time::Duration;
use uuid::Uuid;

/// How often the scheduler polls for due wakeups. Five seconds is enough
/// resolution for follow-ups the model schedules in minutes-to-an-hour
/// without burning CPU on idle wakeups.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The tool name the model uses when calling `ScheduleWakeup`. Kept in one
/// place so the stream parser and the tests stay in sync.
pub const SCHEDULE_WAKEUP_TOOL: &str = "ScheduleWakeup";

/// The three fields Verun cares about from a `ScheduleWakeup` tool call.
/// `reason` is informational only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeupRequest {
    pub delay_seconds: i64,
    pub prompt: String,
    pub reason: Option<String>,
}

/// Parse the JSON `input` of a `ScheduleWakeup` tool call. Returns `None` if
/// either required field (`delaySeconds`, `prompt`) is missing or the wrong
/// shape, so callers can drop the call rather than scheduling garbage.
pub fn parse_schedule_wakeup_input(input_str: &str) -> Option<WakeupRequest> {
    if input_str.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(input_str).ok()?;
    let delay_seconds = v.get("delaySeconds").and_then(|x| x.as_i64())?;
    if delay_seconds < 0 {
        return None;
    }
    let prompt = v.get("prompt").and_then(|x| x.as_str())?;
    if prompt.is_empty() {
        return None;
    }
    let reason = v
        .get("reason")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(WakeupRequest {
        delay_seconds,
        prompt: prompt.to_string(),
        reason,
    })
}

/// Build a `ScheduledWakeup` row for a parsed request scheduled `now_ms`
/// against `session_id`. The `id` is a fresh UUID; `fire_at` is
/// `now_ms + delay_seconds * 1000`.
pub fn build_scheduled_wakeup(
    session_id: &str,
    req: &WakeupRequest,
    now_ms: i64,
) -> ScheduledWakeup {
    ScheduledWakeup {
        id: format!("wakeup-{}", Uuid::new_v4()),
        session_id: session_id.to_string(),
        prompt: req.prompt.clone(),
        reason: req.reason.clone(),
        fire_at: now_ms + req.delay_seconds.saturating_mul(1000),
        created_at: now_ms,
        fired_at: None,
    }
}

/// Extract a `ScheduledWakeup` from a stream item if and only if it is a
/// `ToolStart` for `ScheduleWakeup` with a parseable input payload. Returns
/// `None` for any other tool or malformed input, so the caller can apply
/// this to every item in a stream and only act on matches.
pub fn wakeup_from_tool_start(
    session_id: &str,
    item: &OutputItem,
    now_ms: i64,
) -> Option<ScheduledWakeup> {
    let (tool, input) = match item {
        OutputItem::ToolStart { tool, input } => (tool.as_str(), input.as_str()),
        _ => return None,
    };
    if tool != SCHEDULE_WAKEUP_TOOL {
        return None;
    }
    let req = parse_schedule_wakeup_input(input)?;
    Some(build_scheduled_wakeup(session_id, &req, now_ms))
}

/// Fire every wakeup whose `fire_at <= now_ms` and whose `fired_at IS NULL`.
/// For each due row we (1) mark it fired in the DB, then (2) hand the
/// prompt+reason off to `send`. Marking before sending is intentional - if
/// `send` fails the user can still see what was attempted, and we never
/// re-fire on the next tick (which would double-prompt the model).
pub async fn process_due_wakeups<F, Fut>(
    pool: &SqlitePool,
    db_tx: &DbWriteTx,
    now_ms: i64,
    mut send: F,
) -> Result<(), String>
where
    F: FnMut(String, String, Option<String>) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let due = db::list_due_wakeups(pool, now_ms).await?;
    for w in due {
        let _ = db_tx
            .send(DbWrite::MarkWakeupFired {
                id: w.id.clone(),
                fired_at: now_ms,
            })
            .await;
        if let Err(e) = send(w.session_id.clone(), w.prompt.clone(), w.reason.clone()).await {
            eprintln!(
                "[verun] wakeup {} for session {}: send failed: {e}",
                w.id, w.session_id
            );
        }
    }
    Ok(())
}

/// Spawned at app startup. Polls the DB on a fixed interval and dispatches
/// every due wakeup as a fresh user message to the original session via
/// `task::send_message`. Runs forever; errors per-wakeup are logged and
/// swallowed so one broken row can't stall the rest.
pub async fn run_scheduler(pool: SqlitePool, db_tx: DbWriteTx, app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let now = epoch_ms();
        if let Err(e) = process_due_wakeups(&pool, &db_tx, now, |sid, prompt, reason| {
            let app = app.clone();
            async move { fire_wakeup(&app, &sid, &prompt, reason).await }
        })
        .await
        {
            eprintln!("[verun] wakeup scheduler tick failed: {e}");
        }
    }
}

/// Resume `session_id` by feeding `prompt` to `task::send_message` exactly
/// the way the MCP `verun_send_message` tool does. Marked `external = true`
/// so the live view picks up the synthesised user message even though no UI
/// optimistically inserted it. `wakeup_reason` is threaded through so the
/// chat renders a wakeup marker rather than a green user bubble.
async fn fire_wakeup(
    app: &tauri::AppHandle,
    session_id: &str,
    prompt: &str,
    reason: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;

    let pool = app.state::<SqlitePool>();
    let db_tx = app.state::<DbWriteTx>();
    let active = app.state::<crate::task::ActiveMap>();
    let pending = app.state::<crate::task::PendingApprovals>();
    let pending_meta = app.state::<crate::task::PendingApprovalMeta>();
    let pending_ctrl = app.state::<crate::task::PendingControlResponses>();

    let session = db::get_session(pool.inner(), session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    let task = db::get_task(pool.inner(), &session.task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", session.task_id))?;
    let (trust_result, repo_result) = tokio::join!(
        db::get_trust_level(pool.inner(), &session.task_id),
        db::get_repo_path_for_task(pool.inner(), &session.task_id),
    );
    let trust_level = crate::policy::TrustLevel::from_str(&trust_result?);
    let repo_path = repo_result?;

    crate::task::send_message(
        app.clone(),
        db_tx.inner(),
        active.inner().clone(),
        pending.inner().clone(),
        pending_meta.inner().clone(),
        pending_ctrl.inner().clone(),
        crate::task::SendMessageParams {
            session_id: session.id.clone(),
            task_id: session.task_id.clone(),
            project_id: task.project_id,
            worktree_path: task.worktree_path,
            repo_path,
            port_offset: task.port_offset,
            trust_level,
            message: prompt.to_string(),
            resume_session_id: session.resume_session_id,
            attachments: Vec::new(),
            model: None,
            plan_mode: false,
            thinking_mode: false,
            fast_mode: false,
            task_name: task.name,
            agent_type: session.agent_type,
            external: true,
            wakeup_reason: Some(reason.unwrap_or_default()),
        },
    )
    .await
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_schedule_wakeup_extracts_all_fields() {
        let input =
            r#"{"delaySeconds":120,"prompt":"check the build","reason":"polling CI"}"#;
        let req = parse_schedule_wakeup_input(input).unwrap();
        assert_eq!(req.delay_seconds, 120);
        assert_eq!(req.prompt, "check the build");
        assert_eq!(req.reason.as_deref(), Some("polling CI"));
    }

    #[test]
    fn parse_schedule_wakeup_allows_missing_reason() {
        let input = r#"{"delaySeconds":60,"prompt":"hi"}"#;
        let req = parse_schedule_wakeup_input(input).unwrap();
        assert_eq!(req.delay_seconds, 60);
        assert_eq!(req.prompt, "hi");
        assert!(req.reason.is_none());
    }

    #[test]
    fn parse_schedule_wakeup_rejects_missing_prompt() {
        let input = r#"{"delaySeconds":60,"reason":"r"}"#;
        assert!(parse_schedule_wakeup_input(input).is_none());
    }

    #[test]
    fn parse_schedule_wakeup_rejects_missing_delay() {
        let input = r#"{"prompt":"hi"}"#;
        assert!(parse_schedule_wakeup_input(input).is_none());
    }

    #[test]
    fn parse_schedule_wakeup_rejects_empty_prompt() {
        let input = r#"{"delaySeconds":60,"prompt":""}"#;
        assert!(parse_schedule_wakeup_input(input).is_none());
    }

    #[test]
    fn parse_schedule_wakeup_rejects_negative_delay() {
        let input = r#"{"delaySeconds":-10,"prompt":"hi"}"#;
        assert!(parse_schedule_wakeup_input(input).is_none());
    }

    #[test]
    fn parse_schedule_wakeup_rejects_blank_input() {
        assert!(parse_schedule_wakeup_input("").is_none());
        assert!(parse_schedule_wakeup_input("not json").is_none());
    }

    #[test]
    fn wakeup_from_tool_start_returns_some_for_schedule_wakeup() {
        let item = OutputItem::ToolStart {
            tool: "ScheduleWakeup".into(),
            input: r#"{"delaySeconds":60,"prompt":"hi","reason":"r"}"#.into(),
        };
        let w = wakeup_from_tool_start("s-001", &item, 1_000).unwrap();
        assert_eq!(w.session_id, "s-001");
        assert_eq!(w.prompt, "hi");
        assert_eq!(w.reason.as_deref(), Some("r"));
        assert_eq!(w.fire_at, 1_000 + 60 * 1000);
    }

    #[test]
    fn wakeup_from_tool_start_ignores_other_tools() {
        let item = OutputItem::ToolStart {
            tool: "Bash".into(),
            input: r#"{"command":"ls"}"#.into(),
        };
        assert!(wakeup_from_tool_start("s-001", &item, 1_000).is_none());
    }

    #[test]
    fn wakeup_from_tool_start_ignores_non_tool_items() {
        let item = OutputItem::Text {
            text: "hello".into(),
        };
        assert!(wakeup_from_tool_start("s-001", &item, 1_000).is_none());
    }

    #[test]
    fn wakeup_from_tool_start_ignores_malformed_input() {
        let item = OutputItem::ToolStart {
            tool: "ScheduleWakeup".into(),
            input: r#"{"prompt":"missing delay"}"#.into(),
        };
        assert!(wakeup_from_tool_start("s-001", &item, 1_000).is_none());
    }

    #[test]
    fn build_scheduled_wakeup_computes_fire_at() {
        let req = WakeupRequest {
            delay_seconds: 60,
            prompt: "p".into(),
            reason: None,
        };
        let w = build_scheduled_wakeup("s-001", &req, 1_000_000);
        assert_eq!(w.session_id, "s-001");
        assert_eq!(w.prompt, "p");
        assert_eq!(w.fire_at, 1_000_000 + 60 * 1000);
        assert_eq!(w.created_at, 1_000_000);
        assert!(w.fired_at.is_none());
        assert!(w.id.starts_with("wakeup-"));
    }

    use crate::db::tests::{make_project, make_session, make_task, test_pool};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    async fn seed_session(pool: &SqlitePool) -> DbWriteTx {
        let tx = db::spawn_write_queue(pool.clone());
        tx.send(DbWrite::InsertProject(make_project())).await.unwrap();
        tx.send(DbWrite::InsertTask(make_task("p-001"))).await.unwrap();
        tx.send(DbWrite::CreateSession(make_session("t-001")))
            .await
            .unwrap();
        // Wait briefly for the writes to drain so subsequent inserts pass FK.
        for _ in 0..20 {
            if db::get_session(pool, "s-001").await.unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tx
    }

    fn make_wakeup(id: &str, fire_at: i64, fired_at: Option<i64>) -> ScheduledWakeup {
        ScheduledWakeup {
            id: id.into(),
            session_id: "s-001".into(),
            prompt: format!("prompt for {id}"),
            reason: None,
            fire_at,
            created_at: 100,
            fired_at,
        }
    }

    #[tokio::test]
    async fn list_due_wakeups_returns_only_unfired_past() {
        let pool = test_pool().await;
        let tx = seed_session(&pool).await;

        tx.send(DbWrite::InsertScheduledWakeup(make_wakeup(
            "w-past", 1_000, None,
        )))
        .await
        .unwrap();
        tx.send(DbWrite::InsertScheduledWakeup(make_wakeup(
            "w-future", 5_000, None,
        )))
        .await
        .unwrap();
        tx.send(DbWrite::InsertScheduledWakeup(make_wakeup(
            "w-fired",
            1_500,
            Some(1_600),
        )))
        .await
        .unwrap();
        for _ in 0..20 {
            if db::list_due_wakeups(&pool, 2_000).await.unwrap().len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let due = db::list_due_wakeups(&pool, 2_000).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "w-past");
    }

    #[tokio::test]
    async fn process_due_wakeups_invokes_send_and_marks_fired() {
        let pool = test_pool().await;
        let tx = seed_session(&pool).await;
        tx.send(DbWrite::InsertScheduledWakeup(make_wakeup(
            "w-due", 1_000, None,
        )))
        .await
        .unwrap();
        for _ in 0..20 {
            if db::list_due_wakeups(&pool, 2_000).await.unwrap().len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let calls: Arc<Mutex<Vec<(String, String, Option<String>)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let calls_c = calls.clone();
        process_due_wakeups(&pool, &tx, 2_000, move |sid, prompt, reason| {
            let calls_c = calls_c.clone();
            async move {
                calls_c.lock().await.push((sid, prompt, reason));
                Ok(())
            }
        })
        .await
        .unwrap();

        let c = calls.lock().await;
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].0, "s-001");
        assert_eq!(c[0].1, "prompt for w-due");
        assert!(c[0].2.is_none());
        drop(c);

        // After firing, the same `now` should yield no more due wakeups.
        for _ in 0..20 {
            if db::list_due_wakeups(&pool, 2_000).await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(db::list_due_wakeups(&pool, 2_000).await.unwrap().is_empty());
    }
}
