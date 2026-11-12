# Voice dictation

**Date:** 2026-11-12
**Status:** Approved 2026-11-12

## Intent

The user talks to agents all day and wants to speak messages instead of typing
them. Hold one key anywhere in Verun, talk, release, and the words are in the
chat box ready to send. Everything runs on the device: no audio leaves the
machine, and the app must stay light when dictation is idle.

The same engine and the same key should later work in any app (Slack, a
browser), the way Wispr Flow does. That is phase 2. This document covers
phase 1 (inside Verun) and shapes the code so phase 2 is an addition, not a
rewrite.

## Goals

- Hold a single key to record, release to transcribe. Works anywhere in Verun,
  whatever has focus.
- The text lands in the composer of the task shown in the focused Verun
  window. It is not sent. The user reviews and presses Enter.
- Hold, release, hold again continues the same message: each take is added to
  what is already in the box.
- A mic button in the composer does the same thing by mouse (press to start,
  press to stop).
- Accurate transcription in English, French, Spanish and Modern Standard
  Arabic first, then the rest of the most spoken languages (Mandarin, Hindi,
  Portuguese, Russian, Bengali, Urdu, Japanese, German).
- Fully on-device. Audio is held in memory only and dropped after
  transcription.
- No cost when unused: nothing loaded, no key listener, no permission prompt
  until the user turns dictation on.
- Main window and detached task windows behave the same.

## Non-goals (phase 1)

- Dictating into other apps. Phase 2.
- Words appearing while the user is still speaking. Accuracy matters more;
  text appears after release.
- Sending automatically.
- Switching language mid-sentence, or auto-detecting the language.
- Voice commands, punctuation commands, or an LLM clean-up pass over the text.
- Text-to-speech or a spoken conversation mode.
- Dictating into the terminal view of a session or into shell terminals.
- Windows and Linux. The feature is compiled and shown on macOS only.

## Anti-goals

- Text sent or inserted somewhere the user did not expect.
- A model sitting in memory, or a fan spinning, while the user is not
  dictating.
- Invented text from silence or background noise.
- A permission prompt or a large download for a user who never asked for
  dictation.

## Decided with the user

- Shortcut is the main way in; the button is secondary.
- The shortcut must not depend on the input having focus.
- Hold to talk. Repeated holds append.
- Text lands in the box; the user sends it.
- Transcribe after release, not live.
- A single-key hold, accepting that it needs macOS Accessibility permission. A
  modifier combo was rejected as too complicated.
- Languages as listed in Goals. Arabic is Modern Standard.
- Language switching mid-sentence is later.
- Phase 1 is in-app; the cross-app version is wanted afterwards.

## Design calls (mine, not yet confirmed by the user)

### Engine and models

- Engine: the `transcribe-rs` crate (MIT), in-process in Rust, running Whisper
  through whisper.cpp with Metal. It is what Handy, a Tauri 2 dictation app,
  was built on.
- One model in v1: **Whisper large-v3-turbo** (q5_0, 574 MB) for every
  language, always with the language passed explicitly. The user chose this
  after the bake-off (see Phase 0 result): on their own voice it beat
  Parakeet in French, matched it in English while dropping filler words, and
  it uses about half the memory.
- The routing is still one table from language to model, so adding a model
  later (Parakeet as an optional faster English model, or Cohere Transcribe
  Arabic) is a table change plus a catalog entry.
- Models are not bundled. Each is downloaded on first need into the app data
  directory, with progress shown, a checksum verified, and a way to delete it
  in Settings.
- A loaded model is released after about 5 idle minutes.

### Shortcut

- Default key: `Fn`. Configurable in Settings; at least Right Option and Right
  Command are offered as alternatives.
- Known risk: macOS gives `Fn` its own action (emoji picker, system
  dictation). If that cannot be suppressed cleanly, the default becomes Right
  Option. The spike settles this.
- The key listener is system-wide by nature. In phase 1 it only acts when a
  Verun window is frontmost; otherwise the key behaves as normal.
- A hold shorter than about 300 ms is ignored.
- A recording stops by itself after 5 minutes.
- If the key is used with another key (for example `Fn` + arrow), it is not a
  dictation hold. Recording that had started is cancelled.

### Where the text goes

- Target: the visible composer of the focused Verun window. That is the chat
  input of the selected session, or the new-task composer when that is what
  is showing.
- If the composer has focus, the text goes in at the cursor. Otherwise it is
  added at the end. A space is added between existing text and the new take
  when needed.
- The target is fixed when the hold starts. Switching task while transcribing
  does not redirect the text.
- If there is no composer in view (Settings open, terminal view, no task
  selected), the hold does nothing except a short notice saying where
  dictation works.

### Feedback

- While recording: an indicator in the composer with a live input level, so
  the user can see the mic is hearing them.
- While transcribing: a brief working state in the same place.
- Empty or silent takes insert nothing. Clips with no speech are dropped
  before the model runs, so Whisper cannot invent text.

### Turning it on

- Dictation is off by default. It is turned on in Settings, or by pressing
  the mic button for the first time.
- Turning it on walks through, in order: microphone permission, choosing a
  language, downloading that language's model, and Accessibility permission
  for the hold key (with a link to the right System Settings pane).
- The mic button works without Accessibility. Only the hold key needs it.
- The quick language switcher sits beside the mic button and lists languages
  whose model is installed, plus a way to add another.
- The existing microphone usage text in `Info.plist` mentions only terminal
  apps and needs to cover dictation too.

### Edge cases

- **Intel Macs:** dictation is hidden on Intel builds in phase 1. Verun ships
  both architectures; only Apple Silicon gets the feature. (Recommended to
  the user, who approved the design without commenting on it.)

- **Accessibility declined or skipped:** dictation is still on, button only.
  Settings shows the hold key as needing permission. Once permission is
  granted the listener attaches without a restart.
- **Language scope:** one dictation language for the whole app. Every
  composer's switcher shows and changes the same value.
- **Which inputs count:** only the session chat input (`MessageInput`) and
  the new-task composer (`NewTaskView`). Message editing, quick-task prompts
  and other fields are not targets.
- **Target gone at release** (session switched, window closed, composer
  disabled): if the session still exists, the text is added to that
  session's saved draft and a notice says so. If the session is gone, the
  text is dropped with a notice.
- **Model not installed for the chosen language:** nothing is recorded. A
  prompt shows the download size and asks before downloading. Dictation in
  that language works once the download finishes.
- **Microphone already in use** by a terminal session (Claude Code's own
  `/voice`): no special handling. macOS allows both to capture.
- **ROADMAP:** the "Voice mode" item under Exploring stays unchecked, since
  spoken conversation is not built here. No roadmap item is added.

### Shape of the code

- All audio capture, key listening, model handling and transcription live in
  Rust, in a new module that knows nothing about the chat UI. It exposes:
  start, stop, cancel, current state, and a transcript result. The frontend
  only listens for state and transcript events and inserts text.
- This boundary is what makes phase 2 cheap: a second consumer takes the same
  transcript and pastes it into the frontmost app.
- Capture, the key listener and the model sit behind small interfaces so the
  state machine (idle, recording, transcribing), the language routing, the
  short-tap rule and the text insertion can all be tested without a
  microphone. The project rule is test first.
- Model loading and transcription run off the async runtime.
- Every new command gets a typed wrapper in `src/lib/ipc.ts`. No polling:
  state, input level and download progress arrive as events.

## Phase 0: spike before building

A throwaway bake-off, not kept, run on the user's machine with the user's own
voice in English, French, Spanish and Arabic. It has not been run yet. It is
the first step of the plan and a gate: the build plan after it is conditional
on what it finds. It answers:

1. Is Whisper large-v3-turbo good enough on the user's Modern Standard
   Arabic? If not, try Cohere Transcribe Arabic.
2. Speed: time from release to text for clips of about 5, 15 and 60 seconds,
   for both models. Target is about one second for a 10 second clip on Apple
   Silicon.
3. Memory while loaded, and that it is returned after unload.
4. Which model file variants (quantization) to ship.
5. Whether `Fn` can be used as a hold key without triggering the system
   action.
6. Whether `transcribe-rs` handles clips up to 5 minutes, or needs chunking.

### Result (2026-11-12, M2 Pro, 16 GB)

- Whisper q5_0: 0.7 to 1.2 s from release to text for clips of 3 to 30 s;
  a 5 minute clip in about 15 s. About 720 MB while loaded, about 90 MB
  after unload. No chunking needed.
- Parakeet v3: faster on short clips (0.1 to 0.5 s) but 1.2 to 1.6 GB while
  loaded, less accurate on the user's French, and it keeps filler words.
  Dropped for v1.
- Whisper invents text from silence, so silent takes must be dropped first.
- The user accepted the Arabic output and confirmed holding `Fn` triggers no
  system popup. `Fn` stays the default hold key.

## Left to the builder

- Module and file layout, crate choices for capture and resampling, the exact
  event and command names.
- How the visible composer registers itself as the dictation target, as long
  as main and detached windows share one implementation.
- Where settings live, given that Rust needs the hold key and language at
  startup.
- Model download source, file layout, and resume behaviour.
- Exact look of the indicator, mic button and language switcher, following
  the existing composer style.
- How speech-free clips are detected.

## Phase 2 (not built now)

- The hold key works in any app: the transcript is pasted into whatever is
  focused, with a small floating indicator near the cursor or screen edge.
- Optional auto-send.
- Language switching mid-sentence.
- Live text while speaking, if a streaming model reaches the accuracy bar.

## Done when

- Holding the key in Verun, speaking, and releasing puts accurate text in the
  right composer, in each of the four first languages.
- A second hold appends.
- With dictation off, the app behaves exactly as before: no listener, no
  prompts, no model on disk.
- `make check` passes; CHANGELOG, README and ROADMAP are updated.

## References

- transcribe-rs: https://github.com/cjpais/transcribe-rs
- Handy: https://github.com/cjpais/Handy
- Parakeet TDT 0.6B v3: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- Whisper large-v3-turbo: https://huggingface.co/openai/whisper-large-v3-turbo
- Cohere Transcribe Arabic: https://cohere.com/blog/transcribe-arabic
- FluidAudio: https://github.com/FluidInference/FluidAudio
