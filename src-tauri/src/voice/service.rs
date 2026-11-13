//! Voice dictation service: ties the dictation state machine, the capture,
//! the FIFO transcription worker, model downloads and settings together.
//! Generic over capture, model loader and event sink so it is tested without
//! a microphone, a model or Tauri. The Tauri glue lives in `runtime`.
//!
//! Take protocol: every take gets an id when it starts recording. Every take
//! that emitted `voice-state` recording with id T later emits exactly one of
//! `voice-transcript`, `voice-error` or `voice-take-dropped` carrying T, and
//! it is emitted before the `voice-state` that reflects T being finished.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::SqlitePool;

use super::catalog::{model_for, spec, Language, ModelId};
use super::engine::{Engine, ModelLoader};
use super::hold::{FnSystemAction, HoldAction, HoldKey};
use super::models::{self, DownloadError, Fetch, ModelStatus};
use super::session::{
    Capture, Dictation, EndOutcome, PendingTake, TakeRef, VoiceError, VoiceState, MIN_HOLD,
};
use crate::db;

/// Dictation is built and shown on Apple Silicon Macs only.
pub const SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

/// Label of the main window: Tauri's default for the first window in
/// `tauri.conf.json`, which `lib.rs` also checks for by this name. Transcripts
/// for a window that has closed go here.
pub const MAIN_WINDOW: &str = "main";

pub const KEY_ENABLED: &str = "voice.enabled";
pub const KEY_LANGUAGE: &str = "voice.language";
pub const KEY_HOLD_KEY: &str = "voice.hold_key";

/// How often the idle worker wakes to unload a model left unused.
const IDLE_CHECK: Duration = Duration::from_secs(30);
/// At most this many download progress events per second (plus the final one).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub language: Language,
    pub hold_key: HoldKey,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            language: Language::En,
            hold_key: HoldKey::default(),
        }
    }
}

impl VoiceSettings {
    /// The `app_meta` rows that store these settings.
    #[cfg(test)]
    pub fn to_meta(self) -> [(&'static str, String); 3] {
        [
            (KEY_ENABLED, self.enabled.to_string()),
            (KEY_LANGUAGE, self.language.code().to_string()),
            (KEY_HOLD_KEY, hold_key_name(self.hold_key)),
        ]
    }

    /// Missing or unreadable values keep their default.
    pub fn from_meta(enabled: Option<&str>, language: Option<&str>, hold_key: Option<&str>) -> Self {
        let d = Self::default();
        Self {
            enabled: enabled.map_or(d.enabled, |v| v == "true"),
            language: language.and_then(Language::from_code).unwrap_or(d.language),
            hold_key: hold_key.and_then(parse_hold_key).unwrap_or(d.hold_key),
        }
    }
}

/// The kebab-case name serde gives `key` (e.g. "right-option").
pub fn hold_key_name(key: HoldKey) -> String {
    serde_json::to_value(key)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn parse_hold_key(name: &str) -> Option<HoldKey> {
    serde_json::from_value(serde_json::Value::String(name.to_string())).ok()
}

pub async fn load_settings(pool: &SqlitePool) -> VoiceSettings {
    let mut values: [Option<String>; 3] = Default::default();
    for (slot, key) in values.iter_mut().zip([KEY_ENABLED, KEY_LANGUAGE, KEY_HOLD_KEY]) {
        *slot = db::read_meta(pool, key).await.unwrap_or_else(|e| {
            eprintln!("[verun][voice] reading {key} failed: {e}");
            None
        });
    }
    let [enabled, language, hold_key] = values;
    VoiceSettings::from_meta(enabled.as_deref(), language.as_deref(), hold_key.as_deref())
}

pub async fn save_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    db::write_meta(pool, key, value).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MicPermission {
    Granted,
    Denied,
    Undetermined,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStatus {
    pub code: Language,
    pub model: ModelId,
    pub installed: bool,
}

/// One entry per `Language::ALL`, in that order. With no models dir (an
/// unsupported platform) nothing is installed.
pub fn language_status(models_dir: Option<&Path>) -> Vec<LanguageStatus> {
    Language::ALL
        .into_iter()
        .map(|code| {
            let model = model_for(code);
            LanguageStatus {
                code,
                model,
                installed: models_dir.is_some_and(|dir| models::is_installed(dir, model)),
            }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub supported: bool,
    pub enabled: bool,
    pub language: Language,
    pub hold_key: HoldKey,
    pub accessibility: bool,
    /// What macOS itself does on Fn (the Globe key setting).
    pub fn_system_action: FnSystemAction,
    pub microphone: MicPermission,
    pub state: VoiceState,
    pub models: Vec<ModelStatus>,
    pub languages: Vec<LanguageStatus>,
}

/// What `voice_status` reports where dictation is not built.
pub fn unsupported_status() -> VoiceStatus {
    let settings = VoiceSettings::default();
    VoiceStatus {
        supported: false,
        enabled: settings.enabled,
        language: settings.language,
        hold_key: settings.hold_key,
        accessibility: false,
        fn_system_action: FnSystemAction::Unknown,
        microphone: MicPermission::Undetermined,
        state: VoiceState::Idle,
        models: Vec::new(),
        languages: language_status(None),
    }
}

/// `take` is set only while `state` is recording.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub state: VoiceState,
    pub window: Option<String>,
    pub take: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelPayload {
    pub level: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPayload {
    pub window: String,
    pub take: u64,
    pub seq: u64,
    pub text: String,
    /// The draft the take was begun for (see `VoiceCore::set_target`).
    pub draft: Option<String>,
}

/// `take` is null for an error before any take existed (a refused begin).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub window: Option<String>,
    pub take: Option<u64>,
    pub error: VoiceError,
    /// The take's draft; null when no take had started.
    pub draft: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DropReason {
    TooShort,
    Silent,
    /// The engine heard nothing worth keeping.
    Empty,
    Cancelled,
}

/// A started take that ended with neither a transcript nor an error.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeDroppedPayload {
    pub window: String,
    pub take: u64,
    pub reason: DropReason,
    pub draft: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub model: ModelId,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
    /// The final event of a download the user cancelled (no error shown).
    pub cancelled: bool,
}

/// One method per frontend event. Implementations must not block: they are
/// called with the service lock held.
pub trait VoiceEvents: Send + Sync + 'static {
    fn state(&self, p: StatePayload);
    fn level(&self, p: LevelPayload);
    fn transcript(&self, p: TranscriptPayload);
    fn error(&self, p: ErrorPayload);
    fn take_dropped(&self, p: TakeDroppedPayload);
    fn model_progress(&self, p: ModelProgress);
    fn status_changed(&self, s: &VoiceStatus);
}

pub type MicCheck = Box<dyn Fn() -> MicPermission + Send + Sync>;
/// Whether a window with this label still exists. Must not block.
pub type WindowCheck = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// Latest input level, handed from the audio thread without blocking or
/// allocating. `take` empties it.
pub struct LevelCell(AtomicU32);

impl LevelCell {
    /// A NaN bit pattern that `level_from_rms` never produces.
    const NONE: u32 = u32::MAX;

    pub fn new() -> Self {
        Self(AtomicU32::new(Self::NONE))
    }

    pub fn set(&self, level: f32) {
        self.0.store(level.to_bits(), Ordering::Relaxed);
    }

    pub fn take(&self) -> Option<f32> {
        let bits = self.0.swap(Self::NONE, Ordering::Relaxed);
        (bits != Self::NONE).then(|| f32::from_bits(bits))
    }
}

impl Default for LevelCell {
    fn default() -> Self {
        Self::new()
    }
}

enum Job {
    Take(PendingTake),
    Unload,
    /// Unload if `ModelId` is the loaded model, then ack.
    UnloadIf(ModelId, mpsc::Sender<()>),
    #[cfg(test)]
    Flush(mpsc::Sender<()>),
}

struct Inner<C: Capture> {
    dictation: Dictation<C>,
    settings: VoiceSettings,
    worker: Option<mpsc::Sender<Job>>,
    /// Last `voice-state` sent, so only changes are emitted.
    shown: StatePayload,
    /// The id of the last take the hold key began. Hold-key ends and cancels
    /// only touch the recording take when it is this one.
    hold_take: Option<u64>,
    /// A hold armed in a window with no target: its window and key-down time.
    /// It opened no microphone; a deliberate one gets a notice on release.
    untargeted_hold: Option<(String, Instant)>,
    /// Take id -> the draft it is for, until its terminal event carries it.
    drafts: HashMap<u64, String>,
}

/// Running downloads, each with the flag that cancels it.
type Downloading = Arc<Mutex<HashMap<ModelId, Arc<AtomicBool>>>>;

/// A running download of `id`. Dropping it (also on panic) releases the claim.
pub struct DownloadClaim {
    set: Downloading,
    id: ModelId,
    cancelled: Arc<AtomicBool>,
}

impl Drop for DownloadClaim {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.id);
    }
}

/// Lock order: `inner`, `downloading` and `targets` are never held together,
/// and no lock is held while transcribing or downloading.
pub struct VoiceCore<C: Capture, E: VoiceEvents> {
    inner: Mutex<Inner<C>>,
    events: Arc<E>,
    models_dir: PathBuf,
    mic: MicCheck,
    window_exists: WindowCheck,
    downloading: Downloading,
    /// Window label -> the draft id of the dictation target it shows, as its
    /// frontend reports. Its own lock, never held with another, so reporting never
    /// waits for a microphone opening under `inner`.
    targets: Mutex<HashMap<String, String>>,
}

fn idle() -> StatePayload {
    StatePayload {
        state: VoiceState::Idle,
        window: None,
        take: None,
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl<C: Capture + 'static, E: VoiceEvents> VoiceCore<C, E> {
    /// Builds the core and spawns its transcription worker, which owns the
    /// engine and exits once the core is dropped.
    pub fn start<L: ModelLoader + 'static>(
        capture: C,
        loader: L,
        settings: VoiceSettings,
        models_dir: PathBuf,
        events: Arc<E>,
        mic: MicCheck,
        window_exists: WindowCheck,
    ) -> Arc<Self> {
        let core = Arc::new(Self {
            inner: Mutex::new(Inner {
                dictation: Dictation::new(capture),
                settings,
                worker: None,
                shown: idle(),
                hold_take: None,
                untargeted_hold: None,
                drafts: HashMap::new(),
            }),
            events,
            models_dir: models_dir.clone(),
            mic,
            window_exists,
            downloading: Arc::new(Mutex::new(HashMap::new())),
            targets: Mutex::new(HashMap::new()),
        });
        let (tx, rx) = mpsc::channel();
        let weak = Arc::downgrade(&core);
        let engine = Engine::new(loader, models_dir);
        match std::thread::Builder::new()
            .name("voice-transcribe".into())
            .spawn(move || run_worker(weak, engine, rx))
        {
            Ok(_) => lock(&core.inner).worker = Some(tx),
            Err(e) => eprintln!("[verun][voice] could not start the transcription worker: {e}"),
        }
        core
    }

    pub fn events(&self) -> &E {
        &self.events
    }

    pub fn settings(&self) -> VoiceSettings {
        lock(&self.inner).settings
    }

    pub fn state(&self) -> VoiceState {
        lock(&self.inner).dictation.state()
    }

    pub fn set_language(&self, language: Language) {
        lock(&self.inner).settings.language = language;
    }

    /// The draft id of the dictation target (a composer) the window `label`
    /// shows, or `None` when it shows none. A hold-key take is pinned to it
    /// when it begins.
    pub fn set_target(&self, label: &str, draft: Option<String>) {
        let mut targets = lock(&self.targets);
        match draft {
            Some(draft) => targets.insert(label.to_string(), draft),
            None => targets.remove(label),
        };
    }

    pub fn set_hold_key(&self, key: HoldKey) {
        lock(&self.inner).settings.hold_key = key;
    }

    /// Disabling cancels any take and unloads the model.
    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = lock(&self.inner);
        inner.settings.enabled = enabled;
        if !enabled {
            // Its release will never come (the listener goes) and the Reset's
            // Cancel arrives disabled: forget it, or it would swallow the end
            // of the first hold after dictation is back on.
            inner.untargeted_hold = None;
            if let Some(worker) = &inner.worker {
                let _ = worker.send(Job::Unload);
            }
            self.cancel_locked(&mut inner);
        }
    }

    /// Hold-key path. Ignored while disabled; begin errors become `voice-error`.
    /// `End` and `Cancel` only act on a take the hold key began, so they never
    /// touch a take started with the mic button. A hold in a window with no
    /// target opens no microphone; released after `MIN_HOLD` with no other key
    /// pressed, it emits `NoTarget` for that window (no take, so no protocol).
    pub fn hold(&self, action: HoldAction, now: Instant) {
        if !self.settings().enabled {
            return;
        }
        match action {
            HoldAction::Begin { window, down_at } => {
                let draft = lock(&self.targets).get(&window).cloned();
                // A new hold replaces any no-composer hold whose end was missed.
                lock(&self.inner).untargeted_hold = None;
                let Some(draft) = draft else {
                    lock(&self.inner).untargeted_hold = Some((window, down_at));
                    return;
                };
                if let Err(error) = self.begin_take(window.clone(), Some(draft), down_at, true) {
                    self.events.error(ErrorPayload {
                        window: Some(window),
                        take: None,
                        error,
                        draft: None,
                    });
                }
            }
            HoldAction::End => {
                let mut inner = lock(&self.inner);
                if let Some((window, down_at)) = inner.untargeted_hold.take() {
                    if now.saturating_duration_since(down_at) >= MIN_HOLD {
                        self.events.error(ErrorPayload {
                            window: Some(window),
                            take: None,
                            error: VoiceError::NoTarget,
                            draft: None,
                        });
                    }
                } else if Self::hold_take_recording(&inner) {
                    self.end_locked(&mut inner, now);
                }
            }
            HoldAction::Cancel => {
                let mut inner = lock(&self.inner);
                if inner.untargeted_hold.take().is_none() && Self::hold_take_recording(&inner) {
                    self.cancel_locked(&mut inner);
                }
            }
            HoldAction::None => {}
        }
    }

    fn hold_take_recording(inner: &Inner<C>) -> bool {
        inner.hold_take.is_some() && inner.dictation.recording().map(|t| t.take) == inner.hold_take
    }

    /// Starts recording for `window` (mic-button path). Errors are returned,
    /// not emitted. A begin while already recording for `window` is a no-op;
    /// for another window it is `Busy`. May block
    /// while the microphone opens: call from a blocking thread.
    /// The take is pinned to `draft`, or without one to the draft of the
    /// target the window reported.
    pub fn begin(&self, window: String, draft: Option<String>, now: Instant) -> Result<(), VoiceError> {
        let draft = draft.or_else(|| lock(&self.targets).get(&window).cloned());
        self.begin_take(window, draft, now, false)
    }

    fn begin_take(
        &self,
        window: String,
        draft: Option<String>,
        now: Instant,
        from_hold: bool,
    ) -> Result<(), VoiceError> {
        let mut inner = lock(&self.inner);
        if !inner.settings.enabled {
            return Err(VoiceError::Disabled);
        }
        if let Some(t) = inner.dictation.recording() {
            // A repeat in the recording window is a no-op; another window is told.
            return if t.window == window { Ok(()) } else { Err(VoiceError::Busy) };
        }
        if (self.mic)() == MicPermission::Denied {
            return Err(VoiceError::MicDenied);
        }
        let lang = inner.settings.language;
        if !models::is_installed(&self.models_dir, model_for(lang)) {
            return Err(VoiceError::ModelMissing);
        }
        inner.dictation.begin(window, lang, now)?;
        let take = inner.dictation.recording().map(|t| t.take);
        if let (Some(take), Some(draft)) = (take, draft) {
            inner.drafts.insert(take, draft);
        }
        inner.hold_take = if from_hold { take } else { None };
        self.show_state(&mut inner);
        Ok(())
    }

    /// The window `label` is gone: cancels the take recording for it, if any.
    /// Takes it already finished still transcribe (see `finished`).
    pub fn window_closed(&self, label: &str) {
        lock(&self.targets).remove(label);
        let mut inner = lock(&self.inner);
        if inner.untargeted_hold.as_ref().is_some_and(|(w, _)| w == label) {
            inner.untargeted_hold = None;
        }
        if inner.dictation.recording().is_some_and(|t| t.window == label) {
            self.cancel_locked(&mut inner);
        }
    }

    /// Ends the take: queues it for transcription, or drops it (too short,
    /// silent), or emits `voice-error` if the capture failed.
    pub fn end(&self, now: Instant) {
        let mut inner = lock(&self.inner);
        self.end_locked(&mut inner, now);
    }

    pub fn cancel(&self) {
        let mut inner = lock(&self.inner);
        self.cancel_locked(&mut inner);
    }

    /// Ends the take once it has run for `MAX_TAKE`.
    pub fn tick(&self, now: Instant) {
        let mut inner = lock(&self.inner);
        if inner.dictation.overdue(now) {
            self.end_locked(&mut inner, now);
        }
    }

    /// Unloads `id` if it is the loaded model. Waits for the worker, which may
    /// be finishing a take: call from a blocking thread.
    pub fn unload_model(&self, id: ModelId) {
        let worker = lock(&self.inner).worker.clone();
        let Some(worker) = worker else { return };
        let (ack, done) = mpsc::channel();
        if worker.send(Job::UnloadIf(id, ack)).is_ok() {
            let _ = done.recv();
        }
    }

    pub fn status(&self, accessibility: bool, fn_system_action: FnSystemAction) -> VoiceStatus {
        let (settings, state) = {
            let inner = lock(&self.inner);
            (inner.settings, inner.dictation.state())
        };
        VoiceStatus {
            supported: SUPPORTED,
            enabled: settings.enabled,
            language: settings.language,
            hold_key: settings.hold_key,
            accessibility,
            fn_system_action,
            microphone: (self.mic)(),
            state,
            models: models::status(&self.models_dir),
            languages: language_status(Some(&self.models_dir)),
        }
    }

    /// Claims `id` for downloading. `None` if a download of it is running.
    pub fn claim_download(&self, id: ModelId) -> Option<DownloadClaim> {
        let mut running = lock(&self.downloading);
        if running.contains_key(&id) {
            return None;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        running.insert(id, Arc::clone(&cancelled));
        Some(DownloadClaim {
            set: Arc::clone(&self.downloading),
            id,
            cancelled,
        })
    }

    /// Asks the running download of `id` to stop. `false` if none is running.
    pub fn cancel_download(&self, id: ModelId) -> bool {
        lock(&self.downloading)
            .get(&id)
            .map(|flag| flag.store(true, Ordering::SeqCst))
            .is_some()
    }

    pub fn is_downloading(&self, id: ModelId) -> bool {
        lock(&self.downloading).contains_key(&id)
    }

    /// Downloads the claimed model, emitting throttled progress, then a final
    /// `done` event, then releasing the claim, then calling `then` (the runtime
    /// broadcasts the status there). A panic in the download ends it the same
    /// way, as an error. A cancelled download ends `Ok` with `cancelled` set and
    /// no error, its claim released before that event so it can be downloaded
    /// again at once. Blocks for the whole download: call from a blocking thread.
    pub fn run_download<F: Fetch>(
        &self,
        claim: DownloadClaim,
        fetch: Result<F, String>,
        then: impl FnOnce(),
    ) -> Result<(), String> {
        let id = claim.id;
        let cancelled = Arc::clone(&claim.cancelled);
        let total: u64 = spec(id).files.iter().map(|f| f.bytes).sum();
        let received = Cell::new(0u64);
        let throttle = Throttle::new(PROGRESS_EVERY);
        let run = || {
            fetch.and_then(|fetch| {
                let on_progress = |got: u64, total: u64| {
                    received.set(got);
                    if throttle.ready(Instant::now()) {
                        self.events.model_progress(ModelProgress {
                            model: id,
                            received: got,
                            total,
                            done: false,
                            error: None,
                            cancelled: false,
                        });
                    }
                };
                match models::download(&self.models_dir, id, &fetch, &on_progress, &cancelled) {
                    Ok(()) => Ok(false),
                    Err(DownloadError::Cancelled) => Ok(true),
                    Err(e) => Err(download_error_text(&e)),
                }
            })
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
            .unwrap_or_else(|_| Err("download panicked".to_string()));
        let was_cancelled = outcome == Ok(true);
        let result = outcome.map(|_| ());
        // A cancelled event brings the Download button back, so the claim must
        // be free by then. Other endings release it after their event.
        let mut claim = Some(claim);
        if was_cancelled {
            claim = None;
        }
        self.events.model_progress(ModelProgress {
            model: id,
            received: received.get(),
            total,
            done: true,
            error: result.as_ref().err().cloned(),
            cancelled: was_cancelled,
        });
        drop(claim);
        then();
        result
    }

    /// Deletes `id`'s files, unloading it first. Refused (`Ok(false)`) while
    /// it is downloading; the check and the delete happen under one lock.
    /// Waits for the worker: call from a blocking thread.
    pub fn delete_model(&self, id: ModelId) -> std::io::Result<bool> {
        if self.is_downloading(id) {
            return Ok(false);
        }
        // Unload before taking the lock: it waits for the worker.
        self.unload_model(id);
        let downloading = lock(&self.downloading);
        if downloading.contains_key(&id) {
            return Ok(false);
        }
        models::delete(&self.models_dir, id)?;
        Ok(true)
    }

    fn dropped(&self, inner: &mut Inner<C>, t: TakeRef, reason: DropReason) {
        self.events.take_dropped(TakeDroppedPayload {
            draft: inner.drafts.remove(&t.take),
            window: t.window,
            take: t.take,
            reason,
        });
    }

    fn end_locked(&self, inner: &mut Inner<C>, now: Instant) {
        match inner.dictation.end(now) {
            EndOutcome::NotRecording => {}
            EndOutcome::TooShort(t) => self.dropped(inner, t, DropReason::TooShort),
            EndOutcome::Silent(t) => self.dropped(inner, t, DropReason::Silent),
            EndOutcome::Failed { take, error } => self.events.error(ErrorPayload {
                draft: inner.drafts.remove(&take.take),
                window: Some(take.window),
                take: Some(take.take),
                error,
            }),
            EndOutcome::Pending(take) => self.enqueue(inner, take),
        }
        self.show_state(inner);
    }

    fn cancel_locked(&self, inner: &mut Inner<C>) {
        if let Some(t) = inner.dictation.cancel() {
            self.dropped(inner, t, DropReason::Cancelled);
        }
        self.show_state(inner);
    }

    /// Emits `voice-state` if the state, its window or its take changed.
    fn show_state(&self, inner: &mut Inner<C>) {
        let d = &inner.dictation;
        let payload = match d.state() {
            VoiceState::Recording => StatePayload {
                state: VoiceState::Recording,
                window: d.recording().map(|t| t.window.clone()),
                take: d.recording().map(|t| t.take),
            },
            VoiceState::Transcribing => StatePayload {
                state: VoiceState::Transcribing,
                window: d.last_pending().map(|t| t.window.clone()),
                take: None,
            },
            VoiceState::Idle => idle(),
        };
        if payload != inner.shown {
            inner.shown = payload.clone();
            self.events.state(payload);
        }
    }

    fn enqueue(&self, inner: &mut Inner<C>, take: PendingTake) {
        let (seq, id, window) = (take.seq, take.take, take.window.clone());
        let sent = inner
            .worker
            .as_ref()
            .is_some_and(|w| w.send(Job::Take(take)).is_ok());
        if !sent {
            inner.dictation.transcribed(seq);
            self.events.error(ErrorPayload {
                window: Some(window),
                take: Some(id),
                error: VoiceError::Engine("transcription worker stopped".into()),
                draft: inner.drafts.remove(&id),
            });
        }
    }

    /// Called by the worker when a take is done.
    fn finished(&self, take: &PendingTake, result: Result<String, VoiceError>) {
        let draft = lock(&self.inner).drafts.remove(&take.take);
        match result {
            Ok(text) if text.is_empty() => self.events.take_dropped(TakeDroppedPayload {
                window: take.window.clone(),
                take: take.take,
                reason: DropReason::Empty,
                draft,
            }),
            Ok(text) => self.events.transcript(TranscriptPayload {
                window: self.deliver_to(&take.window),
                take: take.take,
                seq: take.seq,
                text,
                draft,
            }),
            Err(error) => self.events.error(ErrorPayload {
                window: Some(take.window.clone()),
                take: Some(take.take),
                error,
                draft,
            }),
        }
        let mut inner = lock(&self.inner);
        inner.dictation.transcribed(take.seq);
        self.show_state(&mut inner);
    }

    /// The window a transcript for `window` goes to: the main window once
    /// `window` has closed, so the text is not lost.
    fn deliver_to(&self, window: &str) -> String {
        if (self.window_exists)(window) {
            window.to_string()
        } else {
            MAIN_WINDOW.to_string()
        }
    }

    /// Waits until the worker has handled every job sent so far.
    #[cfg(test)]
    pub(crate) fn flush(&self) {
        let worker = lock(&self.inner).worker.clone().expect("worker running");
        let (ack, done) = mpsc::channel();
        worker.send(Job::Flush(ack)).unwrap();
        done.recv().unwrap();
    }
}

/// Worker thread: transcribes takes strictly in the order they were sent and
/// unloads the model when idle. Exits when the core is dropped.
fn run_worker<C: Capture + 'static, E: VoiceEvents, L: ModelLoader>(
    core: Weak<VoiceCore<C, E>>,
    mut engine: Engine<L>,
    jobs: mpsc::Receiver<Job>,
) {
    loop {
        match jobs.recv_timeout(IDLE_CHECK) {
            Ok(Job::Take(take)) => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    engine.transcribe(&take.samples, take.lang, Instant::now())
                }))
                .unwrap_or_else(|_| {
                    engine.unload();
                    Err(VoiceError::Engine("transcription panicked".into()))
                });
                let Some(core) = core.upgrade() else { return };
                core.finished(&take, result);
            }
            Ok(Job::Unload) => engine.unload(),
            Ok(Job::UnloadIf(id, ack)) => {
                if engine.loaded() == Some(id) {
                    engine.unload();
                }
                let _ = ack.send(());
            }
            #[cfg(test)]
            Ok(Job::Flush(ack)) => {
                let _ = ack.send(());
            }
            Err(RecvTimeoutError::Timeout) => {
                engine.unload_if_idle(Instant::now());
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Lets an event through at most once per `every`. The first one always passes.
pub struct Throttle {
    every: Duration,
    last: Cell<Option<Instant>>,
}

impl Throttle {
    pub fn new(every: Duration) -> Self {
        Self {
            every,
            last: Cell::new(None),
        }
    }

    pub fn ready(&self, now: Instant) -> bool {
        let due = self
            .last
            .get()
            .is_none_or(|last| now.saturating_duration_since(last) >= self.every);
        if due {
            self.last.set(Some(now));
        }
        due
    }
}

pub fn download_error_text(e: &DownloadError) -> String {
    match e {
        DownloadError::Network(m) => format!("network: {m}"),
        DownloadError::Checksum { file } => format!("checksum mismatch for {file}"),
        DownloadError::Io(m) => format!("disk: {m}"),
        DownloadError::NoSpace { needed, available } => {
            let mb = |b: &u64| b / (1024 * 1024);
            format!(
                "not enough free disk space: needs {} MB, {} MB available",
                mb(needed),
                mb(available)
            )
        }
        DownloadError::Cancelled => "cancelled".to_string(),
    }
}

/// Fakes and a rig shared by the service and runtime tests.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::voice::engine::Transcriber;
    use crate::voice::session::MIN_HOLD;
    use std::collections::{HashSet, VecDeque};

    // ---- fakes ----

    #[derive(Clone, Default)]
    pub(crate) struct FakeCapture(Arc<Mutex<CapState>>);

    #[derive(Default)]
    pub(crate) struct CapState {
        starts: usize,
        cancels: usize,
        /// Result of each `stop`, in order; a loud clip once empty.
        stops: VecDeque<Result<Vec<f32>, VoiceError>>,
    }

    impl FakeCapture {
        pub(crate) fn starts(&self) -> usize {
            self.0.lock().unwrap().starts
        }
        pub(crate) fn cancels(&self) -> usize {
            self.0.lock().unwrap().cancels
        }
        fn next_stop(&self, r: Result<Vec<f32>, VoiceError>) {
            self.0.lock().unwrap().stops.push_back(r);
        }
    }

    impl Capture for FakeCapture {
        fn start(&mut self) -> Result<(), VoiceError> {
            self.0.lock().unwrap().starts += 1;
            Ok(())
        }
        fn stop(&mut self) -> Result<Vec<f32>, VoiceError> {
            self.0.lock().unwrap().stops.pop_front().unwrap_or_else(|| Ok(loud()))
        }
        fn cancel(&mut self) {
            self.0.lock().unwrap().cancels += 1;
        }
    }

    fn loud() -> Vec<f32> {
        (0..16_000)
            .map(|i| 0.1 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    enum Reply {
        Text(Result<String, VoiceError>),
        /// Waits for a message on the gate, then answers.
        Gated(Result<String, VoiceError>, mpsc::Receiver<()>),
        Panic,
    }

    #[derive(Clone, Default)]
    pub(crate) struct Script {
        replies: Arc<Mutex<VecDeque<Reply>>>,
        loads: Arc<Mutex<usize>>,
    }

    impl Script {
        pub(crate) fn texts(texts: &[&str]) -> Self {
            let s = Script::default();
            for t in texts {
                s.push(Reply::Text(Ok(t.to_string())));
            }
            s
        }
        fn push(&self, r: Reply) {
            self.replies.lock().unwrap().push_back(r);
        }
        fn loads(&self) -> usize {
            *self.loads.lock().unwrap()
        }
    }

    struct FakeLoader(Script);
    struct FakeModel(Script);

    impl ModelLoader for FakeLoader {
        type Model = FakeModel;
        fn load(&self, _id: ModelId, _dir: &Path) -> Result<FakeModel, VoiceError> {
            *self.0.loads.lock().unwrap() += 1;
            Ok(FakeModel(self.0.clone()))
        }
    }

    impl Transcriber for FakeModel {
        fn transcribe(&mut self, _samples: &[f32], _lang: Language) -> Result<String, VoiceError> {
            let reply = self.0.replies.lock().unwrap().pop_front().expect("unscripted take");
            match reply {
                Reply::Text(t) => t,
                Reply::Gated(t, gate) => {
                    let _ = gate.recv();
                    t
                }
                Reply::Panic => panic!("fake transcriber panic"),
            }
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    pub(crate) enum Ev {
        State(VoiceState, Option<String>, Option<u64>),
        Level,
        Transcript(String, u64, u64, String),
        Error(Option<String>, Option<u64>, VoiceError),
        Dropped(String, u64, DropReason),
        Progress(ModelProgress),
        Status,
    }

    impl Ev {
        /// The take a terminal event (transcript, error, dropped) belongs to.
        fn terminal_take(&self) -> Option<u64> {
            match self {
                Ev::Transcript(_, t, _, _) | Ev::Dropped(_, t, _) => Some(*t),
                Ev::Error(_, t, _) => *t,
                _ => None,
            }
        }
    }

    /// Every event, in order. `on_progress` runs inside `model_progress`.
    #[derive(Default)]
    pub(crate) struct Recorder {
        events: Mutex<Vec<Ev>>,
        /// The draft of each terminal event with a take, in order.
        drafts: Mutex<Vec<(u64, Option<String>)>>,
        #[allow(clippy::type_complexity)]
        on_progress: Mutex<Option<Box<dyn Fn(&ModelProgress) + Send>>>,
    }

    impl Recorder {
        fn push(&self, e: Ev) {
            self.events.lock().unwrap().push(e);
        }
        pub(crate) fn drafts(&self) -> Vec<(u64, Option<String>)> {
            self.drafts.lock().unwrap().clone()
        }
        pub(crate) fn all(&self) -> Vec<Ev> {
            self.events.lock().unwrap().clone()
        }
        fn pick<T>(&self, f: impl Fn(Ev) -> Option<T>) -> Vec<T> {
            self.all().into_iter().filter_map(f).collect()
        }
        pub(crate) fn transcripts(&self) -> Vec<(String, u64, u64, String)> {
            self.pick(|e| match e {
                Ev::Transcript(w, t, s, x) => Some((w, t, s, x)),
                _ => None,
            })
        }
        fn errors(&self) -> Vec<(Option<String>, Option<u64>, VoiceError)> {
            self.pick(|e| match e {
                Ev::Error(w, t, err) => Some((w, t, err)),
                _ => None,
            })
        }
        pub(crate) fn dropped(&self) -> Vec<(String, u64, DropReason)> {
            self.pick(|e| match e {
                Ev::Dropped(w, t, r) => Some((w, t, r)),
                _ => None,
            })
        }
        pub(crate) fn states(&self) -> Vec<(VoiceState, Option<String>, Option<u64>)> {
            self.pick(|e| match e {
                Ev::State(s, w, t) => Some((s, w, t)),
                _ => None,
            })
        }
        pub(crate) fn last_state(&self) -> Option<(VoiceState, Option<String>, Option<u64>)> {
            self.states().pop()
        }
        fn progress(&self) -> Vec<ModelProgress> {
            self.pick(|e| match e {
                Ev::Progress(p) => Some(p),
                _ => None,
            })
        }
    }

    impl VoiceEvents for Recorder {
        fn state(&self, p: StatePayload) {
            self.push(Ev::State(p.state, p.window, p.take));
        }
        fn level(&self, _p: LevelPayload) {
            self.push(Ev::Level);
        }
        fn transcript(&self, p: TranscriptPayload) {
            self.drafts.lock().unwrap().push((p.take, p.draft.clone()));
            self.push(Ev::Transcript(p.window, p.take, p.seq, p.text));
        }
        fn error(&self, p: ErrorPayload) {
            if let Some(take) = p.take {
                self.drafts.lock().unwrap().push((take, p.draft.clone()));
            }
            self.push(Ev::Error(p.window, p.take, p.error));
        }
        fn take_dropped(&self, p: TakeDroppedPayload) {
            self.drafts.lock().unwrap().push((p.take, p.draft.clone()));
            self.push(Ev::Dropped(p.window, p.take, p.reason));
        }
        fn model_progress(&self, p: ModelProgress) {
            if let Some(hook) = self.on_progress.lock().unwrap().as_ref() {
                hook(&p);
            }
            self.push(Ev::Progress(p));
        }
        fn status_changed(&self, _s: &VoiceStatus) {
            self.push(Ev::Status);
        }
    }

    pub(crate) type TestCore = VoiceCore<FakeCapture, Recorder>;

    pub(crate) struct Rig {
        pub(crate) core: Arc<TestCore>,
        pub(crate) rec: Arc<Recorder>,
        pub(crate) cap: FakeCapture,
        script: Script,
        dir: tempfile::TempDir,
        /// Labels of windows that no longer exist.
        closed: Arc<Mutex<HashSet<String>>>,
    }

    impl Rig {
        /// The window is gone as far as `window_exists` is concerned.
        fn close_window(&self, label: &str) {
            self.closed.lock().unwrap().insert(label.to_string());
        }
    }

    pub(crate) struct Opts {
        pub(crate) enabled: bool,
        pub(crate) installed: bool,
        pub(crate) mic: MicPermission,
    }

    impl Default for Opts {
        fn default() -> Self {
            Self {
                enabled: true,
                installed: true,
                mic: MicPermission::Granted,
            }
        }
    }

    /// A models dir where Whisper counts as installed: sparse files of the
    /// catalog size, so nothing is really written.
    fn install(dir: &Path) {
        for f in spec(ModelId::WhisperTurbo).files {
            std::fs::File::create(dir.join(f.rel_path)).unwrap().set_len(f.bytes).unwrap();
        }
    }

    pub(crate) fn rig(script: Script, opts: Opts) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        if opts.installed {
            install(dir.path());
        }
        let cap = FakeCapture::default();
        let rec = Arc::new(Recorder::default());
        let mic = opts.mic;
        let closed = Arc::new(Mutex::new(HashSet::new()));
        let gone = Arc::clone(&closed);
        let core = VoiceCore::start(
            cap.clone(),
            FakeLoader(script.clone()),
            VoiceSettings {
                enabled: opts.enabled,
                ..VoiceSettings::default()
            },
            dir.path().to_path_buf(),
            Arc::clone(&rec),
            Box::new(move || mic),
            Box::new(move |w: &str| !gone.lock().unwrap().contains(w)),
        );
        // The windows the hold-key tests hold in show a composer.
        for w in ["main", "task-2", "task-7", "b"] {
            core.set_target(w, Some(format!("draft:{w}")));
        }
        Rig { core, rec, cap, script, dir, closed }
    }

    pub(crate) fn begin_hold(window: &str, down_at: Instant) -> HoldAction {
        HoldAction::Begin { window: window.into(), down_at }
    }

    pub(crate) fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn take(core: &TestCore, window: &str, at: Instant) {
        core.begin(window.to_string(), None, at).unwrap();
        core.end(at + ms(400));
    }

    fn tr(w: &str, take: u64, seq: u64, t: &str) -> (String, u64, u64, String) {
        (w.to_string(), take, seq, t.to_string())
    }

    pub(crate) fn rec_state(w: &str, take: u64) -> (VoiceState, Option<String>, Option<u64>) {
        (VoiceState::Recording, Some(w.into()), Some(take))
    }

    fn transcribing(w: &str) -> (VoiceState, Option<String>, Option<u64>) {
        (VoiceState::Transcribing, Some(w.into()), None)
    }

    pub(crate) const IDLE: (VoiceState, Option<String>, Option<u64>) = (VoiceState::Idle, None, None);

    // ---- tests ----

    #[test]
    fn transcripts_are_emitted_in_take_order() {
        let r = rig(Script::texts(&["first", "second", "third"]), Opts::default());
        let t0 = Instant::now();
        take(&r.core, "a", t0);
        take(&r.core, "b", t0 + ms(1000));
        take(&r.core, "a", t0 + ms(2000));
        r.core.flush();
        assert_eq!(
            r.rec.transcripts(),
            vec![tr("a", 1, 1, "first"), tr("b", 2, 2, "second"), tr("a", 3, 3, "third")]
        );
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn second_take_recorded_while_first_transcribes_keeps_order() {
        let script = Script::default();
        let (release, gate) = mpsc::channel();
        script.push(Reply::Gated(Ok("first".into()), gate));
        script.push(Reply::Text(Ok("second".into())));
        let r = rig(script, Opts::default());
        let t0 = Instant::now();

        take(&r.core, "a", t0);
        assert_eq!(r.core.state(), VoiceState::Transcribing);
        r.core.begin("b".into(), None, t0 + ms(1000)).unwrap();
        assert_eq!(r.core.state(), VoiceState::Recording);
        r.core.end(t0 + ms(1400));
        // The first take is still held by the gate, so nothing is out yet.
        assert!(r.rec.transcripts().is_empty());
        assert_eq!(
            r.rec.states(),
            vec![rec_state("a", 1), transcribing("a"), rec_state("b", 2), transcribing("b")]
        );

        release.send(()).unwrap();
        r.core.flush();
        assert_eq!(
            r.rec.transcripts(),
            vec![tr("a", 1, 1, "first"), tr("b", 2, 2, "second")]
        );
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn every_started_take_gets_exactly_one_terminal_event() {
        let script = Script::default();
        script.push(Reply::Text(Ok("hello".into()))); // take 1
        script.push(Reply::Text(Ok("  ".into()))); // take 2
        script.push(Reply::Text(Err(VoiceError::Engine("boom".into())))); // take 7
        let r = rig(script, Opts::default());
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);

        take(&r.core, "w", s(0)); // 1: transcript
        r.core.flush();
        take(&r.core, "w", s(1)); // 2: empty transcript
        r.core.flush();
        r.core.begin("w".into(), None, s(2)).unwrap(); // 3: too short
        r.core.end(s(2) + ms(100));
        r.cap.next_stop(Ok(vec![0.0; 16_000]));
        take(&r.core, "w", s(3)); // 4: silent
        r.cap.next_stop(Err(VoiceError::MicUnavailable));
        take(&r.core, "w", s(4)); // 5: capture failed
        r.core.begin("w".into(), None, s(5)).unwrap(); // 6: cancelled
        r.core.cancel();
        take(&r.core, "w", s(6)); // 7: engine error
        r.core.flush();

        let events = r.rec.all();
        let expected: Vec<(u64, Ev)> = vec![
            (1, Ev::Transcript("w".into(), 1, 1, "hello".into())),
            (2, Ev::Dropped("w".into(), 2, DropReason::Empty)),
            (3, Ev::Dropped("w".into(), 3, DropReason::TooShort)),
            (4, Ev::Dropped("w".into(), 4, DropReason::Silent)),
            (5, Ev::Error(Some("w".into()), Some(5), VoiceError::MicUnavailable)),
            (6, Ev::Dropped("w".into(), 6, DropReason::Cancelled)),
            (7, Ev::Error(Some("w".into()), Some(7), VoiceError::Engine("boom".into()))),
        ];
        for (id, want) in expected {
            let started = events
                .iter()
                .position(|e| *e == Ev::State(VoiceState::Recording, Some("w".into()), Some(id)))
                .unwrap_or_else(|| panic!("take {id} never recorded"));
            let terminals: Vec<usize> = (0..events.len())
                .filter(|&i| events[i].terminal_take() == Some(id))
                .collect();
            assert_eq!(terminals.len(), 1, "take {id}: {events:?}");
            let at = terminals[0];
            assert_eq!(events[at], want, "take {id}");
            // Takes run one at a time here, so the next idle state is the
            // one that reflects this take being finished.
            let idle_at = (started..events.len())
                .find(|&i| events[i] == Ev::State(VoiceState::Idle, None, None))
                .unwrap_or_else(|| panic!("take {id} never went idle"));
            assert!(started < at && at < idle_at, "take {id}: {events:?}");
        }
    }

    #[test]
    fn begin_without_installed_model_is_model_missing_and_does_not_record() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let t0 = Instant::now();
        assert_eq!(r.core.begin("main".into(), None, t0), Err(VoiceError::ModelMissing));
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.core.state(), VoiceState::Idle);
        // The mic-button path returns the error and emits nothing.
        assert!(r.rec.all().is_empty());

        r.core.hold(begin_hold("main", t0), t0);
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(
            r.rec.all(),
            vec![Ev::Error(Some("main".into()), None, VoiceError::ModelMissing)]
        );
    }

    #[test]
    fn begin_with_denied_mic_is_mic_denied() {
        let r = rig(Script::default(), Opts { mic: MicPermission::Denied, ..Opts::default() });
        let t0 = Instant::now();
        assert_eq!(r.core.begin("main".into(), None, t0), Err(VoiceError::MicDenied));
        assert_eq!(r.cap.starts(), 0);
        r.core.hold(begin_hold("main", t0), t0);
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.rec.errors(), vec![(Some("main".into()), None, VoiceError::MicDenied)]);
    }

    #[test]
    fn begin_while_disabled_is_refused_and_does_not_record() {
        let r = rig(
            Script::default(),
            Opts { enabled: false, mic: MicPermission::Denied, installed: false },
        );
        // Disabled wins over the permission and model checks.
        assert_eq!(r.core.begin("main".into(), None, Instant::now()), Err(VoiceError::Disabled));
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
    }

    #[test]
    fn empty_transcript_is_dropped_as_empty() {
        let r = rig(Script::texts(&["   "]), Opts::default());
        take(&r.core, "main", Instant::now());
        r.core.flush();
        assert!(r.rec.transcripts().is_empty());
        assert!(r.rec.errors().is_empty());
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::Empty)]);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn transcription_panic_emits_error_and_returns_to_idle() {
        let script = Script::default();
        script.push(Reply::Panic);
        script.push(Reply::Text(Ok("after".into())));
        let r = rig(script, Opts::default());
        let t0 = Instant::now();
        take(&r.core, "main", t0);
        r.core.flush();
        assert_eq!(
            r.rec.errors(),
            vec![(
                Some("main".into()),
                Some(1),
                VoiceError::Engine("transcription panicked".into())
            )]
        );
        assert_eq!(r.rec.last_state(), Some(IDLE));
        take(&r.core, "main", t0 + ms(1000));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 2, 2, "after")]);
        // The panic unloaded the model, so the next take loaded it again.
        assert_eq!(r.script.loads(), 2);
    }

    #[test]
    fn disabled_service_ignores_hold_events() {
        let r = rig(Script::texts(&["x"]), Opts { enabled: false, ..Opts::default() });
        let t0 = Instant::now();
        r.core.hold(begin_hold("main", t0), t0);
        r.core.hold(HoldAction::End, t0 + ms(400));
        r.core.flush();
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
    }

    #[test]
    fn hold_records_in_the_window_it_began_for() {
        let r = rig(Script::texts(&["hello"]), Opts::default());
        let t0 = Instant::now();
        r.core.hold(begin_hold("task-7", t0), t0 + ms(150));
        r.core.hold(HoldAction::End, t0 + ms(400));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("task-7", 1, 1, "hello")]);
    }

    #[test]
    fn a_hold_take_is_timed_from_key_down() {
        let r = rig(Script::texts(&["kept"]), Opts::default());
        let t0 = Instant::now();
        // Armed 150 ms after key down, released 300 ms after it: only 150 ms
        // after arming, yet long enough because the hold counts from key down.
        r.core.hold(begin_hold("main", t0), t0 + ms(150));
        r.core.hold(HoldAction::End, t0 + MIN_HOLD);
        r.core.flush();
        assert!(r.rec.dropped().is_empty(), "{:?}", r.rec.dropped());
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "kept")]);
        // One millisecond less from key down is too short.
        let t1 = t0 + ms(5000);
        r.core.hold(begin_hold("main", t1), t1 + ms(150));
        r.core.hold(HoldAction::End, t1 + MIN_HOLD - ms(1));
        assert_eq!(r.rec.dropped(), vec![("main".into(), 2, DropReason::TooShort)]);
    }

    #[test]
    fn hold_key_events_leave_a_mic_button_take_alone() {
        let r = rig(Script::texts(&["kept"]), Opts::default());
        let t0 = Instant::now();
        r.core.begin("main".into(), None, t0).unwrap();
        // Fn held past the arming delay while the mic-button take records, then
        // released (a long tap), then Fn+arrow.
        r.core.hold(begin_hold("main", t0 + ms(1000)), t0 + ms(1150));
        r.core.hold(HoldAction::End, t0 + ms(1500));
        r.core.hold(begin_hold("main", t0 + ms(2000)), t0 + ms(2150));
        r.core.hold(HoldAction::Cancel, t0 + ms(2200));
        assert_eq!(r.core.state(), VoiceState::Recording);
        assert_eq!(r.cap.starts(), 1);
        assert!(r.rec.dropped().is_empty());
        assert_eq!(r.rec.states(), vec![rec_state("main", 1)]);
        r.core.end(t0 + ms(3000));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "kept")]);
    }

    #[test]
    fn hold_end_still_ends_the_hold_take_after_an_earlier_mic_take() {
        let r = rig(Script::texts(&["one", "two"]), Opts::default());
        let t0 = Instant::now();
        take(&r.core, "main", t0);
        r.core.hold(begin_hold("main", t0 + ms(1000)), t0 + ms(1150));
        r.core.hold(HoldAction::End, t0 + ms(1500));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "one"), tr("main", 2, 2, "two")]);
    }

    #[test]
    fn begin_while_another_window_records_is_busy_and_leaves_that_take_alone() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.begin("a".into(), None, t0).unwrap();
        // The mic button in window b returns the error.
        assert_eq!(r.core.begin("b".into(), None, t0 + ms(10)), Err(VoiceError::Busy));
        // The hold key in window b gets it as a voice-error for b.
        r.core.hold(begin_hold("b", t0 + ms(20)), t0 + ms(170));
        assert_eq!(r.rec.errors(), vec![(Some("b".into()), None, VoiceError::Busy)]);
        // The same window again is still a no-op.
        assert_eq!(r.core.begin("a".into(), None, t0 + ms(30)), Ok(()));
        assert_eq!(r.cap.starts(), 1);
        assert_eq!(r.rec.states(), vec![rec_state("a", 1)]);
        assert_eq!(serde_json::to_value(VoiceError::Busy).unwrap(), "busy");
    }

    #[test]
    fn a_hold_in_a_window_with_no_composer_opens_no_mic_and_notices_a_deliberate_hold() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.set_target("editor", None);
        // Held past the arming delay, released after MIN_HOLD with no other key.
        r.core.hold(begin_hold("editor", t0), t0 + ms(150));
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
        r.core.hold(HoldAction::End, t0 + MIN_HOLD);
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.rec.all(), vec![Ev::Error(Some("editor".into()), None, VoiceError::NoTarget)]);
        assert_eq!(serde_json::to_value(VoiceError::NoTarget).unwrap(), "no-target");
    }

    #[test]
    fn a_no_composer_hold_cut_off_by_disabling_does_not_swallow_the_next_release() {
        let r = rig(Script::texts(&["kept"]), Opts::default());
        let t0 = Instant::now();
        // Fn held in Settings, then dictation switched off mid-hold: the
        // listener goes, so its release never comes; its Reset arrives disabled.
        r.core.hold(begin_hold("settings", t0), t0 + ms(150));
        r.core.set_enabled(false);
        r.core.hold(HoldAction::Cancel, t0 + ms(200));
        r.core.set_enabled(true);
        let t1 = t0 + ms(5000);
        r.core.hold(begin_hold("main", t1), t1 + ms(150));
        r.core.hold(HoldAction::End, t1 + ms(600));
        assert_ne!(r.core.state(), VoiceState::Recording, "the mic stayed open");
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "kept")]);
        assert!(r.rec.errors().is_empty(), "{:?}", r.rec.errors());
    }

    #[test]
    fn a_targeted_hold_replaces_a_leftover_no_composer_hold() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        // A Begin with no End or Cancel in between (a missed release).
        r.core.hold(begin_hold("settings", t0), t0 + ms(150));
        r.core.hold(begin_hold("main", t0 + ms(1000)), t0 + ms(1150));
        r.core.hold(HoldAction::Cancel, t0 + ms(1400));
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::Cancelled)]);
        assert!(r.rec.errors().is_empty());
    }

    #[test]
    fn a_short_or_interrupted_hold_with_no_composer_shows_nothing() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        // Never registered: no target either. Released before MIN_HOLD.
        r.core.hold(begin_hold("diff", t0), t0 + ms(150));
        r.core.hold(HoldAction::End, t0 + MIN_HOLD - ms(1));
        // Fn then an arrow after the arming delay.
        let t1 = t0 + ms(2000);
        r.core.hold(begin_hold("diff", t1), t1 + ms(150));
        r.core.hold(HoldAction::Cancel, t1 + ms(400));
        r.core.hold(HoldAction::End, t1 + ms(900));
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty(), "{:?}", r.rec.all());
    }

    #[test]
    fn a_window_whose_composer_went_away_or_closed_has_no_target() {
        let r = rig(Script::texts(&["hi"]), Opts::default());
        let t0 = Instant::now();
        r.core.set_target("task-9", Some("draft:task-9".into()));
        r.core.set_target("task-9", None);
        r.core.hold(begin_hold("task-9", t0), t0 + ms(150));
        r.core.hold(HoldAction::Cancel, t0 + ms(200));
        r.core.set_target("task-9", Some("draft:task-9".into()));
        r.core.window_closed("task-9");
        r.core.hold(begin_hold("task-9", t0 + ms(1000)), t0 + ms(1150));
        assert_eq!(r.cap.starts(), 0);
        // The mic button is not affected: it only exists where a composer is.
        r.core.begin("task-9".into(), None, t0 + ms(2000)).unwrap();
        assert_eq!(r.cap.starts(), 1);
    }

    fn some(d: &str) -> Option<String> {
        Some(d.to_string())
    }

    #[test]
    fn a_hold_take_carries_the_draft_its_window_showed_when_it_began() {
        let r = rig(Script::texts(&["one"]), Opts::default());
        let t0 = Instant::now();
        r.core.set_target("main", some("s1"));
        r.core.hold(begin_hold("main", t0), t0 + ms(150));
        // The user switches chat while recording: the take stays with s1.
        r.core.set_target("main", some("s2"));
        r.core.hold(HoldAction::End, t0 + ms(400));
        r.core.flush();
        // Too short, then a failed capture: both for s2.
        let t1 = t0 + ms(1000);
        r.core.hold(begin_hold("main", t1), t1 + ms(150));
        r.core.hold(HoldAction::End, t1 + ms(200));
        r.cap.next_stop(Err(VoiceError::MicUnavailable));
        let t2 = t0 + ms(2000);
        r.core.hold(begin_hold("main", t2), t2 + ms(150));
        r.core.hold(HoldAction::End, t2 + ms(400));
        assert_eq!(r.rec.drafts(), vec![(1, some("s1")), (2, some("s2")), (3, some("s2"))]);
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "one")]);
    }

    #[test]
    fn a_mic_button_take_carries_the_draft_it_was_begun_for() {
        let r = rig(Script::texts(&["x"]), Opts::default());
        let t0 = Instant::now();
        r.core.begin("main".into(), some("new-task:p"), t0).unwrap();
        r.core.cancel();
        // Without one it takes the draft the window reported.
        take(&r.core, "main", t0 + ms(1000));
        r.core.flush();
        assert_eq!(r.rec.drafts(), vec![(1, some("new-task:p")), (2, some("draft:main"))]);
    }

    #[test]
    fn a_transcript_rerouted_from_a_closed_window_keeps_its_draft() {
        let r = rig(Script::texts(&["orphan"]), Opts::default());
        r.core.begin("task-3".into(), some("s9"), Instant::now()).unwrap();
        r.core.end(Instant::now() + ms(400));
        r.close_window("task-3");
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr(MAIN_WINDOW, 1, 1, "orphan")]);
        assert_eq!(r.rec.drafts(), vec![(1, some("s9"))]);
    }

    #[test]
    fn closing_the_recording_window_cancels_its_take() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.begin("b".into(), None, t0).unwrap();
        r.core.window_closed("a");
        assert_eq!(r.core.state(), VoiceState::Recording);
        assert_eq!(r.cap.cancels(), 0);
        assert!(r.rec.dropped().is_empty());

        r.core.window_closed("b");
        assert_eq!(r.rec.dropped(), vec![("b".into(), 1, DropReason::Cancelled)]);
        assert_eq!(r.cap.cancels(), 1);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn closing_a_window_leaves_takes_already_transcribing() {
        let script = Script::default();
        let (release, gate) = mpsc::channel();
        script.push(Reply::Gated(Ok("late".into()), gate));
        let r = rig(script, Opts::default());
        take(&r.core, "b", Instant::now());
        r.core.window_closed("b");
        assert!(r.rec.dropped().is_empty());
        release.send(()).unwrap();
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("b", 1, 1, "late")]);
    }

    #[test]
    fn a_transcript_for_a_closed_window_goes_to_the_main_window() {
        let r = rig(Script::texts(&["orphan", "kept"]), Opts::default());
        let t0 = Instant::now();
        take(&r.core, "task-3", t0);
        r.close_window("task-3");
        take(&r.core, "task-4", t0 + ms(1000));
        r.core.flush();
        assert_eq!(
            r.rec.transcripts(),
            vec![tr(MAIN_WINDOW, 1, 1, "orphan"), tr("task-4", 2, 2, "kept")]
        );
    }

    #[test]
    fn hold_cancel_drops_the_take() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.hold(begin_hold("main", t0), t0);
        r.core.hold(HoldAction::Cancel, t0 + ms(400));
        r.core.flush();
        assert!(r.rec.transcripts().is_empty());
        assert_eq!(r.rec.dropped(), vec![("main".into(), 1, DropReason::Cancelled)]);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn overdue_take_is_ended_by_tick() {
        let r = rig(Script::texts(&["long"]), Opts::default());
        let t0 = Instant::now();
        r.core.begin("main".into(), None, t0).unwrap();
        r.core.tick(t0 + Duration::from_secs(299));
        assert_eq!(r.core.state(), VoiceState::Recording);
        r.core.tick(t0 + Duration::from_secs(300));
        assert_ne!(r.core.state(), VoiceState::Recording);
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, 1, "long")]);
    }

    #[test]
    fn failed_take_emits_error_and_returns_to_idle() {
        let r = rig(Script::default(), Opts::default());
        r.cap.next_stop(Err(VoiceError::MicUnavailable));
        take(&r.core, "main", Instant::now());
        assert_eq!(
            r.rec.errors(),
            vec![(Some("main".into()), Some(1), VoiceError::MicUnavailable)]
        );
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.last_state(), Some(IDLE));
    }

    #[test]
    fn disabling_cancels_the_take_and_unloads_the_model() {
        let r = rig(Script::texts(&["one", "two"]), Opts::default());
        let t0 = Instant::now();
        take(&r.core, "main", t0);
        r.core.flush();
        assert_eq!(r.script.loads(), 1);

        r.core.begin("main".into(), None, t0 + ms(1000)).unwrap();
        r.core.set_enabled(false);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.dropped(), vec![("main".into(), 2, DropReason::Cancelled)]);
        r.core.set_enabled(true);
        take(&r.core, "main", t0 + ms(2000));
        r.core.flush();
        // Unloaded on disable, so the next take loads the model again.
        assert_eq!(r.script.loads(), 2);
        assert_eq!(
            r.rec.transcripts(),
            vec![tr("main", 1, 1, "one"), tr("main", 3, 2, "two")]
        );
    }

    struct BadFetch;

    impl Fetch for BadFetch {
        fn get(
            &self,
            _url: &str,
            sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            for _ in 0..50 {
                sink(&[0u8; 16])?;
            }
            Ok(())
        }
    }

    struct PanicFetch;

    impl Fetch for PanicFetch {
        fn get(
            &self,
            _url: &str,
            _sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            panic!("fake fetch panic")
        }
    }

    #[test]
    fn download_reports_failure_and_releases_the_claim() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let claim = r.core.claim_download(id).expect("first claim");
        assert!(r.core.claim_download(id).is_none());
        assert!(r.core.is_downloading(id));
        let result = r.core.run_download(claim, Ok(BadFetch), || {});
        assert!(result.is_err());
        assert!(!r.core.is_downloading(id));
        let progress = r.rec.progress();
        let last = progress.last().unwrap();
        assert!(last.done);
        assert!(last.error.as_deref().unwrap().contains("checksum"));
        // 50 chunks in well under 100 ms: throttled to one plus the final event.
        assert!(progress.len() <= 3, "{progress:?}");
        assert!(r.core.claim_download(id).is_some());
    }

    #[test]
    fn download_without_a_client_reports_the_error() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let claim = r.core.claim_download(id).unwrap();
        let result = r.core.run_download::<BadFetch>(claim, Err("no tls".into()), || {});
        assert_eq!(result, Err("no tls".to_string()));
        let progress = r.rec.progress();
        assert_eq!(progress.len(), 1);
        assert!(progress[0].done);
        assert_eq!(progress[0].error.as_deref(), Some("no tls"));
        assert!(!r.core.is_downloading(id));
    }

    #[test]
    fn a_panicking_download_still_ends_with_done_and_a_status_event() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let claim = r.core.claim_download(id).unwrap();
        let core = Arc::clone(&r.core);
        let rec = Arc::clone(&r.rec);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            core.run_download(claim, Ok(PanicFetch), || {
                rec.status_changed(&unsupported_status())
            })
        }));
        assert_eq!(outcome.ok(), Some(Err("download panicked".to_string())));
        assert!(!r.core.is_downloading(id));
        let events = r.rec.all();
        let done = events
            .iter()
            .position(|e| matches!(e, Ev::Progress(p) if p.done))
            .expect("a final done event");
        match &events[done] {
            Ev::Progress(p) => assert_eq!(p.error.as_deref(), Some("download panicked")),
            _ => unreachable!(),
        }
        assert_eq!(events.last(), Some(&Ev::Status), "{events:?}");
        assert!(done < events.len() - 1);
    }

    #[test]
    fn the_claim_is_released_only_after_the_final_done_event() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (weak, log) = (Arc::downgrade(&r.core), Arc::clone(&seen));
        *r.rec.on_progress.lock().unwrap() = Some(Box::new(move |p: &ModelProgress| {
            if let Some(core) = weak.upgrade() {
                log.lock().unwrap().push((p.done, core.is_downloading(p.model)));
            }
        }));
        for fetch in [Ok(BadFetch), Err("no tls".to_string())] {
            seen.lock().unwrap().clear();
            let claim = r.core.claim_download(id).unwrap();
            let _ = r.core.run_download(claim, fetch, || {});
            let seen = seen.lock().unwrap().clone();
            assert_eq!(seen.last(), Some(&(true, true)), "{seen:?}");
            assert!(!r.core.is_downloading(id));
        }
    }

    /// Sends chunks, cancelling the download right after the first one.
    struct CancelAfterFirst {
        core: Arc<TestCore>,
        sent: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Fetch for CancelAfterFirst {
        fn get(
            &self,
            _url: &str,
            sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            for _ in 0..50 {
                sink(&[0u8; 16])?;
                if self.sent.fetch_add(1, Ordering::SeqCst) == 0 {
                    assert!(self.core.cancel_download(ModelId::WhisperTurbo));
                }
            }
            Ok(())
        }
    }

    #[test]
    fn a_cancelled_download_stops_quietly_and_releases_the_claim() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fetch = CancelAfterFirst { core: Arc::clone(&r.core), sent: Arc::clone(&sent) };
        let claim = r.core.claim_download(id).unwrap();
        let result = r.core.run_download(claim, Ok(fetch), || {});
        assert_eq!(result, Ok(()));
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        let last = r.rec.progress().last().cloned().unwrap();
        assert!(last.done && last.cancelled, "{last:?}");
        assert_eq!(last.error, None);
        assert!(!r.core.is_downloading(id));
        assert!(!models::is_installed(r.dir.path(), id));
        let left: Vec<_> = std::fs::read_dir(r.dir.path()).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_cancelled_download_is_released_before_its_final_event() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (weak, log) = (Arc::downgrade(&r.core), Arc::clone(&seen));
        // The Download button the cancelled event brings back must work at once.
        *r.rec.on_progress.lock().unwrap() = Some(Box::new(move |p: &ModelProgress| {
            if let Some(core) = weak.upgrade() {
                if p.done {
                    log.lock().unwrap().push(core.claim_download(p.model).is_some());
                }
            }
        }));
        let fetch = CancelAfterFirst { core: Arc::clone(&r.core), sent: Default::default() };
        let claim = r.core.claim_download(id).unwrap();
        assert_eq!(r.core.run_download(claim, Ok(fetch), || {}), Ok(()));
        assert_eq!(*seen.lock().unwrap(), vec![true]);
    }

    #[test]
    fn cancel_without_a_running_download_does_nothing() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        assert!(!r.core.cancel_download(ModelId::WhisperTurbo));
        // A later download is not born cancelled.
        let claim = r.core.claim_download(ModelId::WhisperTurbo).unwrap();
        let _ = r.core.run_download(claim, Ok(BadFetch), || {});
        let last = r.rec.progress().last().cloned().unwrap();
        assert!(!last.cancelled);
        assert!(last.error.is_some());
    }

    #[test]
    fn no_space_error_names_what_is_needed() {
        let mb = 1024 * 1024;
        let text = download_error_text(&DownloadError::NoSpace { needed: 748 * mb, available: 100 * mb });
        assert_eq!(text, "not enough free disk space: needs 748 MB, 100 MB available");
    }

    #[test]
    fn delete_is_refused_while_downloading() {
        let r = rig(Script::default(), Opts::default());
        let id = ModelId::WhisperTurbo;
        let claim = r.core.claim_download(id).unwrap();
        assert!(!r.core.delete_model(id).unwrap());
        assert!(models::is_installed(r.dir.path(), id));
        drop(claim);
        assert!(r.core.delete_model(id).unwrap());
        assert!(!models::is_installed(r.dir.path(), id));
    }

    #[test]
    fn status_reports_what_macos_does_with_fn() {
        let r = rig(Script::default(), Opts::default());
        let json = serde_json::to_value(r.core.status(true, FnSystemAction::Emoji)).unwrap();
        assert_eq!(json["fnSystemAction"], "emoji");
        assert_eq!(json["accessibility"], true);
    }

    #[test]
    fn status_lists_every_language_with_its_model() {
        let r = rig(Script::default(), Opts::default());
        let languages = r.core.status(true, FnSystemAction::Unknown).languages;
        assert_eq!(
            languages.iter().map(|l| l.code).collect::<Vec<_>>(),
            Language::ALL.to_vec()
        );
        assert!(languages
            .iter()
            .all(|l| l.installed && l.model == model_for(l.code)));

        let none = language_status(None);
        assert_eq!(none.len(), Language::ALL.len());
        assert!(none.iter().all(|l| !l.installed));
        let empty = tempfile::tempdir().unwrap();
        assert!(language_status(Some(empty.path())).iter().all(|l| !l.installed));
    }

    #[test]
    fn level_cell_hands_over_the_latest_level_once() {
        let cell = LevelCell::new();
        assert_eq!(cell.take(), None);
        cell.set(0.25);
        cell.set(0.5);
        assert_eq!(cell.take(), Some(0.5));
        assert_eq!(cell.take(), None);
    }

    #[test]
    fn throttle_passes_first_then_at_most_every_interval() {
        let t = Throttle::new(ms(100));
        let t0 = Instant::now();
        assert!(t.ready(t0));
        assert!(!t.ready(t0 + ms(50)));
        assert!(t.ready(t0 + ms(100)));
        assert!(!t.ready(t0 + ms(199)));
    }

    #[test]
    fn payloads_serialize_as_the_frontend_expects() {
        let s = unsupported_status();
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["supported"], false);
        assert_eq!(json["holdKey"], "fn");
        assert_eq!(json["fnSystemAction"], "unknown");
        assert_eq!(json["microphone"], "undetermined");
        assert_eq!(json["state"], "idle");
        assert_eq!(json["models"], serde_json::json!([]));
        assert_eq!(
            json["languages"][3],
            serde_json::json!({ "code": "ar", "model": "whisper-turbo", "installed": false })
        );
        assert_eq!(
            serde_json::to_value(models::status(Path::new("/nonexistent"))).unwrap()[0],
            serde_json::json!({
                "id": "whisper-turbo", "displayName": "Whisper large-v3-turbo",
                "installed": false, "bytes": 574_041_195u64
            })
        );
        assert_eq!(
            serde_json::to_value(StatePayload {
                state: VoiceState::Recording, window: Some("main".into()), take: Some(4)
            })
            .unwrap(),
            serde_json::json!({ "state": "recording", "window": "main", "take": 4 })
        );
        assert_eq!(
            serde_json::to_value(TranscriptPayload {
                window: "main".into(), take: 4, seq: 2, text: "hi".into(), draft: Some("s1".into())
            })
            .unwrap(),
            serde_json::json!({ "window": "main", "take": 4, "seq": 2, "text": "hi", "draft": "s1" })
        );
        assert_eq!(
            serde_json::to_value(ErrorPayload {
                window: None, take: None, error: VoiceError::Engine("x".into()), draft: None
            })
            .unwrap(),
            serde_json::json!({ "window": null, "take": null, "error": { "engine": "x" }, "draft": null })
        );
        assert_eq!(serde_json::to_value(VoiceError::Disabled).unwrap(), "disabled");
        assert_eq!(
            serde_json::to_value(TakeDroppedPayload {
                window: "w".into(), take: 9, reason: DropReason::TooShort, draft: Some("new-task:p".into())
            })
            .unwrap(),
            serde_json::json!({ "window": "w", "take": 9, "reason": "too-short", "draft": "new-task:p" })
        );
        assert_eq!(
            serde_json::to_value(ModelProgress {
                model: ModelId::WhisperTurbo, received: 1, total: 2, done: false, error: None,
                cancelled: false
            })
            .unwrap(),
            serde_json::json!({
                "model": "whisper-turbo", "received": 1, "total": 2, "done": false, "error": null,
                "cancelled": false
            })
        );
    }

    #[tokio::test]
    async fn settings_round_trip_through_app_meta() {
        let pool = crate::db::tests::test_pool().await;
        assert_eq!(load_settings(&pool).await, VoiceSettings::default());

        let s = VoiceSettings {
            enabled: true,
            language: Language::Ar,
            hold_key: HoldKey::RightOption,
        };
        for (key, value) in s.to_meta() {
            save_setting(&pool, key, &value).await.unwrap();
        }
        assert_eq!(load_settings(&pool).await, s);
        assert_eq!(db::read_meta(&pool, KEY_HOLD_KEY).await.unwrap().as_deref(), Some("right-option"));
        assert_eq!(db::read_meta(&pool, KEY_LANGUAGE).await.unwrap().as_deref(), Some("ar"));
        assert_eq!(db::read_meta(&pool, KEY_ENABLED).await.unwrap().as_deref(), Some("true"));

        // Unreadable values fall back to their defaults.
        save_setting(&pool, KEY_LANGUAGE, "xx").await.unwrap();
        save_setting(&pool, KEY_HOLD_KEY, "caps-lock").await.unwrap();
        let loaded = load_settings(&pool).await;
        assert_eq!(loaded.language, Language::En);
        assert_eq!(loaded.hold_key, HoldKey::Fn);
        assert!(loaded.enabled);
    }
}
