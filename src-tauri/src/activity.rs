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
    #[serde(skip)]
    native_session: Option<String>,
    #[serde(skip)]
    awaiting_start: bool,
    #[serde(skip)]
    ended: bool,
    #[serde(skip)]
    terminal_id: Option<String>,
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
            native_session: None,
            awaiting_start: false,
            ended: false,
            terminal_id: None,
        }
    }
    fn apply(&mut self, event: &HookEvent) {
        if self.ended || event.agent_id.is_some() || event.session_id.is_empty() {
            return;
        }
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
                self.phase = Phase::Idle;
            }
            "StopFailure" => {
                self.pending.clear();
                self.phase = Phase::Failed;
            }
            "Notification" if event.notification_type.as_deref() == Some("idle_prompt") => {
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
    fn interrupt(&mut self) {
        if !self.ended {
            self.pending.clear();
            self.phase = Phase::Unknown;
        }
    }
    fn release(&mut self) {
        self.pending.clear();
        self.ended = true;
        self.phase = Phase::Ended;
    }
    fn end(&mut self, code: Option<u32>) {
        if self.ended && self.phase == Phase::Failed {
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
        state.interrupt();
        assert_eq!(state.phase, Phase::Unknown);
        assert!(state.pending.is_empty());
        state.apply(&event("UserPromptSubmit", ""));
        state.end(Some(1));
        state.apply(&event("PostToolUse", "a"));
        assert_eq!(state.phase, Phase::Failed);
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
