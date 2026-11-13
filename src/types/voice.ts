// Voice dictation types, mirroring the Rust ones in src-tauri/src/voice/ as serialized.

export type Language = 'en' | 'fr' | 'es' | 'ar' | 'zh' | 'hi' | 'pt' | 'ru' | 'bn' | 'ur' | 'ja' | 'de'

export type ModelId = 'whisper-turbo'

export type HoldKey = 'fn' | 'right-option' | 'right-command'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

export type MicPermission = 'granted' | 'denied' | 'undetermined'

/** What macOS itself does on Fn (Keyboard settings, the Globe key); 'unknown' when it cannot be read. */
export type FnSystemAction = 'none' | 'input-source' | 'emoji' | 'dictation' | 'unknown'

/** `busy`: a take is recording for another window. `no-target`: a deliberate hold in a window with no composer. */
export type VoiceError = 'mic-denied' | 'mic-unavailable' | 'model-missing' | 'disabled' | 'busy' | 'no-target' | { engine: string }

export interface ModelStatus {
  id: ModelId
  displayName: string
  installed: boolean
  bytes: number
}

/** One per language, in the order of `Language`. */
export interface LanguageStatus {
  code: Language
  model: ModelId
  installed: boolean
}

export interface VoiceStatus {
  supported: boolean
  enabled: boolean
  language: Language
  holdKey: HoldKey
  accessibility: boolean
  fnSystemAction: FnSystemAction
  microphone: MicPermission
  state: VoiceState
  models: ModelStatus[]
  languages: LanguageStatus[]
  /** The same in every window until the app quits; take ids restart with each run. */
  runId: string
}

/**
 * Take protocol: every take gets an id (`take`) when it starts recording.
 * Every take that emitted `voice-state` recording with id T later emits
 * exactly one of `voice-transcript`, `voice-error` or `voice-take-dropped`
 * carrying T, before the `voice-state` that reflects T being finished.
 */

/**
 * `voice-state`: `window` is the label the state belongs to (null when idle);
 * `take` is the recording take's id while `state` is 'recording', else null.
 */
export interface VoiceStateEvent {
  state: VoiceState
  window: string | null
  take: number | null
}

/** `voice-level`: input level in 0..1, about 15 per second while recording. */
export interface VoiceLevelEvent {
  level: number
}

/** `voice-transcript`: emitted in `seq` order; empty ones become `voice-take-dropped`. */
export interface VoiceTranscriptEvent {
  window: string
  take: number
  seq: number
  text: string
}

/** `voice-error`: `take` is null when no take had started (a refused begin). */
export interface VoiceErrorEvent {
  window: string | null
  take: number | null
  error: VoiceError
}

export type VoiceDropReason = 'too-short' | 'silent' | 'empty' | 'cancelled'

/** `voice-take-dropped`: a started take ended with no transcript and no error. */
export interface VoiceTakeDroppedPayload {
  window: string
  take: number
  reason: VoiceDropReason
}
export type VoiceTakeDroppedEvent = VoiceTakeDroppedPayload

/**
 * `voice-model-progress`: the last one has `done: true`, with `error` set on
 * failure or `cancelled` set when the user stopped it.
 */
export interface VoiceModelProgressEvent {
  model: ModelId
  received: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
}

/** `voice-status-changed` carries a full `VoiceStatus`. */
export type VoiceStatusChangedEvent = VoiceStatus
