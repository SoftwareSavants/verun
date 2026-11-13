import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { windowContext } from '../lib/windowContext'
import type {
  Language, VoiceError, VoiceErrorEvent, VoiceLevelEvent, VoiceState, VoiceStateEvent,
  VoiceStatus, VoiceTranscriptEvent,
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
const [state, setState] = createSignal<VoiceState>('idle')
const [level, setLevel] = createSignal(0)
export const voiceStatus: Accessor<VoiceStatus | null> = status
export const voiceState: Accessor<VoiceState> = state
export const voiceLevel: Accessor<number> = level

const [setupRequest, setSetupRequest] = createSignal<{ language?: Language } | null>(null)
export const dictationSetupRequest: Accessor<{ language?: Language } | null> = setupRequest
export function clearDictationSetupRequest(): void { setSetupRequest(null) }
/** Placeholder: a later task's dialog reads `dictationSetupRequest`. */
export function openDictationSetup(language?: Language): void {
  setSetupRequest(language ? { language } : {})
}

// Registered targets, oldest first; the last one is the visible composer.
const targets: DictationTarget[] = []
// One pin per take, in arrival order; each transcript consumes the oldest.
let pins: DictationTarget[] = []

export function registerDictationTarget(t: DictationTarget): () => void {
  targets.push(t)
  return () => {
    const i = targets.indexOf(t)
    if (i >= 0) targets.splice(i, 1)
  }
}

const label = () => windowContext.windowLabel

function handleError(error: VoiceError) {
  if (error === 'model-missing') return openDictationSetup()
  if (error === 'mic-denied') addToast('Microphone access is off for Verun. Turn it on in System Settings.', 'error')
  else if (error === 'mic-unavailable') addToast('No microphone found, or it stopped responding.', 'error')
  else addToast('Dictation failed. Try again.', 'error')
}

function onState({ state: next, window }: VoiceStateEvent) {
  if (next === 'idle' && window === null) {
    pins = []
  } else if (window !== label()) {
    return
  }
  setState(next)
  if (next !== 'recording') setLevel(0)
  if (next === 'idle') pins = []
  if (next === 'recording') {
    const target = targets[targets.length - 1]
    if (target) {
      pins.push(target)
    } else {
      ipc.voiceCancel().catch(e => console.error('voice cancel:', e))
      addToast('Dictation works in the chat box and the new task box.', 'info')
    }
  }
}

function onTranscript({ window, text }: VoiceTranscriptEvent) {
  if (window !== label()) return
  const target = pins.shift()
  if (!target) return
  if (targets.includes(target)) return target.insert(text)
  if (target.sessionId && sessionById(target.sessionId)) {
    appendToDraft(target.sessionId, text)
    addToast('Dictation saved to the draft of the chat you were in.', 'info')
  } else {
    addToast('Dictation dropped: that chat is gone.', 'info')
  }
}

let initialized = false

export async function initVoice(): Promise<void> {
  if (initialized) return
  initialized = true
  await Promise.all([
    listen<VoiceStateEvent>('voice-state', e => onState(e.payload)),
    listen<VoiceLevelEvent>('voice-level', e => { if (state() === 'recording') setLevel(e.payload.level) }),
    listen<VoiceTranscriptEvent>('voice-transcript', e => onTranscript(e.payload)),
    listen<VoiceErrorEvent>('voice-error', e => {
      if (e.payload.window !== label()) return
      pins = []
      handleError(e.payload.error)
    }),
    listen<VoiceStatus>('voice-status-changed', e => setStatus(e.payload)),
  ])
  setStatus(await ipc.voiceStatus())
}

export function toggleDictation(): void {
  const s = status()
  if (!s || !s.enabled) return openDictationSetup()
  if (state() === 'recording') {
    ipc.voiceEnd().catch(e => console.error('voice end:', e))
    return
  }
  ipc.voiceBegin(label()).catch((e: VoiceError) => handleError(e))
}
