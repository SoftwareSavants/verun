// Voice dictation types, mirroring the Rust ones in src-tauri/src/voice/ as serialized.

export type Language = 'en' | 'fr' | 'es' | 'ar' | 'zh' | 'hi' | 'pt' | 'ru' | 'bn' | 'ur' | 'ja' | 'de'

export type ModelId = 'whisper-turbo'

export type HoldKey = 'fn' | 'right-option' | 'right-command'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

export type MicPermission = 'granted' | 'denied' | 'undetermined'

export type VoiceError = 'mic-denied' | 'mic-unavailable' | 'model-missing' | { engine: string }

/** Rust serializes this one with snake_case keys. */
export interface ModelStatus {
  id: ModelId
  display_name: string
  installed: boolean
  bytes: number
}

export interface VoiceStatus {
  supported: boolean
  enabled: boolean
  language: Language
  holdKey: HoldKey
  accessibility: boolean
  microphone: MicPermission
  state: VoiceState
  models: ModelStatus[]
}

/** `voice-state`: `window` is the label the state belongs to, null when idle. */
export interface VoiceStateEvent {
  state: VoiceState
  window: string | null
}

/** `voice-level`: input level in 0..1, about 15 per second while recording. */
export interface VoiceLevelEvent {
  level: number
}

/** `voice-transcript`: emitted in `seq` order; empty transcripts are not sent. */
export interface VoiceTranscriptEvent {
  window: string
  seq: number
  text: string
}

/** `voice-error` */
export interface VoiceErrorEvent {
  window: string | null
  error: VoiceError
}

/** `voice-model-progress`: the last one has `done: true`, with `error` set on failure. */
export interface VoiceModelProgressEvent {
  model: ModelId
  received: number
  total: number
  done: boolean
  error: string | null
}

/** `voice-status-changed` carries a full `VoiceStatus`. */
export type VoiceStatusChangedEvent = VoiceStatus
