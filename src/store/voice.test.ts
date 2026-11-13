import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const listeners = new Map<string, (e: { payload: unknown }) => void>()
const listenMock = vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
  listeners.set(event, cb)
  return Promise.resolve(() => listeners.delete(event))
})
vi.mock('@tauri-apps/api/event', () => ({ listen: (e: string, cb: (e: { payload: unknown }) => void) => listenMock(e, cb) }))

vi.mock('../lib/ipc', () => ({
  voiceStatus: vi.fn(),
  voiceBegin: vi.fn(),
  voiceEnd: vi.fn(),
  voiceCancel: vi.fn(),
}))
vi.mock('./ui', () => ({ addToast: vi.fn() }))
vi.mock('./sessions', () => ({ sessionById: vi.fn() }))

import * as ipc from '../lib/ipc'
import { addToast } from './ui'
import { sessionById } from './sessions'
import { loadDraftMessage, saveDraftMessage } from './sessionDrafts'
import {
  initVoice, registerDictationTarget as register, toggleDictation, voiceState, voiceLevel, voiceStatus,
  dictationSetupRequest, clearDictationSetupRequest, type DictationTarget,
} from './voice'
import type { VoiceStatus } from '../types/voice'

const fire = (event: string, payload: unknown) => listeners.get(event)!({ payload })
const state = (state: string, window: string | null = 'main') => fire('voice-state', { state, window })
const transcript = (text: string, seq = 0, window = 'main') => fire('voice-transcript', { window, seq, text })

type TestTarget = DictationTarget & { insert: ReturnType<typeof vi.fn> }
const makeTarget = (sid: string | null = 's1'): TestTarget => ({
  id: sid ? `session:${sid}` : 'new-task', sessionId: sid, insert: vi.fn() as never,
})

// Targets live in module state: unregister whatever a test left behind.
const offs: Array<() => void> = []
const registerDictationTarget = (t: DictationTarget) => {
  const off = register(t)
  offs.push(off)
  return off
}
afterEach(() => { offs.splice(0).forEach(off => off()) })

const status = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({
  supported: true, enabled: true, language: 'en', holdKey: 'fn', accessibility: true,
  microphone: 'granted', state: 'idle', models: [], ...over,
})

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  clearDictationSetupRequest()
  vi.mocked(ipc.voiceStatus).mockResolvedValue(status())
  vi.mocked(ipc.voiceBegin).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceCancel).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceEnd).mockResolvedValue(undefined)
  await initVoice()
  fire('voice-status-changed', status())
  state('idle', null)
})

describe('initVoice', () => {
  test('loads status and registers listeners once', async () => {
    expect(voiceStatus()?.enabled).toBe(true)
    const n = listenMock.mock.calls.length
    await initVoice()
    expect(listenMock.mock.calls.length).toBe(n)
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(1)
  })

  test('voice-status-changed replaces status', () => {
    fire('voice-status-changed', status({ enabled: false }))
    expect(voiceStatus()?.enabled).toBe(false)
  })
})

describe('delivery', () => {
  test('goes to the target registered at recording start', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    state('recording')
    registerDictationTarget(b)
    transcript('hello')
    expect(a.insert).toHaveBeenCalledWith('hello')
    expect(b.insert).not.toHaveBeenCalled()
  })

  test('unregistered target with a live session appends to its draft and toasts', () => {
    const a = makeTarget('a')
    const off = registerDictationTarget(a)
    state('recording')
    off()
    vi.mocked(sessionById).mockReturnValue({ id: 'a' } as never)
    saveDraftMessage('a', 'draft')
    transcript('more')
    expect(a.insert).not.toHaveBeenCalled()
    expect(loadDraftMessage('a')).toBe('draft more')
    expect(addToast).toHaveBeenCalledWith('Dictation saved to the draft of the chat you were in.', 'info')
  })

  test('unregistered target with a dead session toasts and writes nothing', () => {
    const a = makeTarget('a')
    const off = registerDictationTarget(a)
    state('recording')
    off()
    vi.mocked(sessionById).mockReturnValue(undefined)
    transcript('lost')
    expect(loadDraftMessage('a')).toBeNull()
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('unregistered target without a session id is dropped', () => {
    const a = makeTarget(null)
    const off = registerDictationTarget(a)
    state('recording')
    off()
    transcript('lost')
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('recording with no target cancels and toasts', () => {
    state('recording')
    expect(ipc.voiceCancel).toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith('Dictation works in the chat box and the new task box.', 'info')
  })

  test('pins are FIFO across overlapping takes', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    state('recording')
    state('transcribing')
    registerDictationTarget(b)
    state('recording')
    transcript('one', 0)
    expect(a.insert).toHaveBeenCalledWith('one')
    expect(b.insert).not.toHaveBeenCalled()
    transcript('two', 1)
    expect(b.insert).toHaveBeenCalledWith('two')
  })

  test('two transcripts for one target arrive in order', () => {
    const a = makeTarget('a')
    registerDictationTarget(a)
    state('recording'); state('recording')
    transcript('one', 0); transcript('two', 1)
    expect(a.insert.mock.calls.map(c => c[0])).toEqual(['one', 'two'])
  })

  test('idle clears stale pins', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    state('recording')
    state('idle')
    registerDictationTarget(b)
    state('recording')
    transcript('x')
    expect(a.insert).not.toHaveBeenCalled()
    expect(b.insert).toHaveBeenCalledWith('x')
  })

  test('a voice-error drops the stale pin', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    state('recording')
    fire('voice-error', { window: 'main', error: { engine: 'x' } })
    registerDictationTarget(b)
    state('recording')
    transcript('x')
    expect(a.insert).not.toHaveBeenCalled()
    expect(b.insert).toHaveBeenCalledWith('x')
  })

  test('the most recently registered target wins', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a); registerDictationTarget(b)
    state('recording'); transcript('x')
    expect(b.insert).toHaveBeenCalled()
    expect(a.insert).not.toHaveBeenCalled()
  })
})

describe('other windows', () => {
  test('events for another window are ignored', () => {
    const a = makeTarget('a')
    registerDictationTarget(a)
    state('recording', 'task-1')
    expect(voiceState()).toBe('idle')
    state('recording')
    transcript('nope', 0, 'task-1')
    expect(a.insert).not.toHaveBeenCalled()
    fire('voice-error', { window: 'task-1', error: 'mic-denied' })
    expect(addToast).not.toHaveBeenCalled()
    transcript('yes')
    expect(a.insert).toHaveBeenCalledWith('yes')
  })

  test('idle with a null window applies', () => {
    state('recording')
    expect(voiceState()).toBe('recording')
    state('idle', null)
    expect(voiceState()).toBe('idle')
  })

  test('level applies only while this window records', () => {
    fire('voice-level', { level: 0.5 })
    expect(voiceLevel()).toBe(0)
    registerDictationTarget(makeTarget())
    state('recording')
    fire('voice-level', { level: 0.5 })
    expect(voiceLevel()).toBe(0.5)
    state('transcribing')
    expect(voiceLevel()).toBe(0)
  })
})

describe('errors', () => {
  test('model-missing opens the setup request', () => {
    fire('voice-error', { window: 'main', error: 'model-missing' })
    expect(dictationSetupRequest()).toEqual({})
    expect(addToast).not.toHaveBeenCalled()
  })

  test.each([
    ['mic-denied', 'Microphone access is off for Verun. Turn it on in System Settings.'],
    ['mic-unavailable', 'No microphone found, or it stopped responding.'],
    [{ engine: 'boom' }, 'Dictation failed. Try again.'],
  ] as const)('%j toasts', (error, msg) => {
    fire('voice-error', { window: 'main', error })
    expect(addToast).toHaveBeenCalledWith(msg, 'error')
  })
})

describe('toggleDictation', () => {
  test('opens setup when status is missing or disabled', () => {
    fire('voice-status-changed', status({ enabled: false }))
    toggleDictation()
    expect(dictationSetupRequest()).toEqual({})
    expect(ipc.voiceBegin).not.toHaveBeenCalled()
  })

  test('begins for this window when idle', () => {
    toggleDictation()
    expect(ipc.voiceBegin).toHaveBeenCalledWith('main')
  })

  test('ends when this window is recording', () => {
    registerDictationTarget(makeTarget())
    state('recording')
    toggleDictation()
    expect(ipc.voiceEnd).toHaveBeenCalled()
    expect(ipc.voiceBegin).not.toHaveBeenCalled()
  })

  test('a rejected begin is handled like a voice-error', async () => {
    vi.mocked(ipc.voiceBegin).mockRejectedValue('mic-denied')
    toggleDictation()
    await Promise.resolve(); await Promise.resolve()
    expect(addToast).toHaveBeenCalledWith('Microphone access is off for Verun. Turn it on in System Settings.', 'error')
  })
})
