import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { windowContext } from '../lib/windowContext'
import type {
  Language, VoiceError, VoiceErrorEvent, VoiceLevelEvent, VoiceState, VoiceStateEvent,
  VoiceStatus, VoiceTakeDroppedEvent, VoiceTranscriptEvent,
} from '../types/voice'
import { sessionById } from './sessions'
import { appendToDraft } from './sessionDrafts'
import { addToast } from './ui'

export interface DictationTarget {
  /** Stable id: `session:<sid>` or `new-task`. */
  id: string
  sessionId: string | null
  insert(take: string): void
}

const [status, setStatus] = createSignal<VoiceStatus | null>(null)
const [level, setLevel] = createSignal(0)
/** The take this window is recording right now. */
const [recordingTake, setRecordingTake] = createSignal<number | null>(null)
/** Take id -> the target that was visible when it started. Replaced on change so reads are reactive. */
const [pins, setPins] = createSignal<ReadonlyMap<number, DictationTarget>>(new Map())

export const voiceStatus: Accessor<VoiceStatus | null> = status

export const voiceState: Accessor<VoiceState> = () =>
  recordingTake() !== null ? 'recording' : pins().size > 0 ? 'transcribing' : 'idle'

export const voiceLevel: Accessor<number> = () => (voiceState() === 'recording' ? level() : 0)

const [setupRequest, setSetupRequest] = createSignal<{ language?: Language } | null>(null)
export const dictationSetupRequest: Accessor<{ language?: Language } | null> = setupRequest
export function clearDictationSetupRequest(): void { setSetupRequest(null) }
/** Placeholder: a later task's dialog reads `dictationSetupRequest`. */
export function openDictationSetup(language?: Language): void {
  setSetupRequest(language ? { language } : {})
}

// Registered targets, oldest first; the last one is the visible composer.
let targets: DictationTarget[] = []

export function registerDictationTarget(t: DictationTarget): () => void {
  targets.push(t)
  return () => {
    const i = targets.indexOf(t)
    if (i >= 0) targets.splice(i, 1)
  }
}

const label = () => windowContext.windowLabel

function pin(take: number, t: DictationTarget) {
  setPins(new Map(pins()).set(take, t))
}

/** Remove and return the pin for `take`; the recording take is over once it has a terminal event. */
function release(take: number): DictationTarget | undefined {
  if (recordingTake() === take) setRecordingTake(null)
  const t = pins().get(take)
  if (t) {
    const next = new Map(pins())
    next.delete(take)
    setPins(next)
  }
  return t
}

function handleError(error: VoiceError) {
  if (error === 'model-missing' || error === 'disabled') return openDictationSetup()
  if (error === 'mic-denied') addToast('Microphone access is off for Verun. Turn it on in System Settings.', 'error')
  else if (error === 'mic-unavailable') addToast('No microphone found, or it stopped responding.', 'error')
  else addToast('Dictation failed. Try again.', 'error')
}

function onState({ state, window, take }: VoiceStateEvent) {
  // Any state event supersedes a recording this window had; only a recording event for us restarts it.
  setRecordingTake(null)
  if (state === 'idle' && window === null) setPins(new Map())
  if (state !== 'recording' || window !== label() || take === null) return
  const target = targets[targets.length - 1]
  if (target) {
    pin(take, target)
    setRecordingTake(take)
  } else {
    ipc.voiceCancel().catch(e => console.error('voice cancel:', e))
    addToast('Dictation works in the chat box and the new task box.', 'info')
  }
}

function onTranscript({ window, take, text }: VoiceTranscriptEvent) {
  if (window !== label()) return
  const pinned = release(take)
  // A remounted composer for the same chat has a new object with the same id.
  const live = pinned && [...targets].reverse().find(t => t.id === pinned.id)
  if (live) return live.insert(text)
  if (pinned?.sessionId && sessionById(pinned.sessionId)) {
    appendToDraft(pinned.sessionId, text)
    addToast('Dictation saved to the draft of the chat you were in.', 'info')
  } else {
    addToast('Dictation dropped: that chat is gone.', 'info')
  }
}

let initialized = false
let unlisteners: Array<() => void> = []
let statusEventSeen = false

export async function initVoice(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const results = await Promise.allSettled([
      listen<VoiceStateEvent>('voice-state', e => onState(e.payload)),
      listen<VoiceLevelEvent>('voice-level', e => { setLevel(e.payload.level) }),
      listen<VoiceTranscriptEvent>('voice-transcript', e => onTranscript(e.payload)),
      listen<VoiceErrorEvent>('voice-error', e => {
        if (e.payload.window !== label()) return
        if (e.payload.take !== null) release(e.payload.take)
        handleError(e.payload.error)
      }),
      listen<VoiceTakeDroppedEvent>('voice-take-dropped', e => {
        if (e.payload.window === label()) release(e.payload.take)
      }),
      listen<VoiceStatus>('voice-status-changed', e => { statusEventSeen = true; setStatus(e.payload) }),
    ])
    unlisteners = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
    const failure = results.find(r => r.status === 'rejected')
    if (failure) throw (failure as PromiseRejectedResult).reason
    const initial = await ipc.voiceStatus()
    if (!statusEventSeen) setStatus(initial)
  } catch (e) {
    unlisteners.forEach(u => u())
    unlisteners = []
    initialized = false
    throw e
  }
}

export function toggleDictation(): void {
  const s = status()
  if (!s || !s.enabled) return openDictationSetup()
  if (recordingTake() !== null) {
    ipc.voiceEnd().catch(e => console.error('voice end:', e))
    return
  }
  ipc.voiceBegin(label()).catch((e: VoiceError) => handleError(e))
}

/** Test-only: drop all module state so tests never leak into each other. */
export function __resetVoiceForTests(): void {
  unlisteners.forEach(u => u())
  unlisteners = []
  initialized = false
  statusEventSeen = false
  targets = []
  setStatus(null)
  setLevel(0)
  setRecordingTake(null)
  setPins(new Map())
  setSetupRequest(null)
}
