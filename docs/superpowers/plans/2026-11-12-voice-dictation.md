# Voice Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold one key anywhere in Verun, speak, release, and the transcript lands in the visible composer, transcribed on-device.

**Architecture:** A new Rust module `src-tauri/src/voice/` owns the hold-key listener, microphone capture, model files and transcription, and knows nothing about the chat UI. It emits state and transcript events addressed to a window label; the frontend store in that window pins the visible composer and inserts the text. Capture, key listening and the model sit behind traits so the state machine is tested without hardware.

**Tech Stack:** Rust, Tauri v2, `transcribe-rs` (Parakeet TDT 0.6B v3 via ONNX Runtime, Whisper large-v3-turbo via whisper.cpp + Metal), `cpal` for capture, CoreGraphics event tap for the hold key, Solid.js + UnoCSS.

**Spec:** `docs/superpowers/specs/2026-11-12-voice-dictation-design.md`

## Global Constraints

- Work in a fresh worktree branched from `main` (branch `voice-dictation`). The worktree this plan was written in is on an unrelated branch. Carry the spec and this plan over.
- TDD: every task writes a failing test, runs it red, then implements. Rust `cargo test`, frontend `pnpm test`.
- No file I/O, process or audio work in JS. No polling from the frontend: events only.
- Never block the tokio runtime: model load, transcription and downloads run in `spawn_blocking` or a dedicated thread.
- Every Tauri command gets a typed wrapper in `src/lib/ipc.ts`.
- `<For>` not `<Index>`. No derived state in stores. UnoCSS rules from `CLAUDE.md` (`ring-1`, explicit directional borders).
- Feature exists only on `cfg(all(target_os = "macos", target_arch = "aarch64"))`. Elsewhere `voice_status().supported` is `false`, the heavy deps are not compiled, and no UI shows.
- Off by default: with `voice.enabled` unset, no event tap, no permission prompt, no model on disk, nothing loaded.
- Audio is held in memory only, never written to disk, dropped after transcription.
- Exact values: minimum hold `300 ms`; maximum take `5 min`; idle model unload `5 min`; default hold key `Fn`; capture format `16 kHz mono f32`.
- Language to model: Parakeet v3 for `en fr es pt ru de`; Whisper turbo for `ar zh hi bn ur ja`, always with the language passed explicitly.
- No em dashes in copy, comments or docs. Use hyphens.
- Main window and detached task window (`TaskWindowShell.tsx`) share one implementation.

## Review Focus

1. **A second hold starts while the previous take is still transcribing.** Expected: recording starts at once, and the two transcripts land in spoken order. Test in Task 2.
2. **The composer holds file-mention and attachment badges.** Expected: dictated text is inserted without removing or reordering badges. Test in Task 8.
3. **The user Cmd-Tabs away while holding, then releases.** Expected: the take ends normally and the text lands in the composer pinned at hold start. Test in Task 3.
4. **The microphone disappears mid-take (AirPods disconnect).** Expected: the take fails with a notice, state returns to idle, the next hold works. Test in Task 2.
5. **A model download is interrupted or the file is corrupt.** Expected: checksum mismatch is reported, the partial file is removed, the model shows as not installed, a retry works. Test in Task 6.

---

### Task 0: Bake-off spike (gate)

Throwaway. No tests, not committed, lives outside the repo (for example `$TMPDIR/verun-voice-bakeoff`).

- [ ] **Step 1:** Build a small cargo binary that takes a WAV path and a language, runs it through `transcribe-rs` with Parakeet TDT 0.6B v3 (`onnx` + `ort-coreml`) and Whisper large-v3-turbo (`whisper-cpp` + `whisper-metal`), and prints transcript, wall time and peak RSS. Try at least two quantizations of each model.
- [ ] **Step 2:** Have the user record clips of about 5, 15 and 60 seconds in English, French, Spanish and Modern Standard Arabic, plus one 5 minute clip. Run all of them.
- [ ] **Step 3:** Write a 20 line CGEventTap test that logs `Fn`, Right Option and Right Command down/up, and note whether holding `Fn` triggers the system emoji or dictation action and whether returning `NULL` from an active tap suppresses it.
- [ ] **Step 4:** Report to the user: accuracy per language (their judgement), time from release to text, memory loaded and after unload, chosen model files with URLs, sizes and SHA-256, `Fn` verdict, whether 5 minute clips need chunking.
- [ ] **Step 5: Gate.** Continue only when: a 10 second clip returns in about 1 second on the user's machine, and the user accepts the Arabic output. If Arabic fails, repeat with Cohere Transcribe Arabic through the `onnx` feature. If speed or memory fails, stop: the FluidAudio sidecar fallback is a spec change and goes back to the user. If `Fn` cannot be used cleanly, the default hold key in Task 3 becomes Right Option.

Outputs consumed later: model URLs, sizes, checksums (Task 1), `Fn` verdict (Task 3), chunking need (Task 5).

---

### Task 1: Languages, routing and model catalog

**Files:**
- Create: `src-tauri/src/voice/mod.rs`, `src-tauri/src/voice/catalog.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod voice;`)

**Interfaces (produces):**

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language { En, Fr, Es, Ar, Zh, Hi, Pt, Ru, Bn, Ur, Ja, De }
impl Language { pub const ALL: [Language; 12]; pub fn code(self) -> &'static str; pub fn from_code(s: &str) -> Option<Language>; }

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelId { ParakeetV3, WhisperTurbo }

pub struct ModelFile { pub url: &'static str, pub rel_path: &'static str, pub sha256: &'static str, pub bytes: u64 }
pub struct ModelSpec { pub id: ModelId, pub display_name: &'static str, pub files: &'static [ModelFile] }

pub fn model_for(lang: Language) -> ModelId;
pub fn spec(id: ModelId) -> &'static ModelSpec;
```

- [ ] **Step 1: Failing tests** in `catalog.rs`:
  - `routes_european_languages_to_parakeet`: `model_for` of `En, Fr, Es, Pt, Ru, De` is `ParakeetV3`.
  - `routes_other_languages_to_whisper`: `Ar, Zh, Hi, Bn, Ur, Ja` give `WhisperTurbo`.
  - `every_language_round_trips_its_code`: `Language::from_code(l.code()) == Some(l)` for all of `ALL`.
  - `catalog_entries_are_complete`: for both models, `files` is non-empty, every `url` starts with `https://`, every `sha256` is 64 hex chars, every `bytes > 0`.
- [ ] **Step 2:** `cargo test voice::catalog` fails to compile.
- [ ] **Step 3:** Implement. File URLs, sizes and checksums come from Task 0.
- [ ] **Step 4:** `cargo test voice::catalog` passes.
- [ ] **Step 5:** Commit `voice: languages, routing, model catalog`.

---

### Task 2: Dictation state machine

**Files:**
- Create: `src-tauri/src/voice/session.rs`

**Interfaces:**
- Consumes: `Language` (Task 1).
- Produces:

```rust
pub const MIN_HOLD: Duration = Duration::from_millis(300);
pub const MAX_TAKE: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceError { MicDenied, MicUnavailable, ModelMissing, Engine(String) }

pub trait Capture: Send {
    fn start(&mut self) -> Result<(), VoiceError>;
    /// 16 kHz mono samples recorded since `start`. Err if the device was lost.
    fn stop(&mut self) -> Result<Vec<f32>, VoiceError>;
    fn cancel(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceState { Idle, Recording, Transcribing }

/// A finished recording waiting for the engine. `seq` increases by one per take.
pub struct PendingTake { pub seq: u64, pub window: String, pub lang: Language, pub samples: Vec<f32> }

pub enum EndOutcome { NotRecording, TooShort, Silent, Failed { window: String, error: VoiceError }, Pending(PendingTake) }

pub struct Dictation<C: Capture> { /* private */ }
impl<C: Capture> Dictation<C> {
    pub fn new(capture: C) -> Self;
    pub fn begin(&mut self, window: String, lang: Language, now: Instant) -> Result<(), VoiceError>;
    pub fn end(&mut self, now: Instant) -> EndOutcome;
    pub fn cancel(&mut self);
    /// Called when the engine has finished take `seq`.
    pub fn transcribed(&mut self, seq: u64);
    /// Recording wins over Transcribing; Idle when neither.
    pub fn state(&self) -> VoiceState;
    /// True when the current take has run for MAX_TAKE and must be ended.
    pub fn overdue(&self, now: Instant) -> bool;
}

pub fn is_silent(samples: &[f32]) -> bool;
```

- [ ] **Step 1: Failing tests** with a `FakeCapture` (scripted samples, optional `stop` error):
  - `hold_under_300ms_is_ignored`: begin, end at +299 ms gives `TooShort`, capture was cancelled, state `Idle`.
  - `hold_of_300ms_yields_pending_take`: end at +300 ms gives `Pending` with the window, language and samples.
  - `silent_take_is_dropped`: all-zero samples give `Silent`.
  - `end_without_begin_is_not_recording`.
  - `begin_while_recording_is_a_no_op`: second `begin` returns `Ok`, the take keeps the first window.
  - `begin_is_allowed_while_transcribing` (Review Focus 1): after a `Pending` take, `begin` succeeds, `state()` is `Recording`; the second take's `seq` is first + 1; after `end` and `transcribed(first)` state is `Transcribing`; after `transcribed(second)` it is `Idle`.
  - `lost_device_fails_the_take_and_recovers` (Review Focus 4): `stop` returns `Err(MicUnavailable)`; `end` gives `Failed` with that error; state `Idle`; a following `begin` succeeds.
  - `mic_denied_on_start_is_reported`: `start` error is returned from `begin`, state stays `Idle`.
  - `take_is_overdue_after_five_minutes`: `overdue` false at +299 s, true at +300 s.
  - `cancel_discards_the_take`: state `Idle`, `end` afterwards gives `NotRecording`.
  - `is_silent`: zeros are silent; a 440 Hz sine at amplitude 0.1 is not.
- [ ] **Step 2:** `cargo test voice::session` fails.
- [ ] **Step 3:** Implement. `is_silent` is an RMS threshold over the whole clip; pick the threshold so room noise from the Task 0 clips is silent and quiet speech is not.
- [ ] **Step 4:** `cargo test voice::session` passes.
- [ ] **Step 5:** Commit `voice: dictation state machine`.

---

### Task 3: Hold-key detector and macOS listener

**Files:**
- Create: `src-tauri/src/voice/hold.rs` (pure), `src-tauri/src/voice/hotkey_macos.rs` (event tap, `cfg` gated)
- Modify: `src-tauri/Cargo.toml` (macOS target deps for CoreGraphics / ApplicationServices bindings)

**Interfaces (produces):**

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HoldKey { Fn, RightOption, RightCommand }
impl Default for HoldKey { /* Fn, or RightOption if Task 0 ruled Fn out */ }

pub enum KeyEvent { HoldDown, HoldUp, OtherKeyDown }
#[derive(Debug, PartialEq)]
pub enum HoldAction { Begin, End, Cancel, None }

pub struct HoldDetector { /* private */ }
impl HoldDetector { pub fn new() -> Self; pub fn on(&mut self, ev: KeyEvent, verun_frontmost: bool) -> HoldAction; }

// hotkey_macos.rs
pub fn accessibility_granted() -> bool;
pub fn open_accessibility_settings();
pub struct HotkeyListener; // dropping it removes the tap
impl HotkeyListener { pub fn start(key: HoldKey, on_event: impl Fn(KeyEvent) + Send + 'static) -> Option<HotkeyListener>; }
```

- [ ] **Step 1: Failing tests** in `hold.rs`:
  - `down_then_up_begins_and_ends` (frontmost true).
  - `down_when_verun_is_not_frontmost_does_nothing`, and the matching `HoldUp` also gives `None`.
  - `release_after_losing_focus_still_ends` (Review Focus 3): `HoldDown` frontmost, `HoldUp` not frontmost gives `End`.
  - `other_key_during_hold_cancels`: `HoldDown`, `OtherKeyDown` gives `Cancel`; the later `HoldUp` gives `None`.
  - `other_key_without_hold_does_nothing`.
  - `repeated_down_is_ignored`: second `HoldDown` gives `None`.
- [ ] **Step 2:** `cargo test voice::hold` fails.
- [ ] **Step 3:** Implement `HoldDetector`.
- [ ] **Step 4:** `cargo test voice::hold` passes.
- [ ] **Step 5:** Implement `hotkey_macos.rs`: a CGEventTap on its own thread with a run loop, translating flags-changed and key-down events into `KeyEvent` for the chosen `HoldKey`. `start` returns `None` when `accessibility_granted()` is false. Apply the Task 0 finding on suppressing the system `Fn` action. No unit test; verified by hand in Task 7.
- [ ] **Step 6:** `cargo check && cargo clippy` clean. Commit `voice: hold-key detector and macOS listener`.

---

### Task 4: Microphone capture

**Files:**
- Create: `src-tauri/src/voice/capture.rs`
- Modify: `src-tauri/Cargo.toml` (`cpal`, a resampler crate), `src-tauri/Info.plist`, `src-tauri/tests/microphone_bundle.rs`

**Interfaces:**
- Consumes: `Capture`, `VoiceError` (Task 2).
- Produces:

```rust
pub fn to_mono_16k(input: &[f32], channels: u16, sample_rate: u32) -> Vec<f32>;
pub fn level(samples: &[f32]) -> f32; // 0.0..=1.0

pub struct MicCapture { /* private */ }
impl MicCapture { pub fn new(on_level: impl Fn(f32) + Send + Sync + 'static) -> Self; }
impl Capture for MicCapture { /* ... */ }
```

- [ ] **Step 1: Failing tests:**
  - `stereo_48k_becomes_mono_16k`: 48 000 stereo frames in, 16 000 samples out (within 1%).
  - `mono_16k_passes_through_unchanged`.
  - `resampled_tone_keeps_its_pitch`: a 440 Hz tone at 44.1 kHz still has about 440 zero-crossing pairs per second.
  - `level_is_zero_for_silence_and_bounded`: zeros give `0.0`; a full-scale sine is at most `1.0`.
  - In `tests/microphone_bundle.rs`, add `microphone_usage_text_mentions_dictation`: the `NSMicrophoneUsageDescription` string contains `dictation`.
- [ ] **Step 2:** Both test targets fail.
- [ ] **Step 3:** Implement. `MicCapture` opens the default input device on `start`, buffers in memory, calls `on_level` at most 15 times a second, and reports a stream error or vanished device as `Err(MicUnavailable)` from `stop`. Update `Info.plist` to: `Verun uses your microphone for voice dictation and for terminal applications such as Claude Code.`
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `voice: microphone capture`.

---

### Task 5: Transcription engine

**Files:**
- Create: `src-tauri/src/voice/engine.rs`
- Modify: `src-tauri/Cargo.toml` (`transcribe-rs` with the features proven in Task 0, under the macOS aarch64 target table)

**Interfaces:**
- Consumes: `Language`, `ModelId`, `model_for`, `VoiceError`.
- Produces:

```rust
pub const IDLE_UNLOAD: Duration = Duration::from_secs(300);

pub trait Transcriber: Send {
    fn transcribe(&mut self, samples: &[f32], lang: Language) -> Result<String, VoiceError>;
}

/// Loads a model for `id` from `dir`. Abstracted so the cache is testable.
pub trait ModelLoader: Send { type Model: Transcriber; fn load(&self, id: ModelId, dir: &Path) -> Result<Self::Model, VoiceError>; }

pub struct Engine<L: ModelLoader> { /* at most one loaded model, last-used time */ }
impl<L: ModelLoader> Engine<L> {
    pub fn new(loader: L, models_dir: PathBuf) -> Self;
    pub fn transcribe(&mut self, samples: &[f32], lang: Language, now: Instant) -> Result<String, VoiceError>;
    /// Drops the loaded model if unused for IDLE_UNLOAD. Returns true if it unloaded.
    pub fn unload_if_idle(&mut self, now: Instant) -> bool;
    pub fn loaded(&self) -> Option<ModelId>;
}

pub struct TranscribeRsLoader; // real ModelLoader
pub fn clean_transcript(raw: &str) -> String; // trim, collapse whitespace
```

- [ ] **Step 1: Failing tests** with a `FakeLoader` that counts loads:
  - `loads_the_model_routed_for_the_language`: `Fr` loads `ParakeetV3`, `Ar` loads `WhisperTurbo`.
  - `reuses_a_loaded_model`: two `En` takes, one load.
  - `switching_language_family_swaps_the_model`: `En` then `Ar` leaves only `WhisperTurbo` loaded.
  - `unloads_after_five_idle_minutes`: false at +299 s, true at +300 s, `loaded()` is `None`.
  - `missing_model_files_give_model_missing`: loader error maps to `VoiceError::ModelMissing`.
  - `clean_transcript_trims_and_collapses`: `"  hello \n  world "` gives `"hello world"`; empty stays empty.
- [ ] **Step 2:** `cargo test voice::engine` fails.
- [ ] **Step 3:** Implement `Engine`, then `TranscribeRsLoader` using the model files and settings chosen in Task 0. Whisper always receives the language. Add chunking only if Task 0 showed 5 minute clips need it.
- [ ] **Step 4:** Tests pass. Add one `#[ignore]` test `transcribes_a_real_clip` that runs a fixture WAV through the real loader when models are present; run it by hand once.
- [ ] **Step 5:** Commit `voice: transcription engine with idle unload`.

---

### Task 6: Model download and storage

**Files:**
- Create: `src-tauri/src/voice/models.rs`

**Interfaces:**
- Consumes: `ModelId`, `ModelSpec`, `spec`.
- Produces:

```rust
#[derive(Serialize)] pub struct ModelStatus { pub id: ModelId, pub display_name: &'static str, pub installed: bool, pub bytes: u64 }

pub fn models_dir(app_data: &Path) -> PathBuf;            // <app_data>/voice-models
pub fn is_installed(dir: &Path, id: ModelId) -> bool;     // every file present with the catalog size
pub fn status(dir: &Path) -> Vec<ModelStatus>;
pub fn delete(dir: &Path, id: ModelId) -> std::io::Result<()>;

pub trait Fetch: Send + Sync { fn get(&self, url: &str, sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>) -> std::io::Result<()>; }
/// Downloads to `<file>.part`, verifies SHA-256, renames into place.
pub fn download(dir: &Path, id: ModelId, fetch: &dyn Fetch, on_progress: &dyn Fn(u64, u64)) -> Result<(), DownloadError>;
#[derive(Debug, PartialEq)] pub enum DownloadError { Network(String), Checksum { file: String }, Io(String) }
```

- [ ] **Step 1: Failing tests** using `tempfile` and a `FakeFetch`:
  - `not_installed_when_files_are_missing`, `installed_when_all_files_match_size`.
  - `download_writes_files_and_reports_progress`: progress ends at `(total, total)`, model is installed.
  - `checksum_mismatch_removes_the_partial_file` (Review Focus 5): fetch returns wrong bytes; result is `Checksum`, no `.part` or final file remains, `is_installed` false.
  - `interrupted_download_leaves_model_uninstalled_and_retry_succeeds` (Review Focus 5): first fetch errors half way, second succeeds.
  - `delete_removes_the_model_files`.
- [ ] **Step 2:** `cargo test voice::models` fails.
- [ ] **Step 3:** Implement, plus a real `Fetch` over HTTPS (add an HTTP client crate if the tree has none; check `Cargo.lock` first and reuse).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `voice: model download and storage`.

---

### Task 7: Service, commands and events

**Files:**
- Create: `src-tauri/src/voice/service.rs`
- Modify: `src-tauri/src/voice/mod.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs` (`.manage`, handler list, start on setup when enabled), `src/lib/ipc.ts`, `src/types/` (new `voice.ts`)

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces, Rust:

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct VoiceStatus { pub supported: bool, pub enabled: bool, pub language: Language, pub hold_key: HoldKey,
    pub accessibility: bool, pub microphone: MicPermission, pub state: VoiceState, pub models: Vec<ModelStatus> }
#[derive(Serialize)] #[serde(rename_all = "lowercase")] pub enum MicPermission { Granted, Denied, Undetermined }
```

Settings persist in the `app_meta` table (helpers near `db.rs:1944`) under keys `voice.enabled`, `voice.language`, `voice.hold_key`. Defaults: `false`, `en`, `HoldKey::default()`.

Commands (each with a wrapper of the same name in camelCase in `src/lib/ipc.ts`):

| Command | Args | Returns |
|---|---|---|
| `voice_status` | none | `VoiceStatus` |
| `voice_set_enabled` | `enabled: bool` | `VoiceStatus` |
| `voice_set_language` | `language: Language` | `VoiceStatus` |
| `voice_set_hold_key` | `key: HoldKey` | `VoiceStatus` |
| `voice_begin` | `window: String` | `Result<(), VoiceError>` |
| `voice_end` | none | `()` |
| `voice_cancel` | none | `()` |
| `voice_download_model` | `model: ModelId` | `()` (progress by event) |
| `voice_delete_model` | `model: ModelId` | `VoiceStatus` |
| `voice_request_microphone` | none | `MicPermission` |
| `voice_open_accessibility_settings` | none | `()` |

Events (payloads camelCase):

| Event | Payload |
|---|---|
| `voice-state` | `{ state: VoiceState, window: string \| null }` |
| `voice-level` | `{ level: number }` |
| `voice-transcript` | `{ window: string, seq: number, text: string }` |
| `voice-error` | `{ window: string \| null, error: VoiceError }` |
| `voice-model-progress` | `{ model: ModelId, received: number, total: number, done: boolean, error: string \| null }` |
| `voice-status-changed` | `VoiceStatus` |

Behaviour to implement in `service.rs`:
- Hold key `Begin` uses the label of the focused Verun window as `window`; if none is focused the detector already returned `None`.
- `begin` returns `ModelMissing` without recording when the model for the current language is not installed.
- Takes go through one FIFO worker thread, so `voice-transcript` events are emitted in `seq` order. Empty transcripts emit nothing.
- A timer ends a take when `overdue`, and calls `unload_if_idle`.
- The hotkey listener starts when `enabled && accessibility`. `voice_status` re-checks accessibility; when it flips to granted the listener starts without a restart. Disabling stops the listener and unloads the model.

- [ ] **Step 1: Failing tests:**
  - Rust, `service.rs`, with fake capture, loader and an event recorder: `transcripts_are_emitted_in_take_order`; `begin_without_installed_model_is_model_missing_and_does_not_record`; `empty_transcript_emits_nothing`; `disabled_service_ignores_hold_events`; `settings_round_trip_through_app_meta` (in-memory sqlite).
  - Frontend, `src/lib/ipc.test.ts`: each new wrapper invokes the matching command name with the documented argument keys.
- [ ] **Step 2:** `cargo test voice::service` and `pnpm test ipc` fail.
- [ ] **Step 3:** Implement service, commands, wrappers and TypeScript types mirroring the Rust ones.
- [ ] **Step 4:** Tests pass; `cargo clippy` clean.
- [ ] **Step 5:** Manual check in `pnpm tauri dev`: enable through a temporary `voiceSetEnabled(true)` call from devtools, grant permissions, hold the key, see `voice-state` and `voice-transcript` in the console. Note: the unbundled dev binary needs its own Accessibility grant.
- [ ] **Step 6:** Commit `voice: service, commands, events`.

---

### Task 8: Frontend store, targets and insertion

**Files:**
- Create: `src/lib/dictationInsert.ts`, `src/lib/dictationInsert.test.ts`, `src/store/voice.ts`, `src/store/voice.test.ts`
- Modify: `src/store/sessionDrafts.ts` (add `appendToDraft`)

**Interfaces:**
- Consumes: ipc wrappers and event payload types (Task 7), `addToast` from `src/store/ui.ts`, `windowContext.ts` for the window label.
- Produces:

```ts
// dictationInsert.ts
export interface Selection { start: number; end: number }
/** Insert at `sel` when given, else append. Adds one space between existing text and the take when neither side has whitespace. */
export function insertDictation(existing: string, take: string, sel: Selection | null): { text: string; cursor: number }

// sessionDrafts.ts
export function appendToDraft(sid: string, take: string): void

// voice.ts
export interface DictationTarget {
  /** Stable id: `session:<sid>` or `new-task`. */
  id: string
  sessionId: string | null
  insert(take: string): void
}
export const voiceStatus: Accessor<VoiceStatus | null>
export const voiceState: Accessor<VoiceState>
export const voiceLevel: Accessor<number>
export function registerDictationTarget(t: DictationTarget): () => void   // returns unregister
export function initVoice(): Promise<void>                                // listeners; called from app init in both window shells
export function toggleDictation(): void                                   // mic button
```

Store rules: a `voice-state` event with `Recording` for this window pins the currently registered target. If none is registered, call `voiceCancel()` and toast `Dictation works in the chat box and the new task box.` On `voice-transcript` for this window: if the pinned target is still registered, `insert`; else if it had a `sessionId` and that session still exists, `appendToDraft` and toast `Dictation saved to the draft of the chat you were in.`; else toast `Dictation dropped: that chat is gone.` Events for other windows are ignored. `voice-error` with `model-missing` opens the download prompt (Task 10); other errors toast.

- [ ] **Step 1: Failing tests:**
  - `dictationInsert.test.ts`: append to empty gives the take; `"hello"` + `"world"` gives `"hello world"`; existing trailing space or newline adds no extra space; insert at a cursor in the middle pads both sides only where needed; a non-collapsed selection is replaced; returned `cursor` sits after the take.
  - `voice.test.ts` with mocked ipc/events: text goes to the target registered at recording start even if another target registers before the transcript; unregistered target with a live session appends to its draft and toasts; unregistered target with a dead session toasts and writes nothing; recording with no target calls `voiceCancel` and toasts; events for another window label are ignored; two transcripts insert in `seq` order.
- [ ] **Step 2:** `pnpm test dictationInsert voice` fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass; `pnpm check` clean.
- [ ] **Step 5:** Commit `voice: frontend store, targets, insertion`.

---

### Task 9: Composer integration

**Files:**
- Create: `src/components/DictationControl.tsx`, `src/components/DictationControl.test.tsx`
- Modify: `src/components/MessageInput.tsx`, `src/components/NewTaskView.tsx`; confirm `TaskWindowShell.tsx` and `Layout.tsx` both call `initVoice()` through the shared app-init path (`src/lib/appInit.ts`)

**Interfaces:**
- Consumes: `registerDictationTarget`, `voiceState`, `voiceLevel`, `voiceStatus`, `toggleDictation`, `insertDictation`.
- Produces: `<DictationControl />`, one component used by both composers: mic button, recording indicator with live level, transcribing state, and the quick language switcher (installed languages, plus `Add language...` which opens Settings on the dictation section).

- [ ] **Step 1: Failing tests:**
  - `DictationControl.test.tsx`: renders nothing when `supported` is false; shows the mic button when supported; shows the recording indicator in `Recording` and a working state in `Transcribing`; clicking the button calls `toggleDictation`; the switcher lists only languages whose model is installed and calls `voiceSetLanguage`.
  - `MessageInput` test (new file `MessageInput.dictation.test.tsx`): mounting with a session registers target `session:<sid>` and unmounting unregisters; `insert("world")` on a draft `"hello"` gives `"hello world"`; **badges survive** (Review Focus 2): with a file-mention badge in the input, `insert` leaves the badge in place and in order; when the input is focused with a caret, text goes in at the caret.
  - `NewTaskView` test: registers target `new-task`; `insert` appends to the prompt textarea.
- [ ] **Step 2:** `pnpm test DictationControl MessageInput.dictation NewTaskView` fails.
- [ ] **Step 3:** Implement. In `MessageInput`, build `insert` on the existing serialize/`setMessage` path so badge handling stays in one place; do not add a second DOM-writing path. Place `<DictationControl />` in each composer's action row.
- [ ] **Step 4:** Tests pass; `pnpm check` clean.
- [ ] **Step 5:** Manual check in the main window and a detached task window.
- [ ] **Step 6:** Commit `voice: dictation in the chat and new-task composers`.

---

### Task 10: Settings and first-run flow

**Files:**
- Create: `src/components/DictationSettings.tsx`, `src/components/DictationSettings.test.tsx`, `src/components/DictationSetupDialog.tsx`, `src/components/DictationSetupDialog.test.tsx`
- Modify: `src/components/SettingsPage.tsx` (new built-in section `dictation`, added to `BUILT_IN_SECTIONS` so the Cmd+digit mapping stays derived), `src/store/voice.ts` (open the dialog on first mic press and on `model-missing`)

**Interfaces:**
- Consumes: `voiceStatus` and the Task 7 wrappers; existing `Dialog`, `DialogFooter`, `openSettings`.
- Produces: `openDictationSetup(language?: Language): void` exported from `src/store/voice.ts`.

Setup dialog steps, in order, each skipped when already satisfied: microphone permission; language choice; model download showing the size from `ModelStatus.bytes` and asking before it starts, with progress from `voice-model-progress`; Accessibility permission with a button that calls `voiceOpenAccessibilitySettings`, and a `Skip, use the button only` option. Finishing calls `voiceSetEnabled(true)`.

Settings section: enable toggle; language; hold key (`Fn`, Right Option, Right Command); permission states with fix buttons, the hold key row reading `Needs Accessibility permission` when not granted; installed models with size and delete.

- [ ] **Step 1: Failing tests:**
  - Dialog: steps already satisfied are skipped; download does not start until confirmed and the confirm text includes the size; a download error shows a retry; skipping Accessibility still enables dictation.
  - Settings: section hidden when `supported` is false; toggling calls `voiceSetEnabled`; changing the key calls `voiceSetHoldKey`; delete calls `voiceDeleteModel`; `settingsSectionForShortcut` still maps digits in nav order with the new section.
  - `voice.test.ts`: `toggleDictation` while disabled opens setup, not recording; `voice-error` `model-missing` opens setup at the download step.
- [ ] **Step 2:** Tests fail.
- [ ] **Step 3:** Implement, following the existing Settings and dialog styling.
- [ ] **Step 4:** Tests pass; `pnpm check` clean.
- [ ] **Step 5:** Commit `voice: settings and first-run setup`.

---

### Task 11: Docs and end-to-end check

**Files:**
- Modify: `CHANGELOG.md` (bullet under `## Unreleased`), `README.md` (Features list). `ROADMAP.md` is left alone: "Voice mode" stays unchecked.

- [ ] **Step 1:** `make check` passes with zero clippy warnings and zero TypeScript errors.
- [ ] **Step 2:** In `pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications`, walk the spec's "Done when" list: each of English, French, Spanish, Arabic; a second hold appends; hold under 300 ms does nothing; Settings open gives the notice; switching task mid-transcription lands in the draft; detached window parity; dictation off means no listener and no prompts.
- [ ] **Step 3:** With Activity Monitor open, confirm memory drops about 5 minutes after the last take and CPU is idle between takes.
- [ ] **Step 4:** Update the docs. Commit `voice: docs`.
- [ ] **Step 5:** `gh issue list --search "voice OR dictation"` and reference matches in the PR description.
