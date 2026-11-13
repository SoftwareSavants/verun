//! Voice dictation service: ties the dictation state machine, the capture,
//! the FIFO transcription worker, model downloads and settings together.
//! Generic over capture, model loader and event sink so it is tested without
//! a microphone, a model or Tauri. The Tauri glue lives in `runtime`.

use std::cell::Cell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::SqlitePool;

use super::catalog::{model_for, spec, Language, ModelId};
use super::engine::{Engine, ModelLoader};
use super::hold::{HoldAction, HoldKey};
use super::models::{self, DownloadError, Fetch, ModelStatus};
use super::session::{Capture, Dictation, EndOutcome, PendingTake, VoiceError, VoiceState};
use crate::db;

/// Dictation is built and shown on Apple Silicon Macs only.
pub const SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub supported: bool,
    pub enabled: bool,
    pub language: Language,
    pub hold_key: HoldKey,
    pub accessibility: bool,
    pub microphone: MicPermission,
    pub state: VoiceState,
    pub models: Vec<ModelStatus>,
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
        microphone: MicPermission::Undetermined,
        state: VoiceState::Idle,
        models: Vec::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub state: VoiceState,
    pub window: Option<String>,
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
    pub seq: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub window: Option<String>,
    pub error: VoiceError,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub model: ModelId,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// One method per frontend event. Implementations must not block: they are
/// called with the service lock held and from the audio thread (`level`).
pub trait VoiceEvents: Send + Sync + 'static {
    fn state(&self, p: StatePayload);
    fn level(&self, p: LevelPayload);
    fn transcript(&self, p: TranscriptPayload);
    fn error(&self, p: ErrorPayload);
    fn model_progress(&self, p: ModelProgress);
    fn status_changed(&self, s: &VoiceStatus);
}

pub type MicCheck = Box<dyn Fn() -> MicPermission + Send + Sync>;

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
    /// Window of the take being recorded.
    recording: Option<String>,
    /// Takes handed to the worker, oldest first, with their window.
    pending: Vec<(u64, String)>,
    /// Last `voice-state` sent, so only changes are emitted.
    shown: StatePayload,
}

/// Lock order: `inner` and `downloading` are never held together, and no
/// lock is held while transcribing or downloading.
pub struct VoiceCore<C: Capture, E: VoiceEvents> {
    inner: Mutex<Inner<C>>,
    events: Arc<E>,
    models_dir: PathBuf,
    mic: MicCheck,
    downloading: Mutex<HashSet<ModelId>>,
}

fn idle() -> StatePayload {
    StatePayload {
        state: VoiceState::Idle,
        window: None,
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
    ) -> Arc<Self> {
        let core = Arc::new(Self {
            inner: Mutex::new(Inner {
                dictation: Dictation::new(capture),
                settings,
                worker: None,
                recording: None,
                pending: Vec::new(),
                shown: idle(),
            }),
            events,
            models_dir: models_dir.clone(),
            mic,
            downloading: Mutex::new(HashSet::new()),
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

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
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

    pub fn set_hold_key(&self, key: HoldKey) {
        lock(&self.inner).settings.hold_key = key;
    }

    /// Disabling cancels any take and unloads the model.
    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = lock(&self.inner);
        inner.settings.enabled = enabled;
        if !enabled {
            inner.dictation.cancel();
            inner.recording = None;
            if let Some(worker) = &inner.worker {
                let _ = worker.send(Job::Unload);
            }
            self.show_state(&mut inner);
        }
    }

    /// Hold-key path. Ignored while disabled; begin errors become `voice-error`.
    pub fn hold(&self, action: HoldAction, focused: Option<String>, now: Instant) {
        if !self.settings().enabled {
            return;
        }
        match action {
            HoldAction::Begin => {
                let Some(window) = focused else { return };
                if let Err(error) = self.begin(window.clone(), now) {
                    self.events.error(ErrorPayload {
                        window: Some(window),
                        error,
                    });
                }
            }
            HoldAction::End => self.end(now),
            HoldAction::Cancel => self.cancel(),
            HoldAction::None => {}
        }
    }

    /// Starts recording for `window`. Errors are returned, not emitted.
    /// A begin while already recording is a no-op. May block while the
    /// microphone opens: call from a blocking thread.
    pub fn begin(&self, window: String, now: Instant) -> Result<(), VoiceError> {
        if (self.mic)() == MicPermission::Denied {
            return Err(VoiceError::MicDenied);
        }
        let mut inner = lock(&self.inner);
        if inner.recording.is_some() {
            return Ok(());
        }
        let lang = inner.settings.language;
        if !models::is_installed(&self.models_dir, model_for(lang)) {
            return Err(VoiceError::ModelMissing);
        }
        inner.dictation.begin(window.clone(), lang, now)?;
        inner.recording = Some(window);
        self.show_state(&mut inner);
        Ok(())
    }

    /// Ends the take: queues it for transcription, or drops it (too short,
    /// silent), or emits `voice-error` if the capture failed.
    pub fn end(&self, now: Instant) {
        let mut inner = lock(&self.inner);
        let outcome = inner.dictation.end(now);
        inner.recording = None;
        match outcome {
            EndOutcome::NotRecording | EndOutcome::TooShort | EndOutcome::Silent => {}
            EndOutcome::Failed { window, error } => self.events.error(ErrorPayload {
                window: Some(window),
                error,
            }),
            EndOutcome::Pending(take) => self.enqueue(&mut inner, take),
        }
        self.show_state(&mut inner);
    }

    pub fn cancel(&self) {
        let mut inner = lock(&self.inner);
        inner.dictation.cancel();
        inner.recording = None;
        self.show_state(&mut inner);
    }

    /// Ends the take once it has run for `MAX_TAKE`. True while still recording.
    pub fn tick(&self, now: Instant) -> bool {
        let overdue = lock(&self.inner).dictation.overdue(now);
        if overdue {
            self.end(now);
        }
        self.state() == VoiceState::Recording
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

    pub fn status(&self, accessibility: bool) -> VoiceStatus {
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
            microphone: (self.mic)(),
            state,
            models: models::status(&self.models_dir),
        }
    }

    /// Marks `id` as downloading. False if a download of it is already running.
    pub fn claim_download(&self, id: ModelId) -> bool {
        lock(&self.downloading).insert(id)
    }

    pub fn is_downloading(&self, id: ModelId) -> bool {
        lock(&self.downloading).contains(&id)
    }

    /// Downloads `id` after a successful `claim_download`, emitting throttled
    /// progress and a final `done` event, then releases the claim. Blocks for
    /// the whole download: call from a blocking thread.
    pub fn run_download<F: Fetch>(&self, id: ModelId, fetch: Result<F, String>) -> Result<(), String> {
        let total: u64 = spec(id).files.iter().map(|f| f.bytes).sum();
        let received = Cell::new(0u64);
        let throttle = Throttle::new(PROGRESS_EVERY);
        let result = fetch.and_then(|fetch| {
            let on_progress = |got: u64, total: u64| {
                received.set(got);
                if throttle.ready(Instant::now()) {
                    self.events.model_progress(ModelProgress {
                        model: id,
                        received: got,
                        total,
                        done: false,
                        error: None,
                    });
                }
            };
            models::download(&self.models_dir, id, &fetch, &on_progress)
                .map_err(|e| download_error_text(&e))
        });
        self.events.model_progress(ModelProgress {
            model: id,
            received: received.get(),
            total,
            done: true,
            error: result.as_ref().err().cloned(),
        });
        lock(&self.downloading).remove(&id);
        result
    }

    /// Emits `voice-state` if the state or its window changed.
    fn show_state(&self, inner: &mut Inner<C>) {
        let state = inner.dictation.state();
        let window = match state {
            VoiceState::Recording => inner.recording.clone(),
            VoiceState::Transcribing => inner.pending.last().map(|(_, w)| w.clone()),
            VoiceState::Idle => None,
        };
        let payload = StatePayload { state, window };
        if payload != inner.shown {
            inner.shown = payload.clone();
            self.events.state(payload);
        }
    }

    fn enqueue(&self, inner: &mut Inner<C>, take: PendingTake) {
        let (seq, window) = (take.seq, take.window.clone());
        inner.pending.push((seq, window.clone()));
        let sent = inner
            .worker
            .as_ref()
            .is_some_and(|w| w.send(Job::Take(take)).is_ok());
        if !sent {
            inner.dictation.transcribed(seq);
            inner.pending.retain(|(s, _)| *s != seq);
            self.events.error(ErrorPayload {
                window: Some(window),
                error: VoiceError::Engine("transcription worker stopped".into()),
            });
        }
    }

    /// Called by the worker when take `seq` is done.
    fn finished(&self, seq: u64, window: String, result: Result<String, VoiceError>) {
        match result {
            Ok(text) if text.is_empty() => {}
            Ok(text) => self.events.transcript(TranscriptPayload { window, seq, text }),
            Err(error) => self.events.error(ErrorPayload {
                window: Some(window),
                error,
            }),
        }
        let mut inner = lock(&self.inner);
        inner.dictation.transcribed(seq);
        inner.pending.retain(|(s, _)| *s != seq);
        self.show_state(&mut inner);
    }

    /// Waits until the worker has handled every job sent so far.
    #[cfg(test)]
    fn flush(&self) {
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
                core.finished(take.seq, take.window, result);
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::engine::Transcriber;
    use std::collections::VecDeque;

    // ---- fakes ----

    #[derive(Clone, Default)]
    struct FakeCapture(Arc<Mutex<CapState>>);

    #[derive(Default)]
    struct CapState {
        starts: usize,
        /// Result of each `stop`, in order; a loud clip once empty.
        stops: VecDeque<Result<Vec<f32>, VoiceError>>,
    }

    impl FakeCapture {
        fn starts(&self) -> usize {
            self.0.lock().unwrap().starts
        }
        fn fail_next_stop(&self, e: VoiceError) {
            self.0.lock().unwrap().stops.push_back(Err(e));
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
        fn cancel(&mut self) {}
    }

    fn loud() -> Vec<f32> {
        (0..16_000)
            .map(|i| 0.1 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    struct Reply {
        text: Result<String, VoiceError>,
        /// When set, the transcription waits for a message on it first.
        gate: Option<mpsc::Receiver<()>>,
    }

    #[derive(Clone, Default)]
    struct Script {
        replies: Arc<Mutex<VecDeque<Reply>>>,
        loads: Arc<Mutex<usize>>,
    }

    impl Script {
        fn texts(texts: &[&str]) -> Self {
            let s = Script::default();
            for t in texts {
                s.push(Ok(t.to_string()), None);
            }
            s
        }
        fn push(&self, text: Result<String, VoiceError>, gate: Option<mpsc::Receiver<()>>) {
            self.replies.lock().unwrap().push_back(Reply { text, gate });
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
            if let Some(gate) = reply.gate {
                let _ = gate.recv();
            }
            reply.text
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum Ev {
        State(VoiceState, Option<String>),
        Level,
        Transcript(String, u64, String),
        Error(Option<String>, VoiceError),
        Progress(ModelProgress),
        Status,
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Ev>>);

    impl Recorder {
        fn all(&self) -> Vec<Ev> {
            self.0.lock().unwrap().clone()
        }
        fn transcripts(&self) -> Vec<(String, u64, String)> {
            self.all()
                .into_iter()
                .filter_map(|e| match e {
                    Ev::Transcript(w, s, t) => Some((w, s, t)),
                    _ => None,
                })
                .collect()
        }
        fn errors(&self) -> Vec<(Option<String>, VoiceError)> {
            self.all()
                .into_iter()
                .filter_map(|e| match e {
                    Ev::Error(w, err) => Some((w, err)),
                    _ => None,
                })
                .collect()
        }
        fn states(&self) -> Vec<(VoiceState, Option<String>)> {
            self.all()
                .into_iter()
                .filter_map(|e| match e {
                    Ev::State(s, w) => Some((s, w)),
                    _ => None,
                })
                .collect()
        }
        fn progress(&self) -> Vec<ModelProgress> {
            self.all()
                .into_iter()
                .filter_map(|e| match e {
                    Ev::Progress(p) => Some(p),
                    _ => None,
                })
                .collect()
        }
    }

    impl VoiceEvents for Recorder {
        fn state(&self, p: StatePayload) {
            self.0.lock().unwrap().push(Ev::State(p.state, p.window));
        }
        fn level(&self, _p: LevelPayload) {
            self.0.lock().unwrap().push(Ev::Level);
        }
        fn transcript(&self, p: TranscriptPayload) {
            self.0.lock().unwrap().push(Ev::Transcript(p.window, p.seq, p.text));
        }
        fn error(&self, p: ErrorPayload) {
            self.0.lock().unwrap().push(Ev::Error(p.window, p.error));
        }
        fn model_progress(&self, p: ModelProgress) {
            self.0.lock().unwrap().push(Ev::Progress(p));
        }
        fn status_changed(&self, _s: &VoiceStatus) {
            self.0.lock().unwrap().push(Ev::Status);
        }
    }

    type TestCore = VoiceCore<FakeCapture, Recorder>;

    struct Rig {
        core: Arc<TestCore>,
        rec: Arc<Recorder>,
        cap: FakeCapture,
        script: Script,
        _dir: tempfile::TempDir,
    }

    struct Opts {
        enabled: bool,
        installed: bool,
        mic: MicPermission,
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

    fn rig(script: Script, opts: Opts) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        if opts.installed {
            install(dir.path());
        }
        let cap = FakeCapture::default();
        let rec = Arc::new(Recorder::default());
        let mic = opts.mic;
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
        );
        Rig { core, rec, cap, script, _dir: dir }
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn take(core: &TestCore, window: &str, at: Instant) {
        core.begin(window.to_string(), at).unwrap();
        core.end(at + ms(400));
    }

    fn tr(w: &str, seq: u64, t: &str) -> (String, u64, String) {
        (w.to_string(), seq, t.to_string())
    }

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
            vec![tr("a", 1, "first"), tr("b", 2, "second"), tr("a", 3, "third")]
        );
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn second_take_recorded_while_first_transcribes_keeps_order() {
        let script = Script::default();
        let (release, gate) = mpsc::channel();
        script.push(Ok("first".into()), Some(gate));
        script.push(Ok("second".into()), None);
        let r = rig(script, Opts::default());
        let t0 = Instant::now();

        take(&r.core, "a", t0);
        assert_eq!(r.core.state(), VoiceState::Transcribing);
        r.core.begin("b".into(), t0 + ms(1000)).unwrap();
        assert_eq!(r.core.state(), VoiceState::Recording);
        r.core.end(t0 + ms(1400));
        // The first take is still held by the gate, so nothing is out yet.
        assert!(r.rec.transcripts().is_empty());
        assert_eq!(
            r.rec.states(),
            vec![
                (VoiceState::Recording, Some("a".into())),
                (VoiceState::Transcribing, Some("a".into())),
                (VoiceState::Recording, Some("b".into())),
                (VoiceState::Transcribing, Some("b".into())),
            ]
        );

        release.send(()).unwrap();
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("a", 1, "first"), tr("b", 2, "second")]);
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn begin_without_installed_model_is_model_missing_and_does_not_record() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let t0 = Instant::now();
        assert_eq!(r.core.begin("main".into(), t0), Err(VoiceError::ModelMissing));
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.core.state(), VoiceState::Idle);
        // The mic-button path returns the error and emits nothing.
        assert!(r.rec.all().is_empty());

        r.core.hold(HoldAction::Begin, Some("main".into()), t0);
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.rec.all(), vec![Ev::Error(Some("main".into()), VoiceError::ModelMissing)]);
    }

    #[test]
    fn begin_with_denied_mic_is_mic_denied() {
        let r = rig(Script::default(), Opts { mic: MicPermission::Denied, ..Opts::default() });
        let t0 = Instant::now();
        assert_eq!(r.core.begin("main".into(), t0), Err(VoiceError::MicDenied));
        assert_eq!(r.cap.starts(), 0);
        r.core.hold(HoldAction::Begin, Some("main".into()), t0);
        assert_eq!(r.cap.starts(), 0);
        assert_eq!(r.rec.errors(), vec![(Some("main".into()), VoiceError::MicDenied)]);
    }

    #[test]
    fn empty_transcript_emits_nothing() {
        let r = rig(Script::texts(&["   "]), Opts::default());
        take(&r.core, "main", Instant::now());
        r.core.flush();
        assert!(r.rec.transcripts().is_empty());
        assert!(r.rec.errors().is_empty());
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn engine_error_is_emitted_for_the_take() {
        let script = Script::default();
        script.push(Err(VoiceError::Engine("boom".into())), None);
        let r = rig(script, Opts::default());
        take(&r.core, "w2", Instant::now());
        r.core.flush();
        assert_eq!(r.rec.errors(), vec![(Some("w2".into()), VoiceError::Engine("boom".into()))]);
        assert_eq!(r.core.state(), VoiceState::Idle);
    }

    #[test]
    fn disabled_service_ignores_hold_events() {
        let r = rig(Script::texts(&["x"]), Opts { enabled: false, ..Opts::default() });
        let t0 = Instant::now();
        r.core.hold(HoldAction::Begin, Some("main".into()), t0);
        r.core.hold(HoldAction::End, None, t0 + ms(400));
        r.core.flush();
        assert_eq!(r.cap.starts(), 0);
        assert!(r.rec.all().is_empty());
    }

    #[test]
    fn hold_records_in_the_focused_window_only() {
        let r = rig(Script::texts(&["hello"]), Opts::default());
        let t0 = Instant::now();
        r.core.hold(HoldAction::Begin, None, t0);
        assert_eq!(r.cap.starts(), 0);
        r.core.hold(HoldAction::Begin, Some("task-7".into()), t0);
        r.core.hold(HoldAction::End, None, t0 + ms(400));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("task-7", 1, "hello")]);
    }

    #[test]
    fn hold_cancel_discards_the_take() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.hold(HoldAction::Begin, Some("main".into()), t0);
        r.core.hold(HoldAction::Cancel, None, t0 + ms(400));
        r.core.flush();
        assert!(r.rec.transcripts().is_empty());
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn overdue_take_is_ended_by_tick() {
        let r = rig(Script::texts(&["long"]), Opts::default());
        let t0 = Instant::now();
        r.core.begin("main".into(), t0).unwrap();
        assert!(r.core.tick(t0 + Duration::from_secs(299)));
        assert_eq!(r.core.state(), VoiceState::Recording);
        assert!(!r.core.tick(t0 + Duration::from_secs(300)));
        r.core.flush();
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, "long")]);
    }

    #[test]
    fn failed_take_emits_error_and_returns_to_idle() {
        let r = rig(Script::default(), Opts::default());
        r.cap.fail_next_stop(VoiceError::MicUnavailable);
        take(&r.core, "main", Instant::now());
        assert_eq!(r.rec.errors(), vec![(Some("main".into()), VoiceError::MicUnavailable)]);
        assert_eq!(r.core.state(), VoiceState::Idle);
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn short_or_silent_takes_only_return_to_idle() {
        let r = rig(Script::default(), Opts::default());
        let t0 = Instant::now();
        r.core.begin("main".into(), t0).unwrap();
        r.core.end(t0 + ms(100));
        r.cap.0.lock().unwrap().stops.push_back(Ok(vec![0.0; 16_000]));
        take(&r.core, "main", t0 + ms(1000));
        r.core.flush();
        assert!(r.rec.errors().is_empty());
        assert!(r.rec.transcripts().is_empty());
        assert_eq!(r.rec.states().last(), Some(&(VoiceState::Idle, None)));
    }

    #[test]
    fn disabling_cancels_the_take_and_unloads_the_model() {
        let r = rig(Script::texts(&["one", "two"]), Opts::default());
        let t0 = Instant::now();
        take(&r.core, "main", t0);
        r.core.flush();
        assert_eq!(r.script.loads(), 1);

        r.core.begin("main".into(), t0 + ms(1000)).unwrap();
        r.core.set_enabled(false);
        assert_eq!(r.core.state(), VoiceState::Idle);
        r.core.set_enabled(true);
        take(&r.core, "main", t0 + ms(2000));
        r.core.flush();
        // Unloaded on disable, so the next take loads the model again.
        assert_eq!(r.script.loads(), 2);
        assert_eq!(r.rec.transcripts(), vec![tr("main", 1, "one"), tr("main", 2, "two")]);
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

    #[test]
    fn download_reports_failure_and_releases_the_claim() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        assert!(r.core.claim_download(id));
        assert!(!r.core.claim_download(id));
        assert!(r.core.is_downloading(id));
        let result = r.core.run_download(id, Ok(BadFetch));
        assert!(result.is_err());
        assert!(!r.core.is_downloading(id));
        let progress = r.rec.progress();
        let last = progress.last().unwrap();
        assert!(last.done);
        assert!(last.error.as_deref().unwrap().contains("checksum"));
        // 50 chunks in well under 100 ms: throttled to one plus the final event.
        assert!(progress.len() <= 3, "{progress:?}");
        assert!(r.core.claim_download(id));
    }

    #[test]
    fn download_without_a_client_reports_the_error() {
        let r = rig(Script::default(), Opts { installed: false, ..Opts::default() });
        let id = ModelId::WhisperTurbo;
        assert!(r.core.claim_download(id));
        let result = r.core.run_download::<BadFetch>(id, Err("no tls".into()));
        assert_eq!(result, Err("no tls".to_string()));
        let progress = r.rec.progress();
        assert_eq!(progress.len(), 1);
        assert!(progress[0].done);
        assert_eq!(progress[0].error.as_deref(), Some("no tls"));
        assert!(!r.core.is_downloading(id));
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
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({
                "supported": false, "enabled": false, "language": "en", "holdKey": "fn",
                "accessibility": false, "microphone": "undetermined", "state": "idle", "models": []
            })
        );
        assert_eq!(
            serde_json::to_value(ErrorPayload { window: None, error: VoiceError::Engine("x".into()) }).unwrap(),
            serde_json::json!({ "window": null, "error": { "engine": "x" } })
        );
        assert_eq!(
            serde_json::to_value(ModelProgress {
                model: ModelId::WhisperTurbo, received: 1, total: 2, done: false, error: None
            })
            .unwrap(),
            serde_json::json!({ "model": "whisper-turbo", "received": 1, "total": 2, "done": false, "error": null })
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
