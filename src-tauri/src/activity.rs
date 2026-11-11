//! Session activity is independent of CLI process liveness.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Unknown,
    Idle,
    Working,
    Waiting,
    Failed,
    Ended,
}

/// Only these fields cross the observer bridge. No prompts, paths or tool arguments.
#[derive(Debug, Deserialize, Serialize)]
pub struct HookEvent {
    pub hook_event_name: String,
    pub session_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub elicitation_id: Option<String>,
    #[serde(default)]
    pub notification_type: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    /// How many background tasks (subagents, background shells) are still
    /// unfinished. Claude sends the full list on Stop/SubagentStop; only the
    /// count crosses the bridge, never their descriptions or commands.
    #[serde(default, deserialize_with = "unfinished_count")]
    pub background_tasks: Option<usize>,
}

fn unfinished_count<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<usize>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Array(tasks) => Some(
            tasks
                .iter()
                .filter(|t| {
                    !matches!(
                        t.get("status").and_then(|s| s.as_str()),
                        Some("completed" | "failed" | "killed" | "stopped" | "cancelled")
                    )
                })
                .count(),
        ),
        serde_json::Value::Number(n) => n.as_u64().map(|n| n as usize),
        _ => None,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub session_id: String,
    pub launch: String,
    pub revision: u64,
    pub phase: Phase,
    pub coverage: &'static str,
    pub source: &'static str,
    pub harness: &'static str,
    pub pending: BTreeSet<String>,
    /// The last turn ended because the user pressed Esc / Ctrl-C, not because
    /// Claude finished: notifications stay quiet for it.
    pub interrupted: bool,
    #[serde(skip)]
    native_session: Option<String>,
    #[serde(skip)]
    awaiting_start: bool,
    #[serde(skip)]
    ended: bool,
    #[serde(skip)]
    terminal_id: Option<String>,
    /// Background tasks (subagents, shells, watchers) Claude reported still
    /// unfinished at its last turn end. They don't make the session busy:
    /// Claude is at its prompt, and some never report back.
    pub background: usize,
}
impl Activity {
    fn new(session: &str, launch: &str) -> Self {
        Self {
            session_id: session.into(),
            launch: launch.into(),
            revision: 0,
            phase: Phase::Unknown,
            coverage: "partial",
            source: "hooks",
            harness: "claude",
            pending: BTreeSet::new(),
            interrupted: false,
            native_session: None,
            awaiting_start: false,
            ended: false,
            terminal_id: None,
            background: 0,
        }
    }
    fn apply(&mut self, event: &HookEvent) {
        // A subagent finishing is the one subagent event that matters to the
        // parent: it refreshes what the parent's turn left running.
        if event.hook_event_name == "SubagentStop" {
            if let (false, Some(n)) = (self.ended, event.background_tasks) {
                self.background = n;
            }
            return;
        }
        if self.ended || event.agent_id.is_some() || event.session_id.is_empty() {
            return;
        }
        // Claude reported again: whatever happens next is its doing.
        self.interrupted = false;
        if self.awaiting_start {
            if event.hook_event_name != "SessionStart" {
                return;
            }
            self.awaiting_start = false;
        }
        if let Some(id) = &self.native_session {
            if id != &event.session_id {
                return;
            }
        } else {
            self.native_session = Some(event.session_id.clone());
        }
        let tool = event
            .tool_use_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(|id| format!("tool:{id}"));
        let elicitation = event
            .elicitation_id
            .as_deref()
            .map(|id| format!("input:{id}"));
        match event.hook_event_name.as_str() {
            "SessionStart" if self.phase == Phase::Unknown => self.phase = Phase::Idle,
            "UserPromptSubmit" => {
                self.pending.clear();
                self.phase = Phase::Working;
            }
            "PermissionRequest" | "Elicitation" => {
                self.pending.insert(
                    tool.or(elicitation)
                        .unwrap_or_else(|| "unidentified".into()),
                );
                self.phase = Phase::Waiting;
            }
            "PreToolUse" => {
                if matches!(
                    event.tool_name.as_deref(),
                    Some("AskUserQuestion" | "ExitPlanMode")
                ) {
                    self.pending
                        .insert(tool.unwrap_or_else(|| "unidentified".into()));
                }
                self.phase = if self.pending.is_empty() {
                    Phase::Working
                } else {
                    Phase::Waiting
                };
            }
            "PostToolUse" | "PostToolUseFailure" | "ElicitationResult" => {
                if let Some(id) = tool.or(elicitation) {
                    self.pending.remove(&id);
                }
                self.phase = if self.pending.is_empty() {
                    Phase::Working
                } else {
                    Phase::Waiting
                };
            }
            // Claude PermissionRequest omits tool_use_id. Only the completed
            // batch proves all anonymous tool permission waits have resolved.
            "PostToolBatch" => {
                self.pending.clear();
                self.phase = Phase::Working;
            }
            "Stop" => {
                self.pending.clear();
                // Claude is back at its prompt: the user's turn, even with
                // background work left running. Claude's tool hooks flip this
                // back to Working if it picks a result up on its own.
                self.background = event.background_tasks.unwrap_or(0);
                self.phase = Phase::Idle;
            }
            "StopFailure" => {
                self.pending.clear();
                self.phase = Phase::Failed;
            }
            "Notification"
                if event.notification_type.as_deref() == Some("idle_prompt") =>
            {
                self.pending.clear();
                self.phase = Phase::Idle;
            }
            "SessionEnd" if matches!(event.reason.as_deref(), Some("clear" | "resume")) => {
                self.pending.clear();
                self.native_session = None;
                self.awaiting_start = true;
                self.phase = Phase::Unknown;
            }
            "SessionEnd" => self.end(Some(0)),
            _ => {}
        }
    }
    /// Esc / Ctrl-C typed into the terminal. Claude fires no Stop hook for an
    /// interrupt, but it lands back at its prompt: the user's turn. If work
    /// actually continues, the next tool hook flips this back to Working.
    fn interrupt(&mut self) {
        if !self.ended {
            self.pending.clear();
            self.phase = Phase::Idle;
            self.interrupted = true;
        }
    }
    fn release(&mut self) {
        self.pending.clear();
        self.ended = true;
        self.phase = Phase::Ended;
    }
    fn end(&mut self, code: Option<u32>) {
        // The first outcome wins: a late PTY exit report must not turn a clean
        // SessionEnd or a deliberate close (release) into a crash, and a late
        // SessionEnd must not mask a real crash.
        if self.ended {
            return;
        }
        self.pending.clear();
        self.ended = true;
        self.phase = if code == Some(0) {
            Phase::Ended
        } else {
            Phase::Failed
        };
    }
}

#[derive(Default)]
pub struct ActivityStore(Mutex<(u64, HashMap<String, Activity>)>);
impl ActivityStore {
    pub fn register(&self, session: &str, launch: &str) -> Activity {
        let mut store = self.0.lock().unwrap();
        store.0 += 1;
        let mut activity = Activity::new(session, launch);
        activity.revision = store.0;
        store.1.insert(session.into(), activity.clone());
        activity
    }
    pub fn phase_and_background(&self, session: &str) -> Option<(Phase, usize)> {
        self.0
            .lock()
            .unwrap()
            .1
            .get(session)
            .map(|s| (s.phase, s.background))
    }
    pub fn snapshot(&self) -> Vec<Activity> {
        self.0.lock().unwrap().1.values().cloned().collect()
    }
    fn update(
        &self,
        session: &str,
        launch: &str,
        f: impl FnOnce(&mut Activity),
    ) -> Option<Activity> {
        let mut store = self.0.lock().unwrap();
        if store.1.get(session)?.launch != launch {
            return None;
        }
        store.0 += 1;
        let revision = store.0;
        let state = store.1.get_mut(session)?;
        f(state);
        state.revision = revision;
        Some(state.clone())
    }
}
fn publish(app: &tauri::AppHandle, state: Option<Activity>) {
    if let Some(state) = state {
        let _ = app.emit("session-activity", state);
    }
}
pub fn terminal_exit(app: &tauri::AppHandle, terminal: &str, code: Option<u32>) {
    let store = app.state::<ActivityStore>();
    for state in store
        .snapshot()
        .iter()
        .filter(|s| s.terminal_id.as_deref() == Some(terminal))
    {
        publish(
            app,
            store.update(&state.session_id, &state.launch, |s| s.end(code)),
        );
    }
}
pub fn terminal_interrupt(app: &tauri::AppHandle, terminal: &str) {
    let store = app.state::<ActivityStore>();
    for state in store
        .snapshot()
        .iter()
        .filter(|s| s.terminal_id.as_deref() == Some(terminal))
    {
        publish(
            app,
            store.update(&state.session_id, &state.launch, Activity::interrupt),
        );
    }
}
#[tauri::command]
pub fn session_activity_snapshot(state: tauri::State<'_, ActivityStore>) -> Vec<Activity> {
    state.snapshot()
}

const MAX_FRAME: usize = 16 * 1024;
#[derive(Deserialize, Serialize)]
struct Frame {
    token: String,
    event: HookEvent,
}
async fn read_frame(reader: impl tokio::io::AsyncRead + Unpin, token: &str) -> Option<HookEvent> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    reader
        .take((MAX_FRAME + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > MAX_FRAME {
        return None;
    }
    let frame: Frame = serde_json::from_slice(&bytes).ok()?;
    (frame.token == token).then_some(frame.event)
}

/// Run before Tauri initializes: no windows, plugins, database or application state.
/// Using the app executable avoids a stale/missing sidecar in development builds.
pub fn run_hook_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--verun-activity") {
        return false;
    }
    if let (Some(address), Some(token)) = (args.get(2), args.get(3)) {
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            runtime.block_on(relay_hook(address, token));
        }
    }
    true
}

/// Short-lived, silent command hook. Failure must never affect a permission decision.
pub async fn relay_hook(address: &str, token: &str) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let _ = tokio::time::timeout(std::time::Duration::from_millis(800), async {
        let address: std::net::SocketAddr = address.parse().ok()?;
        if !address.ip().is_loopback() {
            return None;
        }
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > 1024 * 1024 {
            return None;
        }
        let event: HookEvent = serde_json::from_slice(&bytes).ok()?;
        let frame = serde_json::to_vec(&Frame {
            token: token.into(),
            event,
        })
        .ok()?;
        if frame.len() > MAX_FRAME {
            return None;
        }
        let mut socket = tokio::net::TcpStream::connect(address).await.ok()?;
        socket.write_all(&frame).await.ok()?;
        socket.shutdown().await.ok()?;
        let mut ack = [0];
        socket.read_exact(&mut ack).await.ok()?;
        Some(())
    })
    .await;
}

pub struct ActivityBridge {
    app: tauri::AppHandle,
    session: String,
    launch: String,
    listener: Option<tokio::task::JoinHandle<()>>,
    pub settings: String,
}
impl ActivityBridge {
    pub async fn start(app: tauri::AppHandle, session: &str) -> Result<Self, String> {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        let launch = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let relay = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = format!(
            "{} --verun-activity {} {}",
            quote(&relay.to_string_lossy()),
            address,
            token
        );
        let settings = hook_settings(&command).to_string();
        let store = app.state::<ActivityStore>();
        publish(&app, Some(store.register(session, &launch)));
        let listener_app = app.clone();
        let listener_session = session.to_owned();
        let listener_launch = launch.clone();
        let listener = tokio::spawn(async move {
            // Command hooks wait for an acknowledgement, retaining event order.
            while let Ok((mut socket, _)) = listener.accept().await {
                let event = tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    read_frame(&mut socket, &token),
                )
                .await;
                if let Ok(Some(event)) = event {
                    let store = listener_app.state::<ActivityStore>();
                    publish(
                        &listener_app,
                        store.update(&listener_session, &listener_launch, |s| s.apply(&event)),
                    );
                }
                let _ = socket.write_all(&[1]).await;
            }
        });
        Ok(Self {
            app,
            session: session.into(),
            launch,
            listener: Some(listener),
            settings,
        })
    }
    pub fn unavailable(app: tauri::AppHandle, session: &str) -> Self {
        let launch = uuid::Uuid::new_v4().to_string();
        let store = app.state::<ActivityStore>();
        store.register(session, &launch);
        publish(
            &app,
            store.update(session, &launch, |s| s.coverage = "unavailable"),
        );
        Self {
            app,
            session: session.into(),
            launch,
            listener: None,
            settings: String::new(),
        }
    }
    pub fn attach(&self, terminal: &str) {
        let store = self.app.state::<ActivityStore>();
        publish(
            &self.app,
            store.update(&self.session, &self.launch, |s| {
                s.terminal_id = Some(terminal.into())
            }),
        );
    }
}
impl Drop for ActivityBridge {
    fn drop(&mut self) {
        if let Some(listener) = &self.listener {
            listener.abort();
        }
        let store = self.app.state::<ActivityStore>();
        publish(
            &self.app,
            store.update(&self.session, &self.launch, Activity::release),
        );
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn hook_settings(command: &str) -> serde_json::Value {
    let mut hooks = serde_json::Map::new();
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "PostToolBatch",
        "Stop",
        "StopFailure",
        "SubagentStop",
        "SessionEnd",
        "Elicitation",
        "ElicitationResult",
        "Notification",
    ] {
        hooks.insert(
            event.into(),
            serde_json::json!([{"hooks":[{"type":"command","command":command,"timeout":1}]}]),
        );
    }
    serde_json::json!({"hooks": hooks})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(name: &str, id: &str) -> HookEvent {
        serde_json::from_value(
            json!({"hook_event_name":name,"session_id":"claude-1","tool_use_id":id}),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn transport_rejects_wrong_token_and_oversized_payload() {
        let valid = serde_json::json!({"token":"secret","event":{"hook_event_name":"Stop","session_id":"c"}}).to_string();
        assert!(read_frame(valid.as_bytes(), "secret").await.is_some());
        assert!(read_frame(valid.as_bytes(), "wrong").await.is_none());
        let large = vec![b' '; MAX_FRAME + 1];
        assert!(read_frame(large.as_slice(), "secret").await.is_none());
    }

    #[test]
    fn claude_permission_without_id_resolves_after_its_tool_batch() {
        let mut state = Activity::new("s", "l");
        state.apply(&serde_json::from_value(serde_json::json!({"session_id":"claude-1","hook_event_name":"PermissionRequest","tool_name":"Bash"})).unwrap());
        assert_eq!(state.phase, Phase::Waiting);
        state.apply(&event("PostToolBatch", ""));
        assert_eq!(state.phase, Phase::Working);
    }

    #[test]
    fn clear_switches_native_session_without_restarting_the_pty() {
        let mut state = Activity::new("s", "l");
        state.apply(&event("UserPromptSubmit", ""));
        let clear: HookEvent = serde_json::from_value(serde_json::json!({"session_id":"claude-1","hook_event_name":"SessionEnd","reason":"clear"})).unwrap();
        state.apply(&clear);
        assert_eq!(state.phase, Phase::Unknown);
        let mut start = event("SessionStart", "");
        start.session_id = "claude-2".into();
        state.apply(&start);
        start.hook_event_name = "UserPromptSubmit".into();
        state.apply(&start);
        state.apply(&event("Stop", ""));
        assert_eq!(state.phase, Phase::Working);
    }

    #[test]
    fn closing_terminal_releases_its_override_after_a_crash() {
        let mut state = Activity::new("s", "l");
        state.end(Some(1));
        state.release();
        assert_eq!(state.phase, Phase::Ended);
    }

    #[test]
    fn closing_terminal_before_its_exit_is_reported_does_not_fake_a_crash() {
        // Verun drops the bridge first, then kills the PTY; the reader thread
        // reports the kill afterwards with no exit code.
        let mut state = Activity::new("s", "l");
        state.apply(&event("Stop", ""));
        state.release();
        state.end(None);
        assert_eq!(state.phase, Phase::Ended);
    }

    #[test]
    fn late_session_end_does_not_mask_a_crash() {
        let mut state = Activity::new("s", "l");
        state.end(Some(1));
        state.end(Some(0));
        assert_eq!(state.phase, Phase::Failed);
    }

    #[test]
    fn waits_are_independent_and_pretool_does_not_resolve_permission() {
        let mut state = Activity::new("session", "launch");
        state.apply(&event("UserPromptSubmit", ""));
        assert_eq!(state.phase, Phase::Working);
        for id in ["a", "b"] {
            state.apply(&event("PermissionRequest", id));
        }
        state.apply(&event("PreToolUse", "a"));
        state.apply(&event("PostToolUse", "a"));
        assert_eq!(state.phase, Phase::Waiting);
        state.apply(&event("PostToolUseFailure", "b"));
        assert_eq!(state.phase, Phase::Working);
    }

    #[test]
    fn subagent_and_foreign_session_cannot_finish_parent() {
        let mut state = Activity::new("session", "launch");
        state.apply(&event("UserPromptSubmit", ""));
        let mut stop = event("Stop", "");
        stop.agent_id = Some("child".into());
        state.apply(&stop);
        stop.agent_id = None;
        stop.session_id = "foreign".into();
        state.apply(&stop);
        assert_eq!(state.phase, Phase::Working);
        state.apply(&event("Stop", ""));
        assert_eq!(state.phase, Phase::Idle);
    }

    #[test]
    fn interrupted_and_ended_launches_cannot_stay_busy() {
        let mut state = Activity::new("session", "launch");
        state.apply(&event("PermissionRequest", "a"));
        // Esc / Ctrl-C lands Claude back at its prompt: the user's turn, not
        // an unknown state. The next hook corrects it if work continues.
        state.interrupt();
        assert_eq!(state.phase, Phase::Idle);
        assert!(state.pending.is_empty());
        state.apply(&event("UserPromptSubmit", ""));
        state.end(Some(1));
        state.apply(&event("PostToolUse", "a"));
        assert_eq!(state.phase, Phase::Failed);
    }

    #[test]
    fn a_turn_that_ends_with_background_work_is_the_users_turn_with_a_count() {
        let mut state = Activity::new("s", "l");
        state.apply(&event("UserPromptSubmit", ""));
        let stop: HookEvent = serde_json::from_value(json!({
            "hook_event_name": "Stop", "session_id": "claude-1",
            "background_tasks": [
                {"id": "a1", "type": "local_agent", "status": "running", "description": "secret"},
                {"id": "w1", "type": "artifact_watch", "status": "running"}
            ]
        })).unwrap();
        state.apply(&stop);
        // Claude finished its turn and is at its prompt: not working, even
        // though work it started keeps going (and may never report back).
        assert_eq!(state.phase, Phase::Idle);
        assert_eq!(state.background, 2);
        let wire = serde_json::to_value(&state).unwrap();
        assert_eq!(wire["background"], 2);
        // A subagent reporting back updates the count.
        let done: HookEvent = serde_json::from_value(json!({
            "hook_event_name": "SubagentStop", "session_id": "claude-1", "agent_id": "a1",
            "background_tasks": [{"id": "w1", "type": "artifact_watch", "status": "running"}]
        })).unwrap();
        state.apply(&done);
        assert_eq!(state.background, 1);
        assert_eq!(state.phase, Phase::Idle);
        // Claude picking a result up and working on it is working again.
        let mut tool = event("PreToolUse", "t");
        tool.session_id = "claude-1".into();
        state.apply(&tool);
        assert_eq!(state.phase, Phase::Working);
        // The next turn end carries the fresh count.
        let mut stop = event("Stop", "");
        stop.session_id = "claude-1".into();
        stop.background_tasks = Some(0);
        state.apply(&stop);
        assert_eq!((state.phase, state.background), (Phase::Idle, 0));
    }

    #[test]
    fn background_tasks_cross_the_bridge_as_a_count_only() {
        let input = json!({"hook_event_name":"Stop","session_id":"c","background_tasks":[
            {"id":"b1","type":"local_bash","status":"running","command":"export TOKEN=hunter2"},
            {"id":"b2","type":"local_agent","status":"completed","description":"done"}]});
        let event: HookEvent = serde_json::from_value(input).unwrap();
        let wire = serde_json::to_string(&event).unwrap();
        assert!(!wire.contains("hunter2"));
        assert!(!wire.contains("local_bash"));
        // Round-trips through the relay frame as the count of unfinished tasks.
        let back: HookEvent = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.background_tasks, Some(1));
    }

    #[test]
    fn an_interrupt_is_marked_as_the_users_own_stop_until_claude_reports_again() {
        let mut state = Activity::new("s", "l");
        state.apply(&event("UserPromptSubmit", ""));
        state.interrupt();
        assert!(state.interrupted, "Esc / Ctrl-C ended this turn, not Claude");
        state.apply(&event("UserPromptSubmit", ""));
        assert!(!state.interrupted);
    }

    #[test]
    fn hook_payload_discards_content_and_arguments() {
        let input = json!({"hook_event_name":"PreToolUse", "session_id":"c", "tool_name":"AskUserQuestion", "tool_use_id":"ask", "tool_input":{"secret":"hidden"},"prompt":"private"});
        let event: HookEvent = serde_json::from_value(input).unwrap();
        let wire = serde_json::to_string(&event).unwrap();
        assert!(!wire.contains("private"));
        assert!(!wire.contains("hidden"));
        let mut state = Activity::new("s", "l");
        state.apply(&event);
        assert_eq!(state.phase, Phase::Waiting);
    }

    #[test]
    fn stale_launch_is_rejected() {
        let store = ActivityStore::default();
        store.register("s", "old");
        store.register("s", "new");
        assert!(store
            .update("s", "old", |s| s.apply(&event("UserPromptSubmit", "")))
            .is_none());
        assert_eq!(store.snapshot()[0].phase, Phase::Unknown);
    }
}
