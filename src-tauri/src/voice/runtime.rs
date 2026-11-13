//! Tauri glue for voice dictation: the real event sink, the voice-control
//! thread that turns hold-key events into dictation actions, the hold-key
//! listener, settings persistence and the managed `VoiceService` behind the
//! `voice_*` commands. The logic lives in `service`.
//!
//! Threads: the hotkey tap thread only pushes key events into a channel, and
//! the audio thread only stores the input level in an atomic. The
//! "voice-control" thread drains the channel, asks Tauri which window is
//! focused and drives the core; while recording it wakes every 66 ms to emit
//! `voice-level` and end overdue takes. The core's "voice-transcribe" worker
//! runs the engine. Both exit when their channel disconnects, which in the
//! app means at process exit.
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
use super::hold::{HoldDetector, HoldKey, KeyEvent};
use super::models::HttpFetch;
use super::service::{
    hold_key_name, load_settings, save_setting, unsupported_status, ErrorPayload, LevelCell,
    LevelPayload, MicPermission, ModelProgress, StatePayload, TakeDroppedPayload, Throttle,
    TranscriptPayload, VoiceCore, VoiceEvents, VoiceStatus, KEY_ENABLED, KEY_HOLD_KEY,
    KEY_LANGUAGE, SUPPORTED,
};
use super::session::{VoiceError, VoiceState};

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
    pub use crate::voice::hotkey_macos::{accessibility_granted, open_accessibility_settings};
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
    use crate::voice::hold::{HoldKey, KeyEvent};
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

    pub fn accessibility_granted() -> bool {
        false
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
    Key(KeyEvent),
    /// A take started outside the hold path: start ticking.
    Wake,
    /// The listener stopped or restarted: forget any half-seen hold.
    Reset,
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
        let core = VoiceCore::start(
            capture,
            platform::Loader,
            settings,
            super::models::models_dir(app_data),
            Arc::new(TauriEvents(app.clone())),
            Box::new(platform::microphone_permission),
        );

        let (control, control_rx) = mpsc::channel();
        let (thread_app, thread_core) = (app.clone(), Arc::clone(&core));
        if let Err(e) = std::thread::Builder::new()
            .name("voice-control".into())
            .spawn(move || run_control(thread_app, thread_core, level, control_rx))
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

    /// Re-checks Accessibility and attaches the listener once it is granted.
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
    pub fn begin(&self, window: String) -> Result<(), VoiceError> {
        let Some(rt) = &self.0 else {
            return Err(VoiceError::Engine("unsupported".into()));
        };
        rt.core.begin(window, Instant::now())?;
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

    /// Returns at once; progress arrives as `voice-model-progress`. A second
    /// call while that model is downloading is ignored.
    pub fn download(&self, app: &AppHandle, model: ModelId) {
        let Some(rt) = &self.0 else { return };
        let Some(claim) = rt.core.claim_download(model) else { return };
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let service = app.state::<VoiceService>();
            let Some(rt) = &service.0 else { return };
            if let Err(e) = rt.core.run_download(claim, HttpFetch::new()) {
                eprintln!("[verun][voice] model download failed: {e}");
            }
            rt.changed();
        });
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
        self.core.status(platform::accessibility_granted())
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
    /// when enabled, permitted and not running. True if it started one.
    fn ensure_listener(&self, slot: &mut Option<platform::Listener>) -> bool {
        if slot.is_some() {
            return false;
        }
        let settings = self.core.settings();
        if !settings.enabled || !platform::accessibility_granted() {
            return false;
        }
        let tx = self.control.clone();
        // Runs on the tap thread: only a non-blocking send.
        *slot = platform::start_listener(settings.hold_key, move |ev| {
            let _ = tx.send(Control::Key(ev));
        });
        slot.is_some()
    }

    /// With the listener lock held: drops the listener (blocks while its
    /// thread exits), resets the hold detector and cancels a take in progress.
    fn stop_listener(&self, slot: &mut Option<platform::Listener>) {
        let old = slot.take();
        if old.is_none() {
            return;
        }
        drop(old);
        let _ = self.control.send(Control::Reset);
        self.core.cancel();
    }
}

/// Voice-control thread body. Exits when every control sender is dropped.
fn run_control(app: AppHandle, core: Arc<Core>, level: Arc<LevelCell>, rx: mpsc::Receiver<Control>) {
    let mut detector = HoldDetector::new();
    let level_throttle = Throttle::new(LEVEL_EVERY);
    loop {
        let msg = if core.state() == VoiceState::Recording {
            match rx.recv_timeout(LEVEL_EVERY) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            }
        };
        match msg {
            Some(Control::Key(ev)) => {
                // Focus only matters for starting; skip the window lookup for
                // the stream of ordinary key presses.
                let focused = if ev == KeyEvent::HoldDown {
                    focused_window(&app)
                } else {
                    None
                };
                let action = detector.on(ev, focused.is_some());
                core.hold(action, focused, Instant::now());
            }
            Some(Control::Reset) => detector = HoldDetector::new(),
            Some(Control::Wake) | None => {}
        }
        let now = Instant::now();
        core.tick(now);
        if core.state() == VoiceState::Recording {
            if level_throttle.ready(now) {
                if let Some(level) = level.take() {
                    core.events().level(LevelPayload { level });
                }
            }
        } else {
            // A level left over from the last take must not leak into the next.
            level.take();
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
