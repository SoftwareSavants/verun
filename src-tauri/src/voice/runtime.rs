//! Tauri glue for voice dictation: the real event sink, the voice-control
//! thread that turns hold-key events into dictation actions, the hold-key
//! listener, settings persistence and the managed `VoiceService` behind the
//! `voice_*` commands. The logic lives in `service`.
//!
//! Threads: the hotkey tap thread only pushes time-stamped key events into a
//! channel, and the audio thread only stores the input level in an atomic.
//! The "voice-control" thread drains the channel, asks Tauri which window is
//! focused, arms a hold `ARM_DELAY` after key down and drives the core; while
//! recording it wakes every 66 ms to emit `voice-level` and end overdue takes.
//! Listener resets and closed windows go through the same channel, so they are
//! handled after the key events queued ahead of them. The core's
//! "voice-transcribe" worker runs the engine. Both exit when their channel
//! disconnects, which in the app means at process exit.
//!
//! Lock order: `listener`, then the core's lock. Only command threads (never
//! the async runtime, the tap thread or the audio thread) take `listener`,
//! and they hold it while a listener is checked, started and dropped, so
//! enabling, disabling, re-keying and `voice_status` cannot interleave.

use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

use super::catalog::{Language, ModelId};
use super::hold::{HoldAction, HoldDetector, HoldKey, KeyEvent};
use super::models::HttpFetch;
use super::service::{
    hold_key_name, load_settings, save_setting, unsupported_status, ErrorPayload, LevelCell,
    LevelPayload, MicPermission, ModelProgress, StatePayload, TakeDroppedPayload, Throttle,
    TranscriptPayload, VoiceCore, VoiceEvents, VoiceStatus, KEY_ENABLED, KEY_HOLD_KEY,
    KEY_LANGUAGE, SUPPORTED,
};
use super::session::{Capture, VoiceError, VoiceState};

/// While recording, the control thread wakes this often: `voice-level` goes
/// out at most this often (about 15 per second) and overdue takes are ended.
const LEVEL_EVERY: Duration = Duration::from_millis(66);

/// Emits every voice event to all windows; the frontend filters by label.
pub struct TauriEvents(AppHandle);

impl VoiceEvents for TauriEvents {
    fn state(&self, p: StatePayload) {
        let _ = self.0.emit("voice-state", p);
    }
    fn level(&self, p: LevelPayload) {
        let _ = self.0.emit("voice-level", p);
    }
    fn transcript(&self, p: TranscriptPayload) {
        let _ = self.0.emit("voice-transcript", p);
    }
    fn error(&self, p: ErrorPayload) {
        let _ = self.0.emit("voice-error", p);
    }
    fn take_dropped(&self, p: TakeDroppedPayload) {
        let _ = self.0.emit("voice-take-dropped", p);
    }
    fn model_progress(&self, p: ModelProgress) {
        let _ = self.0.emit("voice-model-progress", p);
    }
    fn status_changed(&self, s: &VoiceStatus) {
        let _ = self.0.emit("voice-status-changed", s);
    }
}

/// Everything that differs by platform. Off Apple Silicon these are stubs:
/// the service is compiled but never started there.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod platform {
    pub use crate::voice::capture::MicCapture as Mic;
    pub use crate::voice::engine::TranscribeRsLoader as Loader;
    pub use crate::voice::hotkey_macos::HotkeyListener as Listener;
    pub use crate::voice::hotkey_macos::{
        accessibility_granted, fn_system_action, open_accessibility_settings,
    };
    pub use crate::voice::mic_permission_macos::{microphone_permission, request_microphone};
    use crate::voice::hold::{HoldKey, KeyEvent};

    pub fn new_capture(on_level: impl Fn(f32) + Send + Sync + 'static) -> Mic {
        Mic::new(on_level)
    }

    pub fn start_listener(
        key: HoldKey,
        on_event: impl Fn(KeyEvent) + Send + 'static,
    ) -> Option<Listener> {
        Listener::start(key, on_event)
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
mod platform {
    use crate::voice::catalog::{Language, ModelId};
    use crate::voice::engine::{ModelLoader, Transcriber};
    use crate::voice::hold::{FnSystemAction, HoldKey, KeyEvent};
    use crate::voice::service::MicPermission;
    use crate::voice::session::{Capture, VoiceError};
    use std::path::Path;

    fn unsupported() -> VoiceError {
        VoiceError::Engine("unsupported".into())
    }

    pub struct Mic;
    impl Capture for Mic {
        fn start(&mut self) -> Result<(), VoiceError> {
            Err(unsupported())
        }
        fn stop(&mut self) -> Result<Vec<f32>, VoiceError> {
            Err(unsupported())
        }
        fn cancel(&mut self) {}
    }

    pub struct Loader;
    pub struct Model;
    impl Transcriber for Model {
        fn transcribe(&mut self, _: &[f32], _: Language) -> Result<String, VoiceError> {
            Err(unsupported())
        }
    }
    impl ModelLoader for Loader {
        type Model = Model;
        fn load(&self, _: ModelId, _: &Path) -> Result<Model, VoiceError> {
            Err(unsupported())
        }
    }

    pub struct Listener;
    // Mirrors the real listener, which stops on drop, so callers drop it alike.
    impl Drop for Listener {
        fn drop(&mut self) {}
    }
    impl Listener {
        pub fn is_alive(&self) -> bool {
            true
        }
    }

    pub fn accessibility_granted() -> bool {
        false
    }
    pub fn fn_system_action() -> FnSystemAction {
        FnSystemAction::Unknown
    }
    pub fn open_accessibility_settings() {}
    pub fn microphone_permission() -> MicPermission {
        MicPermission::Undetermined
    }
    pub async fn request_microphone() -> MicPermission {
        MicPermission::Undetermined
    }
    pub fn new_capture(_on_level: impl Fn(f32) + Send + Sync + 'static) -> Mic {
        Mic
    }
    pub fn start_listener(_: HoldKey, _: impl Fn(KeyEvent) + Send + 'static) -> Option<Listener> {
        None
    }
}

type Core = VoiceCore<platform::Mic, TauriEvents>;

struct Running {
    core: Arc<Core>,
    /// Feeds the voice-control thread.
    control: mpsc::Sender<Control>,
    /// See the lock order in the module doc.
    listener: Mutex<Option<platform::Listener>>,
    /// Ordered, fire-and-forget `app_meta` writes.
    settings_tx: tokio::sync::mpsc::UnboundedSender<(&'static str, String)>,
}

enum Control {
    /// A key event and when the tap saw it.
    Key(KeyEvent, Instant),
    /// A take started outside the hold path: start ticking.
    Wake,
    /// The listener stopped or restarted: forget any half-seen hold and
    /// cancel a take the hold key began.
    Reset,
    /// The window with this label was destroyed.
    WindowClosed(String),
}

/// Managed state. `None` where dictation is unsupported. Every method except
/// `request_microphone` may block: call them off the async runtime (the
/// commands use `spawn_blocking`).
pub struct VoiceService(Option<Running>);

impl VoiceService {
    /// Loads the settings and starts the worker and control threads. Call
    /// from setup once the pool exists; follow with `attach_listener` off the
    /// main thread.
    pub fn start(app: &AppHandle, pool: SqlitePool, app_data: &Path) -> Self {
        if !SUPPORTED {
            return Self(None);
        }
        let settings = {
            let pool = pool.clone();
            std::thread::spawn(move || tauri::async_runtime::block_on(load_settings(&pool)))
                .join()
                .unwrap_or_default()
        };
        let (settings_tx, mut settings_rx) =
            tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
        tauri::async_runtime::spawn(async move {
            while let Some((key, value)) = settings_rx.recv().await {
                if let Err(e) = save_setting(&pool, key, &value).await {
                    eprintln!("[verun][voice] saving {key} failed: {e}");
                }
            }
        });

        let level = Arc::new(LevelCell::new());
        let audio_level = Arc::clone(&level);
        // Runs on the audio thread: only an atomic store.
        let capture = platform::new_capture(move |l| audio_level.set(l));
        let windows = app.clone();
        let core = VoiceCore::start(
            capture,
            platform::Loader,
            settings,
            super::models::models_dir(app_data),
            Arc::new(TauriEvents(app.clone())),
            Box::new(platform::microphone_permission),
            Box::new(move |label: &str| windows.get_webview_window(label).is_some()),
        );

        let (control, control_rx) = mpsc::channel();
        let thread_app = app.clone();
        let state = ControlState::new(Arc::clone(&core), level);
        if let Err(e) = std::thread::Builder::new()
            .name("voice-control".into())
            .spawn(move || run_control(thread_app, state, control_rx))
        {
            eprintln!("[verun][voice] could not start the control thread: {e}");
        }
        Self(Some(Running {
            core,
            control,
            listener: Mutex::new(None),
            settings_tx,
        }))
    }

    /// Starts the hold-key listener if dictation is on and permitted.
    pub fn attach_listener(&self) {
        if let Some(rt) = &self.0 {
            rt.ensure_listener(&mut rt.listener());
        }
    }

    /// A Verun window gained focus (the user may be back from System
    /// Settings): re-checks the listener as `status` does, broadcasting the
    /// status only if it changed. Blocks while a dead listener's thread exits.
    pub fn window_focused(&self) {
        if let Some(rt) = &self.0 {
            if rt.ensure_listener(&mut rt.listener()) {
                rt.changed();
            }
        }
    }

    /// Re-checks Accessibility and the listener's tap: attaches the listener
    /// once permission is granted, and replaces one whose tap died.
    pub fn status(&self) -> VoiceStatus {
        let Some(rt) = &self.0 else { return unsupported_status() };
        let started = rt.ensure_listener(&mut rt.listener());
        if started {
            rt.changed()
        } else {
            rt.status()
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> VoiceStatus {
        let Some(rt) = &self.0 else { return unsupported_status() };
        {
            let mut slot = rt.listener();
            rt.core.set_enabled(enabled);
            rt.persist(KEY_ENABLED, enabled.to_string());
            if enabled {
                rt.ensure_listener(&mut slot);
            } else {
                rt.stop_listener(&mut slot);
            }
        }
        rt.changed()
    }

    pub fn set_language(&self, language: Language) -> VoiceStatus {
        let Some(rt) = &self.0 else { return unsupported_status() };
        rt.core.set_language(language);
        rt.persist(KEY_LANGUAGE, language.code().to_string());
        rt.changed()
    }

    pub fn set_hold_key(&self, key: HoldKey) -> VoiceStatus {
        let Some(rt) = &self.0 else { return unsupported_status() };
        {
            let mut slot = rt.listener();
            rt.core.set_hold_key(key);
            rt.persist(KEY_HOLD_KEY, hold_key_name(key));
            if slot.is_some() {
                rt.stop_listener(&mut slot);
                rt.ensure_listener(&mut slot);
            }
        }
        rt.changed()
    }

    /// Mic-button path: errors are returned to the caller, not emitted.
    pub fn begin(&self, window: String, draft: Option<String>) -> Result<(), VoiceError> {
        let Some(rt) = &self.0 else {
            return Err(VoiceError::Engine("unsupported".into()));
        };
        rt.core.begin(window, draft, Instant::now())?;
        let _ = rt.control.send(Control::Wake);
        Ok(())
    }

    pub fn end(&self) {
        if let Some(rt) = &self.0 {
            rt.core.end(Instant::now());
        }
    }

    pub fn cancel(&self) {
        if let Some(rt) = &self.0 {
            rt.core.cancel();
        }
    }

    /// The draft id of the dictation target the window `label` shows, if
    /// any. Never blocks for long: the frontend calls it on every change, in order.
    pub fn set_target(&self, label: &str, draft: Option<String>) {
        if let Some(rt) = &self.0 {
            rt.core.set_target(label, draft);
        }
    }

    /// A window was destroyed: a take recording for it is cancelled, and a
    /// hold pending for it never starts. Never blocks (the control thread does it).
    pub fn window_closed(&self, label: &str) {
        if let Some(rt) = &self.0 {
            // Now, not on the control thread: a window reopened under this
            // label right after may report its own target before that runs.
            rt.core.set_target(label, None);
            let _ = rt.control.send(Control::WindowClosed(label.to_string()));
        }
    }

    /// Returns at once; progress arrives as `voice-model-progress`. A second
    /// call while that model is downloading is ignored.
    pub fn download(&self, app: &AppHandle, model: ModelId) {
        let Some(rt) = &self.0 else { return };
        let Some(claim) = rt.core.claim_download(model) else { return };
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let service = app.state::<VoiceService>();
            let Some(rt) = &service.0 else { return };
            if let Err(e) = rt.core.run_download(claim, HttpFetch::new(), || {
                rt.changed();
            }) {
                eprintln!("[verun][voice] model download failed: {e}");
            }
        });
    }

    /// Stops a running download of `model` at its next chunk; its final
    /// `voice-model-progress` has `cancelled` set. No-op if none is running.
    pub fn cancel_download(&self, model: ModelId) {
        if let Some(rt) = &self.0 {
            rt.core.cancel_download(model);
        }
    }

    /// Refused (status unchanged) while that model is downloading.
    pub fn delete_model(&self, model: ModelId) -> VoiceStatus {
        let Some(rt) = &self.0 else { return unsupported_status() };
        match rt.core.delete_model(model) {
            Ok(true) => rt.changed(),
            Ok(false) => rt.status(),
            Err(e) => {
                eprintln!("[verun][voice] deleting model failed: {e}");
                rt.changed()
            }
        }
    }

    /// Async: waits for the user to answer the system prompt.
    pub async fn request_microphone(&self) -> MicPermission {
        if self.0.is_none() {
            return MicPermission::Undetermined;
        }
        platform::request_microphone().await
    }

    /// Broadcasts the current status (after a permission prompt, say).
    pub fn notify_status_changed(&self) {
        if let Some(rt) = &self.0 {
            rt.changed();
        }
    }

    pub fn open_accessibility_settings(&self) {
        if self.0.is_some() {
            platform::open_accessibility_settings();
        }
    }
}

impl Running {
    fn listener(&self) -> MutexGuard<'_, Option<platform::Listener>> {
        self.listener.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status(&self) -> VoiceStatus {
        self.core.status(platform::accessibility_granted(), platform::fn_system_action())
    }

    /// Current status, also sent as `voice-status-changed`.
    fn changed(&self) -> VoiceStatus {
        let status = self.status();
        self.core.events().status_changed(&status);
        status
    }

    fn persist(&self, key: &'static str, value: String) {
        let _ = self.settings_tx.send((key, value));
    }

    /// With the listener lock held: starts the listener with the current key
    /// when enabled, permitted and not running. A listener whose tap died or
    /// whose permission is gone is dropped first (and replaced once permission
    /// is back). True if it started or dropped one.
    fn ensure_listener(&self, slot: &mut Option<platform::Listener>) -> bool {
        let settings = self.core.settings();
        if !settings.enabled && slot.is_none() {
            return false;
        }
        let granted = platform::accessibility_granted();
        let replaced = match plan_listener(settings.enabled, granted, slot.as_ref().map(|l| l.is_alive())) {
            ListenerPlan::Keep => return false,
            ListenerPlan::Start => false,
            ListenerPlan::Replace { restart: false } => {
                self.stop_listener(slot);
                return true;
            }
            ListenerPlan::Replace { restart: true } => {
                self.stop_listener(slot);
                true
            }
        };
        let tx = self.control.clone();
        // Runs on the tap thread: only a clock read and a non-blocking send.
        *slot = platform::start_listener(settings.hold_key, move |ev| {
            let _ = tx.send(Control::Key(ev, Instant::now()));
        });
        // Dropping a dead one changed things even if no new one started.
        replaced || slot.is_some()
    }

    /// With the listener lock held: drops the listener (blocks while its
    /// thread exits), then queues a `Reset` behind the key events it sent, so
    /// the control thread forgets the hold and cancels a take the hold key
    /// began after handling them.
    fn stop_listener(&self, slot: &mut Option<platform::Listener>) {
        let old = slot.take();
        if old.is_none() {
            return;
        }
        drop(old);
        let _ = self.control.send(Control::Reset);
    }
}

/// What `ensure_listener` does with the listener slot.
#[derive(Debug, PartialEq, Eq)]
enum ListenerPlan {
    Keep,
    /// Start one (the slot is empty).
    Start,
    /// Drop the one there; start a new one if `restart`.
    Replace { restart: bool },
}

/// `alive` is `None` with no listener, else whether its tap still works. A
/// listener whose tap macOS disabled for good (Verun toggled off and on in
/// Accessibility) or whose permission is gone counts as absent.
fn plan_listener(enabled: bool, granted: bool, alive: Option<bool>) -> ListenerPlan {
    let wanted = enabled && granted;
    match alive {
        None if wanted => ListenerPlan::Start,
        None => ListenerPlan::Keep,
        Some(true) if wanted => ListenerPlan::Keep,
        Some(_) => ListenerPlan::Replace { restart: wanted },
    }
}

/// Voice-control thread body. Exits when every control sender is dropped.
fn run_control(app: AppHandle, mut state: ControlState<platform::Mic, TauriEvents>, rx: mpsc::Receiver<Control>) {
    loop {
        let msg = match state.wait(Instant::now()) {
            Some(timeout) => match rx.recv_timeout(timeout) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        state.step(msg, Instant::now(), || focused_window(&app));
    }
}

/// The voice-control thread's state, fed one message (or a timeout) at a time
/// with the time passed in, so it is tested without a thread or Tauri.
struct ControlState<C: Capture + 'static, E: VoiceEvents> {
    core: Arc<VoiceCore<C, E>>,
    detector: HoldDetector,
    level: Arc<LevelCell>,
    level_throttle: Throttle,
}

impl<C: Capture + 'static, E: VoiceEvents> ControlState<C, E> {
    fn new(core: Arc<VoiceCore<C, E>>, level: Arc<LevelCell>) -> Self {
        Self {
            core,
            detector: HoldDetector::new(),
            level,
            level_throttle: Throttle::new(LEVEL_EVERY),
        }
    }

    /// How long to wait for the next message at `now`: until a pending hold
    /// arms, and at most `LEVEL_EVERY` while recording. `None` waits for one.
    fn wait(&self, now: Instant) -> Option<Duration> {
        let level = (self.core.state() == VoiceState::Recording).then_some(LEVEL_EVERY);
        let arm = self.detector.deadline().map(|d| d.saturating_duration_since(now));
        match (level, arm) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Handles `msg` (`None` for a timeout) at `now`. `focused` is asked only
    /// for a hold-key press. A pending hold arms only on a timeout, when the
    /// queue is empty: after a message, its release may be queued right behind
    /// it (the thread lagging past the arm delay), and the next key event arms
    /// it by its own time if it is really due.
    fn step(&mut self, msg: Option<Control>, now: Instant, focused: impl FnOnce() -> Option<String>) {
        let timed_out = msg.is_none();
        match msg {
            Some(Control::Key(ev, at)) => {
                // A deadline that passed before this event arms first.
                let armed = self.detector.on_time(at);
                self.core.hold(armed, at);
                let focused = if ev == KeyEvent::HoldDown { focused() } else { None };
                let action = self.detector.on_key(ev, focused, at);
                self.core.hold(action, at);
            }
            Some(Control::Reset) => {
                self.detector = HoldDetector::new();
                self.core.hold(HoldAction::Cancel, now);
            }
            Some(Control::WindowClosed(label)) => {
                self.detector.forget_window(&label);
                self.core.window_closed(&label);
            }
            Some(Control::Wake) | None => {}
        }
        if timed_out {
            let armed = self.detector.on_time(now);
            self.core.hold(armed, now);
        }
        self.core.tick(now);
        if self.core.state() == VoiceState::Recording {
            if self.level_throttle.ready(now) {
                if let Some(level) = self.level.take() {
                    self.core.events().level(LevelPayload { level });
                }
            }
        } else {
            // A level left over from the last take must not leak into the next.
            self.level.take();
        }
    }
}

/// Label of the focused Verun window, if any.
fn focused_window(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::hold::ARM_DELAY;
    use crate::voice::service::tests::{
        ms, rec_state, rig, FakeCapture, Opts, Recorder, Rig, Script, IDLE,
    };
    use crate::voice::service::DropReason;
    use KeyEvent::{HoldDown, HoldUp, OtherKeyDown};

    fn control(r: &Rig) -> ControlState<FakeCapture, Recorder> {
        ControlState::new(Arc::clone(&r.core), Arc::new(LevelCell::new()))
    }

    fn key(ev: KeyEvent, at: Instant) -> Option<Control> {
        Some(Control::Key(ev, at))
    }

    fn main_window() -> Option<String> {
        Some("main".into())
    }

    fn no_window() -> Option<String> {
        None
    }

    #[test]
    fn a_dead_or_unpermitted_listener_is_replaced_once_permission_is_back() {
        use ListenerPlan::*;
        assert_eq!(plan_listener(true, true, None), Start);
        assert_eq!(plan_listener(true, false, None), Keep);
        assert_eq!(plan_listener(false, true, None), Keep);
        assert_eq!(plan_listener(true, true, Some(true)), Keep);
        // The tap died while permission is there: recreate it.
        assert_eq!(plan_listener(true, true, Some(false)), Replace { restart: true });
        // Permission is gone: tear it down, start nothing until it is back.
        assert_eq!(plan_listener(true, false, Some(true)), Replace { restart: false });
        assert_eq!(plan_listener(true, false, Some(false)), Replace { restart: false });
        assert_eq!(plan_listener(false, true, Some(true)), Replace { restart: false });
    }

    #[test]
    fn a_hold_key_tap_opens_no_microphone() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, main_window);
        assert_eq!(c.wait(t0), Some(ARM_DELAY));
        c.step(key(HoldUp, t0 + ms(120)), t0 + ms(120), main_window);
        assert_eq!(c.wait(t0 + ms(120)), None);
        c.step(None, t0 + ms(400), main_window);
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty(), "{:?}", r.rec.all());
    }

    #[test]
    fn fn_arrow_opens_no_microphone() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, main_window);
        c.step(key(OtherKeyDown, t0 + ms(40)), t0 + ms(40), main_window);
        c.step(None, t0 + ms(400), main_window);
        c.step(key(HoldUp, t0 + ms(500)), t0 + ms(500), main_window);
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty(), "{:?}", r.rec.all());
    }

    #[test]
    fn a_held_key_records_from_key_down_in_the_window_focused_then() {
        let r = rig(Script::texts(&["hello"]), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, || Some("task-2".into()));
        c.step(None, t0 + ms(149), no_window);
        assert_eq!(r.cap.starts(), 0);
        c.step(None, t0 + ms(150), no_window);
        assert_eq!(r.rec.states(), vec![rec_state("task-2", 1)]);
        // Released 300 ms after key down: long enough, though armed at 150 ms.
        c.step(key(HoldUp, t0 + ms(300)), t0 + ms(300), no_window);
        r.core.flush();
        assert_eq!(
            r.rec.transcripts(),
            vec![("task-2".to_string(), 1, 1, "hello".to_string())]
        );
    }

    #[test]
    fn a_release_seen_after_the_deadline_begins_then_ends_too_short() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, main_window);
        c.step(key(HoldUp, t0 + ms(200)), t0 + ms(200), main_window);
        assert_eq!(r.rec.states(), vec![rec_state("main", 1), IDLE]);
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::TooShort)]);
    }

    #[test]
    fn another_key_after_arming_cancels_the_take() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, main_window);
        c.step(None, t0 + ms(150), main_window);
        c.step(key(OtherKeyDown, t0 + ms(400)), t0 + ms(400), main_window);
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::Cancelled)]);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn hold_key_leaves_a_mic_button_take_recording() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        r.core.begin("main".into(), None, t0).unwrap();
        c.step(Some(Control::Wake), t0, main_window);
        let at = |n| t0 + ms(n);
        // A tap, Fn+arrow, a long press released, a long press then another key.
        for (ev, n) in [
            (HoldDown, 1000), (HoldUp, 1050),
            (HoldDown, 2000), (OtherKeyDown, 2040), (HoldUp, 2100),
            (HoldDown, 3000), (HoldUp, 3500),
            (HoldDown, 4000), (OtherKeyDown, 4400), (HoldUp, 4500),
        ] {
            c.step(key(ev, at(n)), at(n), main_window);
            c.step(None, at(n + 200), main_window);
        }
        assert_eq!(r.core.state(), VoiceState::Recording);
        assert_eq!(r.cap.starts(), 1);
        assert_eq!(r.rec.states(), vec![rec_state("main", 1)]);
        assert!(r.rec.dropped().is_empty());
    }

    #[test]
    fn reset_cancels_a_take_begun_by_old_key_events_queued_before_it() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        // The old key's press arms on a timeout: it begins a take.
        c.step(key(HoldDown, t0), t0, main_window);
        c.step(None, t0 + ms(200), main_window);
        assert_eq!(r.core.state(), VoiceState::Recording);
        // The listener was replaced; the Reset queued behind the old key events arrives.
        c.step(Some(Control::Reset), t0 + ms(210), main_window);
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::Cancelled)]);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(c.wait(t0 + ms(210)), None);
    }

    #[test]
    fn a_press_drained_late_does_not_arm_before_its_queued_release() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        // The control thread lagged: it sees a 100 ms tap 200 ms after the press.
        c.step(key(HoldDown, t0), t0 + ms(200), main_window);
        c.step(key(HoldUp, t0 + ms(100)), t0 + ms(201), main_window);
        c.step(None, t0 + ms(400), main_window);
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty(), "{:?}", r.rec.all());
    }

    #[test]
    fn a_press_drained_late_arms_on_the_next_timeout() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0 + ms(200), main_window);
        assert_eq!(c.wait(t0 + ms(200)), Some(Duration::ZERO));
        c.step(None, t0 + ms(200), main_window);
        assert_eq!(r.rec.states(), vec![rec_state("main", 1)]);
    }

    #[test]
    fn reset_forgets_a_pending_arm() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, main_window);
        c.step(Some(Control::Reset), t0 + ms(10), main_window);
        c.step(None, t0 + ms(400), main_window);
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
    }

    #[test]
    fn reset_leaves_a_mic_button_take_alone() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        r.core.begin("main".into(), None, Instant::now()).unwrap();
        c.step(Some(Control::Reset), Instant::now(), main_window);
        assert_eq!(r.core.state(), VoiceState::Recording);
    }

    #[test]
    fn closing_a_window_cancels_its_take_only() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        r.core.begin("b".into(), None, t0).unwrap();
        c.step(Some(Control::WindowClosed("a".into())), t0, main_window);
        assert_eq!(r.core.state(), VoiceState::Recording);
        assert_eq!(r.cap.cancels(), 0);
        c.step(Some(Control::WindowClosed("b".into())), t0, main_window);
        assert_eq!(r.rec.dropped(), vec![("b".into(), 1, DropReason::Cancelled)]);
        assert_eq!(r.cap.cancels(), 1);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn a_window_reopened_under_the_same_label_keeps_its_target_when_the_old_close_is_handled() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        // task-2 closed and was reopened at once; the new page reported its
        // composer before the control thread got to the old WindowClosed.
        r.core.set_target("task-2", Some("s2".into()));
        c.step(Some(Control::WindowClosed("task-2".into())), t0, main_window);
        c.step(key(HoldDown, t0 + ms(10)), t0 + ms(10), || Some("task-2".into()));
        c.step(None, t0 + ms(160), no_window);
        assert_eq!(r.rec.states(), vec![rec_state("task-2", 1)]);
    }

    #[test]
    fn closing_the_window_of_a_pending_arm_begins_nothing() {
        let r = rig(Script::default(), Opts::default());
        let mut c = control(&r);
        let t0 = Instant::now();
        c.step(key(HoldDown, t0), t0, || Some("b".into()));
        c.step(Some(Control::WindowClosed("b".into())), t0 + ms(50), main_window);
        c.step(None, t0 + ms(400), main_window);
        c.step(key(HoldUp, t0 + ms(500)), t0 + ms(500), main_window);
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
    }
}
