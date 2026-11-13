import { describe, test, expect, vi, beforeEach } from 'vitest'

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
  voiceSetEnabled: vi.fn(),
  voiceSetLanguage: vi.fn(),
  voiceDownloadModel: vi.fn(),
  voiceCancelDownload: vi.fn(),
  voiceDeleteModel: vi.fn(),
  voiceRequestMicrophone: vi.fn(),
}))
vi.mock('./ui', () => ({ addToast: vi.fn() }))
vi.mock('./sessions', () => ({ sessionById: vi.fn() }))
vi.mock('./projects', () => ({ projectById: vi.fn() }))

import * as ipc from '../lib/ipc'
import { addToast } from './ui'
import { sessionById } from './sessions'
import { projectById } from './projects'
import { loadDraftMessage, saveDraftMessage } from './sessionDrafts'
import {
  initVoice, registerDictationTarget as register, toggleDictation, voiceState, voiceLevel, voiceStatus,
  dictationSetupRequest, __resetVoiceForTests, type DictationTarget,
  modelDownloads, downloadDictationModel, deleteDictationModel, refreshVoiceStatus, setDictationEnabled,
  requestMicrophone, dictationAvailable, watchVoiceStatusOnFocus, chooseDictationLanguage, pendingDictationLanguage,
  setDictationLanguage, cancelDictationDownload,
} from './voice'
import type { VoiceStatus } from '../types/voice'

const fire = (event: string, payload: unknown) => listeners.get(event)!({ payload })
const state = (state: string, window: string | null = 'main', take: number | null = null) =>
  fire('voice-state', { state, window, take })
const rec = (take: number, window = 'main') => state('recording', window, take)
const transcript = (text: string, take: number, window = 'main') =>
  fire('voice-transcript', { window, take, seq: take, text })
const failed = (take: number | null, error: unknown, window: string | null = 'main') =>
  fire('voice-error', { window, take, error })
const dropped = (take: number, window = 'main') =>
  fire('voice-take-dropped', { window, take, reason: 'silent' })

type TestTarget = DictationTarget & { insert: ReturnType<typeof vi.fn> }
const makeTarget = (sid: string | null = 's1'): TestTarget => ({
  id: sid ? `session:${sid}` : 'new-task:p', draftId: sid ?? 'new-task:p', insert: vi.fn() as never,
})

const registerDictationTarget = register

const status = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({
  supported: true, enabled: true, language: 'en', holdKey: 'fn', accessibility: true, fnSystemAction: 'none', runId: 'run-1',
  microphone: 'granted', state: 'idle', models: [], languages: [], ...over,
})

beforeEach(async () => {
  vi.resetAllMocks()
  listeners.clear()
  listenMock.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, cb)
    return Promise.resolve(() => listeners.delete(event))
  })
  localStorage.clear()
  __resetVoiceForTests()
  vi.mocked(ipc.voiceStatus).mockResolvedValue(status())
  vi.mocked(ipc.voiceBegin).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceCancel).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceEnd).mockResolvedValue(undefined)
  await initVoice()
})

describe('initVoice', () => {
  test('loads status and registers listeners once', async () => {
    expect(voiceStatus()?.enabled).toBe(true)
    const n = listenMock.mock.calls.length
    expect(n).toBeGreaterThan(0)
    await initVoice()
    expect(listenMock.mock.calls.length).toBe(n)
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(1)
  })

  test('voice-status-changed replaces status', () => {
    fire('voice-status-changed', status({ enabled: false }))
    expect(voiceStatus()?.enabled).toBe(false)
  })

  test('a rejected status load can be retried', async () => {
    __resetVoiceForTests()
    vi.mocked(ipc.voiceStatus).mockRejectedValueOnce(new Error('x'))
    await expect(initVoice()).rejects.toThrow('x')
    await initVoice()
    expect(voiceStatus()?.enabled).toBe(true)
    expect(listeners.size).toBe(7)
  })

  test('a rejected listen can be retried', async () => {
    __resetVoiceForTests()
    listeners.clear()
    listenMock.mockRejectedValueOnce(new Error('nope'))
    await expect(initVoice()).rejects.toThrow('nope')
    await initVoice()
    expect(voiceStatus()?.enabled).toBe(true)
    expect(listeners.size).toBe(7)
  })

  test('an older initial snapshot does not overwrite a newer status event', async () => {
    __resetVoiceForTests()
    let resolve!: (s: VoiceStatus) => void
    vi.mocked(ipc.voiceStatus).mockReturnValueOnce(new Promise(r => { resolve = r }))
    const p = initVoice()
    await vi.waitFor(() => expect(listeners.has('voice-status-changed')).toBe(true))
    fire('voice-status-changed', status({ enabled: false }))
    resolve(status({ enabled: true }))
    await p
    expect(voiceStatus()?.enabled).toBe(false)
  })
})

describe('delivery', () => {
  test('goes to the target registered at recording start', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    rec(1)
    registerDictationTarget(b)
    transcript('hello', 1)
    expect(a.insert).toHaveBeenCalledWith('hello')
    expect(b.insert).not.toHaveBeenCalled()
  })

  test('unregistered target with a live session appends to its draft and toasts', () => {
    const a = makeTarget('a')
    const off = registerDictationTarget(a)
    rec(1)
    off()
    vi.mocked(sessionById).mockReturnValue({ id: 'a' } as never)
    saveDraftMessage('a', 'draft')
    transcript('more', 1)
    expect(a.insert).not.toHaveBeenCalled()
    expect(loadDraftMessage('a')).toBe('draft more')
    expect(addToast).toHaveBeenCalledWith('Dictation saved to the draft of the chat you were in.', 'info')
  })

  test('unregistered target with a dead session toasts and writes nothing', () => {
    const a = makeTarget('a')
    const off = registerDictationTarget(a)
    rec(1)
    off()
    vi.mocked(sessionById).mockReturnValue(undefined)
    transcript('lost', 1)
    expect(loadDraftMessage('a')).toBeNull()
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('a take whose new-task box went away goes to that project\'s new-task draft', () => {
    const a = makeTarget(null)
    const off = registerDictationTarget(a)
    rec(1)
    off() // hidden behind a task, unmounted, or sending
    vi.mocked(projectById).mockReturnValue({ id: 'p' } as never)
    transcript('fix login', 1)
    expect(a.insert).not.toHaveBeenCalled()
    expect(loadDraftMessage('new-task:p')).toBe('fix login')
    expect(addToast).toHaveBeenCalledWith('Dictation saved to the new task draft.', 'info')
  })

  test('a take begun in one project\'s new-task box never lands in another project\'s', () => {
    const a = makeTarget(null)
    const offA = registerDictationTarget(a)
    rec(1)
    offA()
    const b: TestTarget = { id: 'new-task:q', draftId: 'new-task:q', insert: vi.fn() as never }
    registerDictationTarget(b)
    vi.mocked(projectById).mockReturnValue({ id: 'p' } as never)
    transcript('for p', 1)
    expect(b.insert).not.toHaveBeenCalled()
    expect(loadDraftMessage('new-task:q')).toBeNull()
    expect(loadDraftMessage('new-task:p')).toBe('for p')
  })

  test('a take for the new-task box of a removed project is dropped', () => {
    const a = makeTarget(null)
    const off = registerDictationTarget(a)
    rec(1)
    off()
    vi.mocked(projectById).mockReturnValue(undefined)
    transcript('lost', 1)
    expect(loadDraftMessage('new-task:p')).toBeNull()
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('remount: a new target with the same id receives the text, no draft write', () => {
    const old = makeTarget('a')
    const off = registerDictationTarget(old)
    rec(1)
    off()
    const fresh = makeTarget('a')
    registerDictationTarget(fresh)
    vi.mocked(sessionById).mockReturnValue({ id: 'a' } as never)
    transcript('hi', 1)
    expect(fresh.insert).toHaveBeenCalledWith('hi')
    expect(old.insert).not.toHaveBeenCalled()
    expect(loadDraftMessage('a')).toBeNull()
    expect(addToast).not.toHaveBeenCalled()
  })

  test('a whitespace-only take is nothing: no target or draft gets it, so no selection is replaced', () => {
    const live = makeTarget('a')
    registerDictationTarget(live)
    rec(1)
    transcript('  \n ', 1)
    expect(live.insert).not.toHaveBeenCalled()
    const hidden = makeTarget(null)
    const off = registerDictationTarget(hidden)
    rec(2)
    off()
    vi.mocked(projectById).mockReturnValue({ id: 'p' } as never)
    transcript(' ', 2)
    expect(loadDraftMessage('new-task:p')).toBeNull()
    expect(addToast).not.toHaveBeenCalled()
    expect(voiceState()).toBe('idle')
  })

  test('recording with no target cancels and toasts', () => {
    rec(1)
    expect(ipc.voiceCancel).toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith('Dictation works in the chat box and the new task box.', 'info')
  })

  test('a transcript with no pin shows the dropped toast', () => {
    transcript('orphan', 9)
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('overlapping takes each go to their own target', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    rec(1)
    state('transcribing', 'main')
    registerDictationTarget(b)
    rec(2)
    transcript('two', 2)
    expect(b.insert).toHaveBeenCalledWith('two')
    transcript('one', 1)
    expect(a.insert).toHaveBeenCalledWith('one')
  })

  test('an error for take 1 leaves take 2 delivered to take 2 target', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a)
    rec(1)
    registerDictationTarget(b)
    rec(2)
    failed(1, { engine: 'x' })
    transcript('two', 2)
    expect(b.insert).toHaveBeenCalledWith('two')
    expect(a.insert).not.toHaveBeenCalled()
  })

  test('a dropped take 2 does not shift take 3 onto take 2 target', () => {
    const a = makeTarget('a'); const b = makeTarget('b'); const c = makeTarget('c')
    registerDictationTarget(a); rec(1)
    registerDictationTarget(b); rec(2)
    registerDictationTarget(c); rec(3)
    dropped(2)
    transcript('three', 3)
    expect(c.insert).toHaveBeenCalledWith('three')
    expect(b.insert).not.toHaveBeenCalled()
    transcript('one', 1)
    expect(a.insert).toHaveBeenCalledWith('one')
  })

  test('voice-take-dropped removes the pin silently', () => {
    registerDictationTarget(makeTarget('a'))
    rec(1)
    dropped(1)
    expect(addToast).not.toHaveBeenCalled()
    expect(voiceState()).toBe('idle')
  })

  test('an error with a null take touches no pins', () => {
    const a = makeTarget('a')
    registerDictationTarget(a)
    rec(1)
    failed(null, { engine: 'x' })
    transcript('x', 1)
    expect(a.insert).toHaveBeenCalledWith('x')
  })

  test('global idle clears all pins', () => {
    const a = makeTarget('a')
    registerDictationTarget(a)
    rec(1)
    state('idle', null)
    expect(voiceState()).toBe('idle')
    transcript('x', 1)
    expect(a.insert).not.toHaveBeenCalled()
  })

  test('the most recently registered target wins', () => {
    const a = makeTarget('a'); const b = makeTarget('b')
    registerDictationTarget(a); registerDictationTarget(b)
    rec(1); transcript('x', 1)
    expect(b.insert).toHaveBeenCalled()
    expect(a.insert).not.toHaveBeenCalled()
  })
})

describe('state', () => {
  test('events for another window are ignored for delivery and errors', () => {
    const a = makeTarget('a')
    registerDictationTarget(a)
    rec(1, 'task-1')
    expect(voiceState()).toBe('idle')
    rec(2)
    transcript('nope', 1, 'task-1')
    expect(a.insert).not.toHaveBeenCalled()
    failed(1, 'mic-denied', 'task-1')
    expect(addToast).not.toHaveBeenCalled()
    transcript('yes', 2)
    expect(a.insert).toHaveBeenCalledWith('yes')
  })

  test('another window transcribing ends this window recording', () => {
    registerDictationTarget(makeTarget())
    rec(1)
    expect(voiceState()).toBe('recording')
    state('transcribing', 'task-1')
    expect(voiceState()).not.toBe('recording')
  })

  test('transcribing while a pin is outstanding, idle after its terminal event', () => {
    registerDictationTarget(makeTarget())
    rec(1)
    expect(voiceState()).toBe('recording')
    state('transcribing', 'main')
    expect(voiceState()).toBe('transcribing')
    transcript('x', 1)
    expect(voiceState()).toBe('idle')
  })

  test('a terminal event for the recording take ends recording', () => {
    registerDictationTarget(makeTarget())
    rec(1)
    dropped(1)
    expect(voiceState()).toBe('idle')
  })

  test('a new recording starts its meter at zero, not at the last take\'s level', () => {
    registerDictationTarget(makeTarget())
    rec(1)
    fire('voice-level', { level: 0.8 })
    dropped(1)
    rec(2)
    expect(voiceLevel()).toBe(0)
  })

  test('level applies only while this window records', () => {
    fire('voice-level', { level: 0.5 })
    expect(voiceLevel()).toBe(0)
    registerDictationTarget(makeTarget())
    rec(1)
    fire('voice-level', { level: 0.5 })
    expect(voiceLevel()).toBe(0.5)
    state('transcribing', 'main')
    expect(voiceLevel()).toBe(0)
  })
})

describe('errors', () => {
  test('disabled opens setup to turn it on', () => {
    failed(null, 'disabled')
    expect(dictationSetupRequest()).toEqual({ reason: 'enable' })
    expect(addToast).not.toHaveBeenCalled()
  })

  test('model-missing re-reads the status first, then opens setup for the missing model', async () => {
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ models: [{ id: 'whisper-turbo', displayName: 'W', installed: false, bytes: 1 }] }))
    failed(null, 'model-missing')
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
    await vi.waitFor(() => expect(dictationSetupRequest()).toEqual({ reason: 'model-missing' }))
    expect(voiceStatus()?.models[0].installed).toBe(false)
    expect(addToast).not.toHaveBeenCalled()
  })

  test.each([
    ['mic-denied', 'Microphone access is off for Verun. Turn it on in System Settings.'],
    ['mic-unavailable', 'No microphone found, or it stopped responding.'],
    [{ engine: 'boom' }, 'Dictation failed. Try again.'],
  ] as const)('%j toasts', (error, msg) => {
    failed(null, error)
    expect(addToast).toHaveBeenCalledWith(msg, 'error')
  })

  test('busy is a notice that another window is recording', () => {
    failed(null, 'busy')
    expect(addToast).toHaveBeenCalledWith('Dictation is already recording in another window.', 'info')
  })

  test('a busy mic-button begin shows the same notice', async () => {
    vi.mocked(ipc.voiceBegin).mockRejectedValueOnce('busy')
    toggleDictation()
    await vi.waitFor(() => expect(addToast).toHaveBeenCalledWith('Dictation is already recording in another window.', 'info'))
  })
})

describe('toggleDictation', () => {
  test('opens setup when status is disabled', () => {
    fire('voice-status-changed', status({ enabled: false }))
    toggleDictation()
    expect(dictationSetupRequest()).toEqual({ reason: 'enable' })
    expect(ipc.voiceBegin).not.toHaveBeenCalled()
  })

  test('begins for this window when idle', () => {
    toggleDictation()
    expect(ipc.voiceBegin).toHaveBeenCalledWith('main')
  })

  test('ends when this window is recording', () => {
    registerDictationTarget(makeTarget())
    rec(1)
    toggleDictation()
    expect(ipc.voiceEnd).toHaveBeenCalled()
    expect(ipc.voiceBegin).not.toHaveBeenCalled()
  })

  test.each([
    ['mic-denied', 'Microphone access is off for Verun. Turn it on in System Settings.'],
    [{ engine: 'x' }, 'Dictation failed. Try again.'],
  ] as const)('a rejected begin %j is handled like a voice-error', async (error, msg) => {
    vi.mocked(ipc.voiceBegin).mockRejectedValue(error)
    toggleDictation()
    await vi.waitFor(() => expect(addToast).toHaveBeenCalledWith(msg, 'error'))
  })

  test('a second toggle while the begin is in flight is ignored', async () => {
    let resolve!: () => void
    vi.mocked(ipc.voiceBegin).mockReturnValueOnce(new Promise<void>(r => { resolve = r }))
    toggleDictation()
    toggleDictation()
    expect(ipc.voiceBegin).toHaveBeenCalledTimes(1)
    expect(ipc.voiceEnd).not.toHaveBeenCalled()
    resolve()
    await vi.waitFor(() => {
      toggleDictation()
      expect(ipc.voiceBegin).toHaveBeenCalledTimes(2)
    })
  })

  test('a rejected begin clears the in-flight guard', async () => {
    vi.mocked(ipc.voiceBegin).mockRejectedValueOnce({ engine: 'x' })
    toggleDictation()
    await vi.waitFor(() => expect(addToast).toHaveBeenCalled())
    toggleDictation()
    expect(ipc.voiceBegin).toHaveBeenCalledTimes(2)
  })

  test('a rejected begin with disabled opens setup, no toast', async () => {
    vi.mocked(ipc.voiceBegin).mockRejectedValue('disabled')
    toggleDictation()
    await vi.waitFor(() => expect(dictationSetupRequest()).toEqual({ reason: 'enable' }))
    expect(addToast).not.toHaveBeenCalled()
  })
})

describe('model downloads', () => {
  const model = { id: 'whisper-turbo' as const, displayName: 'Whisper Turbo', installed: false, bytes: 574041195 }
  const progress = (over: Record<string, unknown>) =>
    fire('voice-model-progress', { model: 'whisper-turbo', received: 0, total: 100, done: false, error: null, ...over })

  test('voice-model-progress events are tracked per model', () => {
    expect(modelDownloads()['whisper-turbo']).toBeUndefined()
    progress({ received: 40 })
    expect(modelDownloads()['whisper-turbo']).toEqual({ received: 40, total: 100, done: false, error: null })
    progress({ received: 100, done: true, error: 'disk full' })
    expect(modelDownloads()['whisper-turbo']).toEqual({ received: 100, total: 100, done: true, error: 'disk full' })
  })

  test('a finished download is forgotten once status shows the model installed', () => {
    progress({ received: 100, done: true })
    expect(modelDownloads()['whisper-turbo']?.done).toBe(true)
    fire('voice-status-changed', status({ models: [{ ...model, installed: true }] }))
    expect(modelDownloads()['whisper-turbo']).toBeUndefined()
  })

  test('starting a download shows it as running at once and asks the backend', () => {
    vi.mocked(ipc.voiceDownloadModel).mockResolvedValue(undefined)
    fire('voice-status-changed', status({ models: [model] }))
    downloadDictationModel('whisper-turbo')
    expect(ipc.voiceDownloadModel).toHaveBeenCalledWith('whisper-turbo')
    expect(modelDownloads()['whisper-turbo']).toEqual({ received: 0, total: 574041195, done: false, error: null })
  })

  test('starting again after an error clears the error', () => {
    vi.mocked(ipc.voiceDownloadModel).mockResolvedValue(undefined)
    progress({ done: true, error: 'boom' })
    downloadDictationModel('whisper-turbo')
    expect(modelDownloads()['whisper-turbo']?.error).toBeNull()
    expect(modelDownloads()['whisper-turbo']?.done).toBe(false)
  })

  test('a running download is not asked for again, so it cannot be marked failed', async () => {
    vi.mocked(ipc.voiceDownloadModel).mockRejectedValue('already running')
    progress({ received: 60 })
    downloadDictationModel('whisper-turbo')
    await Promise.resolve()
    expect(ipc.voiceDownloadModel).not.toHaveBeenCalled()
    expect(modelDownloads()['whisper-turbo']).toEqual({ received: 60, total: 100, done: false, error: null })
  })

  test('a rejected download reads as a failed one', async () => {
    vi.mocked(ipc.voiceDownloadModel).mockRejectedValue('no network')
    downloadDictationModel('whisper-turbo')
    await vi.waitFor(() => expect(modelDownloads()['whisper-turbo']?.error).toBe('no network'))
    expect(modelDownloads()['whisper-turbo']?.done).toBe(true)
  })

  test('cancelling asks the backend to stop that download', () => {
    vi.mocked(ipc.voiceCancelDownload).mockResolvedValue(undefined)
    progress({ received: 40 })
    cancelDictationDownload('whisper-turbo')
    expect(ipc.voiceCancelDownload).toHaveBeenCalledWith('whisper-turbo')
  })

  test('a cancelled download is forgotten quietly, so the download button comes back', () => {
    progress({ received: 40 })
    progress({ received: 40, done: true, cancelled: true })
    expect(modelDownloads()['whisper-turbo']).toBeUndefined()
    expect(addToast).not.toHaveBeenCalled()
  })

  test('deleting a model applies the status it returns', async () => {
    vi.mocked(ipc.voiceDeleteModel).mockResolvedValue(status({ models: [model] }))
    await deleteDictationModel('whisper-turbo')
    expect(ipc.voiceDeleteModel).toHaveBeenCalledWith('whisper-turbo')
    expect(voiceStatus()?.models).toEqual([model])
  })
})

describe('status actions', () => {
  test('refreshVoiceStatus re-reads the status', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ accessibility: false }))
    await refreshVoiceStatus()
    expect(voiceStatus()?.accessibility).toBe(false)
  })

  test('setDictationEnabled applies the status it returns', async () => {
    vi.mocked(ipc.voiceSetEnabled).mockResolvedValue(status({ enabled: false }))
    await setDictationEnabled(false)
    expect(ipc.voiceSetEnabled).toHaveBeenCalledWith(false)
    expect(voiceStatus()?.enabled).toBe(false)
  })

  test('a failed action toasts', async () => {
    vi.mocked(ipc.voiceSetEnabled).mockRejectedValue('nope')
    await setDictationEnabled(true)
    expect(addToast).toHaveBeenCalledWith('Dictation: nope', 'error')
  })

  test('requestMicrophone asks, then re-reads the status', async () => {
    vi.mocked(ipc.voiceRequestMicrophone).mockResolvedValue('granted')
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ microphone: 'granted', enabled: false }))
    await requestMicrophone()
    expect(ipc.voiceRequestMicrophone).toHaveBeenCalled()
    expect(voiceStatus()?.enabled).toBe(false)
  })

  test('dictationAvailable follows supported', () => {
    expect(dictationAvailable()).toBe(true)
    fire('voice-status-changed', status({ supported: false }))
    expect(dictationAvailable()).toBe(false)
  })
})

describe('focus re-check', () => {
  test('the test reset drops every watcher and the window listener', () => {
    watchVoiceStatusOnFocus()
    __resetVoiceForTests()
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    window.dispatchEvent(new Event('focus'))
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before)
    const stop = watchVoiceStatusOnFocus()
    window.dispatchEvent(new Event('focus'))
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
    stop()
  })

  test('one status read per focus however many watch, none after the last stops', async () => {
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    const stopA = watchVoiceStatusOnFocus()
    const stopB = watchVoiceStatusOnFocus()
    window.dispatchEvent(new Event('focus'))
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
    stopA()
    window.dispatchEvent(new Event('focus'))
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 2)
    stopB()
    stopB()
    window.dispatchEvent(new Event('focus'))
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 2)
  })
})

describe('Accessibility granted after setup', () => {
  const reads = () => vi.mocked(ipc.voiceStatus).mock.calls.length
  const focus = () => window.dispatchEvent(new Event('focus'))

  test('while dictation is on without Accessibility, focusing the window re-reads the status', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ accessibility: false }))
    fire('voice-status-changed', status({ accessibility: false }))
    const before = reads()
    focus()
    expect(reads()).toBe(before + 1)
    // One watcher, however many status events say the same.
    fire('voice-status-changed', status({ accessibility: false }))
    focus()
    expect(reads()).toBe(before + 2)
  })

  test('stops once Accessibility is granted', async () => {
    fire('voice-status-changed', status({ accessibility: false }))
    fire('voice-status-changed', status({ accessibility: true }))
    const before = reads()
    focus()
    expect(reads()).toBe(before)
  })

  test('stops once dictation is turned off, and never runs while it is off', async () => {
    fire('voice-status-changed', status({ accessibility: false }))
    fire('voice-status-changed', status({ accessibility: false, enabled: false }))
    const before = reads()
    focus()
    expect(reads()).toBe(before)
  })

  test('does not stop a watcher a view holds', async () => {
    const stop = watchVoiceStatusOnFocus()
    fire('voice-status-changed', status({ accessibility: false }))
    fire('voice-status-changed', status({ accessibility: true }))
    const before = reads()
    focus()
    expect(reads()).toBe(before + 1)
    stop()
  })
})

describe('pins of a window that closed', () => {
  const KEY = 'verun:voicePins'
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}')

  test('a pin is stored while its take is out and removed on its terminal event', () => {
    registerDictationTarget(makeTarget('a'))
    rec(1)
    expect(stored()).toEqual({ 1: { targetId: 'session:a', draftId: 'a', run: 'run-1' } })
    transcript('x', 1)
    expect(stored()).toEqual({})
  })

  test('a normal take leaves no stored pin behind', () => {
    registerDictationTarget(makeTarget('a'))
    rec(1)
    state('transcribing', 'main')
    dropped(1)
    rec(2)
    failed(2, { engine: 'x' })
    rec(3)
    state('idle', null)
    expect(stored()).toEqual({})
  })

  test('global idle clears only the stored pins this window created', () => {
    localStorage.setItem(KEY, JSON.stringify({ 9: { targetId: 'session:b', draftId: 'b', run: 'run-1' } }))
    registerDictationTarget(makeTarget('a'))
    rec(1)
    state('idle', null)
    expect(stored()).toEqual({ 9: { targetId: 'session:b', draftId: 'b', run: 'run-1' } })
  })

  test('an orphaned transcript with a stored pin for a live session goes to its draft', () => {
    localStorage.setItem(KEY, JSON.stringify({ 7: { targetId: 'session:a', draftId: 'a', run: 'run-1' } }))
    vi.mocked(sessionById).mockReturnValue({ id: 'a' } as never)
    saveDraftMessage('a', 'draft')
    transcript('more', 7)
    expect(loadDraftMessage('a')).toBe('draft more')
    expect(addToast).toHaveBeenCalledWith('Dictation saved to the draft of the chat you were in.', 'info')
    expect(stored()).toEqual({})
  })

  test('an orphaned transcript whose session is gone is dropped and forgotten', () => {
    localStorage.setItem(KEY, JSON.stringify({ 7: { targetId: 'session:a', draftId: 'a', run: 'run-1' } }))
    vi.mocked(sessionById).mockReturnValue(undefined)
    transcript('lost', 7)
    expect(loadDraftMessage('a')).toBeNull()
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
    expect(stored()).toEqual({})
  })

  test('an orphaned transcript with no stored pin shows the dropped toast', () => {
    localStorage.setItem(KEY, JSON.stringify({ 8: { targetId: 'new-task:p', draftId: 'new-task:p', run: 'run-1' } }))
    transcript('lost', 7)
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
    expect(stored()).toEqual({ 8: { targetId: 'new-task:p', draftId: 'new-task:p', run: 'run-1' } })
  })

  test('a stored pin from an earlier run of the app is never honoured', () => {
    // Take ids restart with each run: take 7 of the last run is not this run's take 7.
    localStorage.setItem(KEY, JSON.stringify({ 7: { targetId: 'session:a', draftId: 'a', run: 'run-0' } }))
    vi.mocked(sessionById).mockReturnValue({ id: 'a' } as never)
    saveDraftMessage('a', 'draft')
    transcript('stray', 7)
    expect(loadDraftMessage('a')).toBe('draft')
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })

  test('storing a pin drops the pins of earlier runs', () => {
    localStorage.setItem(KEY, JSON.stringify({ 9: { targetId: 'session:b', draftId: 'b', run: 'run-0' } }))
    registerDictationTarget(makeTarget('a'))
    rec(1)
    expect(stored()).toEqual({ 1: { targetId: 'session:a', draftId: 'a', run: 'run-1' } })
  })

  test('an orphaned transcript with a stored new-task pin goes to that project\'s draft', () => {
    localStorage.setItem(KEY, JSON.stringify({ 4: { targetId: 'new-task:p', draftId: 'new-task:p', run: 'run-1' } }))
    vi.mocked(projectById).mockReturnValue({ id: 'p' } as never)
    transcript('from the closed window', 4)
    expect(loadDraftMessage('new-task:p')).toBe('from the closed window')
    expect(stored()).toEqual({})
  })

  test('unreadable stored pins are ignored', () => {
    localStorage.setItem(KEY, 'not json')
    registerDictationTarget(makeTarget('a'))
    rec(1)
    transcript('x', 1)
    transcript('y', 5)
    expect(addToast).toHaveBeenCalledWith('Dictation dropped: that chat is gone.', 'info')
  })
})

describe('choosing a language', () => {
  const installed = (ok: boolean) => status({
    language: 'en',
    models: [{ id: 'whisper-turbo', displayName: 'W', installed: ok, bytes: 1 }],
    languages: [
      { code: 'en', model: 'whisper-turbo', installed: true },
      { code: 'ja', model: 'whisper-turbo', installed: ok },
    ],
  })

  beforeEach(() => {
    vi.mocked(ipc.voiceSetLanguage).mockImplementation(async language => ({ ...installed(true), language }))
  })

  test('an installed one is set at once', async () => {
    fire('voice-status-changed', installed(true))
    await chooseDictationLanguage('ja')
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('ja')
    expect(pendingDictationLanguage()).toBeNull()
  })

  test('one without its model waits until the model shows installed', async () => {
    fire('voice-status-changed', installed(false))
    await chooseDictationLanguage('ja')
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()
    expect(pendingDictationLanguage()).toBe('ja')
    fire('voice-status-changed', installed(true))
    await vi.waitFor(() => expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('ja'))
    expect(ipc.voiceSetLanguage).toHaveBeenCalledOnce()
    expect(pendingDictationLanguage()).toBeNull()
  })

  test('a cancelled download drops the language waiting for it', async () => {
    fire('voice-status-changed', installed(false))
    await chooseDictationLanguage('ja')
    fire('voice-model-progress', { model: 'whisper-turbo', received: 5, total: 100, done: false, error: null, cancelled: false })
    fire('voice-model-progress', { model: 'whisper-turbo', received: 5, total: 100, done: true, error: null, cancelled: true })
    expect(pendingDictationLanguage()).toBeNull()
  })

  test('setting a language directly drops a pending one', async () => {
    fire('voice-status-changed', installed(false))
    await chooseDictationLanguage('ja')
    await setDictationLanguage('en')
    expect(pendingDictationLanguage()).toBeNull()
  })
})
