import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@solidjs/testing-library'

// Settings -> Dictation: the switch, language, hold key, permissions and the
// downloaded models. Turning it on before setup is done goes through setup.

const listeners = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, cb)
    return Promise.resolve(() => listeners.delete(event))
  },
}))
vi.mock('../lib/ipc', () => ({
  voiceStatus: vi.fn(),
  voiceSetTarget: vi.fn(),
  voiceSetEnabled: vi.fn(),
  voiceSetLanguage: vi.fn(),
  voiceSetHoldKey: vi.fn(),
  voiceDownloadModel: vi.fn(),
  voiceCancelDownload: vi.fn(),
  voiceDeleteModel: vi.fn(),
  voiceRequestMicrophone: vi.fn(),
  voiceOpenAccessibilitySettings: vi.fn(),
}))
vi.mock('../store/sessions', () => ({ sessionById: vi.fn() }))

import * as ipc from '../lib/ipc'
import { initVoice, dictationSetupRequest, __resetVoiceForTests } from '../store/voice'
import { DictationSettings } from './DictationSettings'
import type { Language, VoiceStatus } from '../types/voice'

const CODES: Language[] = ['en', 'fr', 'es', 'ar', 'zh', 'hi', 'pt', 'ru', 'bn', 'ur', 'ja', 'de']

function status(over: Partial<VoiceStatus> & { installed?: boolean } = {}): VoiceStatus {
  const { installed = true, ...rest } = over
  return {
    supported: true, enabled: false, language: 'en', holdKey: 'fn', accessibility: true, fnSystemAction: 'none',
    microphone: 'granted', state: 'idle',
    models: [{ id: 'whisper-turbo', displayName: 'Whisper Turbo', installed, bytes: 574041195 }],
    languages: CODES.map(code => ({ code, model: 'whisper-turbo', installed })),
    ...rest,
  }
}

const fire = (event: string, payload: unknown) => listeners.get(event)!({ payload })
const flush = () => new Promise(r => setTimeout(r, 0))

async function setup(s: VoiceStatus) {
  vi.mocked(ipc.voiceStatus).mockResolvedValue(s)
  await initVoice()
  render(() => <DictationSettings />)
  await flush()
}

beforeEach(() => {
  vi.resetAllMocks()
  listeners.clear()
  __resetVoiceForTests()
  vi.mocked(ipc.voiceSetEnabled).mockImplementation(async enabled => status({ enabled }))
  vi.mocked(ipc.voiceSetLanguage).mockImplementation(async language => status({ language }))
  vi.mocked(ipc.voiceSetHoldKey).mockImplementation(async holdKey => status({ holdKey }))
  vi.mocked(ipc.voiceDeleteModel).mockImplementation(async () => status({ installed: false }))
  vi.mocked(ipc.voiceDownloadModel).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceSetTarget).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceRequestMicrophone).mockResolvedValue('granted')
  vi.mocked(ipc.voiceOpenAccessibilitySettings).mockResolvedValue(undefined)
})

afterEach(() => cleanup())

test('says where the audio goes', async () => {
  await setup(status())
  expect(screen.getByText('Audio is transcribed on this Mac and never saved or sent anywhere.')).toBeTruthy()
})

test('the switch says whether dictation is on', async () => {
  await setup(status({ enabled: true }))
  expect(screen.getByRole('switch', { name: 'Dictation' }).getAttribute('aria-checked')).toBe('true')
})

describe('selects follow the status across status events', () => {
  test('language and hold key keep their values', async () => {
    await setup(status({ language: 'fr', holdKey: 'right-option' }))
    fire('voice-status-changed', status({ language: 'fr', holdKey: 'right-option' }))
    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('fr')
    expect((screen.getByLabelText('Hold key') as HTMLSelectElement).value).toBe('right-option')
  })
})

test('a status event keeps the model rows, so a focused Delete stays focused', async () => {
  await setup(status())
  const del = screen.getByRole('button', { name: 'Delete Whisper Turbo' })
  del.focus()
  fire('voice-status-changed', status())
  expect(del.isConnected).toBe(true)
  expect(document.activeElement).toBe(del)
})

test('re-reads the status when shown and when the window regains focus', async () => {
  await setup(status())
  expect(ipc.voiceStatus).toHaveBeenCalledTimes(2) // initVoice, then the section
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(ipc.voiceStatus).toHaveBeenCalledTimes(3)
  cleanup()
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(ipc.voiceStatus).toHaveBeenCalledTimes(3)
})

describe('enable switch', () => {
  test('with setup done, turning it on calls voiceSetEnabled(true)', async () => {
    await setup(status())
    fireEvent.click(screen.getByRole('switch', { name: 'Dictation' }))
    await flush()
    expect(ipc.voiceSetEnabled).toHaveBeenCalledWith(true)
    expect(dictationSetupRequest()).toBeNull()
  })

  test.each([
    ['microphone not granted', status({ microphone: 'undetermined' })],
    ['model missing', status({ installed: false })],
  ])('with %s, turning it on opens setup instead', async (_, s) => {
    await setup(s)
    fireEvent.click(screen.getByRole('switch', { name: 'Dictation' }))
    await flush()
    expect(ipc.voiceSetEnabled).not.toHaveBeenCalled()
    expect(dictationSetupRequest()).toEqual({ reason: 'enable' })
  })

  test('turning it off calls voiceSetEnabled(false)', async () => {
    await setup(status({ enabled: true }))
    fireEvent.click(screen.getByRole('switch', { name: 'Dictation' }))
    await flush()
    expect(ipc.voiceSetEnabled).toHaveBeenCalledWith(false)
  })
})

describe('language', () => {
  test('lists every language and sets an installed one', async () => {
    await setup(status())
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect(select.options).toHaveLength(12)
    expect(select.value).toBe('en')
    fireEvent.change(select, { target: { value: 'de' } })
    await flush()
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('de')
  })

  test('one without its model opens setup for that language', async () => {
    await setup(status({ installed: false }))
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'ja' } })
    await flush()
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()
    expect(dictationSetupRequest()).toEqual({ reason: 'language', language: 'ja' })
    expect(select.value).toBe('en')
  })
})

test('changing the hold key calls voiceSetHoldKey', async () => {
  await setup(status())
  const select = screen.getByLabelText('Hold key') as HTMLSelectElement
  expect([...select.options].map(o => o.textContent)).toEqual(['Fn', 'Right Option', 'Right Command'])
  fireEvent.change(select, { target: { value: 'right-option' } })
  await flush()
  expect(ipc.voiceSetHoldKey).toHaveBeenCalledWith('right-option')
})

describe('permissions', () => {
  test('microphone undetermined: Allow asks for it', async () => {
    await setup(status({ microphone: 'undetermined' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow microphone' }))
    await flush()
    expect(ipc.voiceRequestMicrophone).toHaveBeenCalledOnce()
  })

  test('microphone denied: says where to turn it on', async () => {
    await setup(status({ microphone: 'denied' }))
    expect(screen.getByText(/Privacy & Security > Microphone/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow microphone' })).toBeNull()
  })

  test('hold key without Accessibility needs permission and can open System Settings', async () => {
    await setup(status({ accessibility: false }))
    expect(screen.getByText('Needs Accessibility permission')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(ipc.voiceOpenAccessibilitySettings).toHaveBeenCalledOnce()
  })

  test('with both granted, both rows read Ready', async () => {
    await setup(status())
    const rows = screen.getByRole('list', { name: 'Permissions' })
    expect(within(rows).getAllByText('Ready')).toHaveLength(2)
    expect(screen.queryByText('Needs Accessibility permission')).toBeNull()
  })
})

describe('Fn also used by macOS', () => {
  test.each([
    ['input-source', 'macOS also uses the Fn key to change the input source. Turn that off in System Settings > Keyboard, or choose another hold key.'],
    ['emoji', 'macOS also uses the Fn key to show the emoji picker. Turn that off in System Settings > Keyboard, or choose another hold key.'],
    ['dictation', 'macOS also uses the Fn key to start macOS dictation. Turn that off in System Settings > Keyboard, or choose another hold key.'],
  ] as const)('with Fn as the hold key and macOS set to %s, says so beside the hold key', async (fnSystemAction, line) => {
    await setup(status({ fnSystemAction }))
    expect(screen.getByText(line)).toBeTruthy()
  })

  test.each(['none', 'unknown'] as const)('nothing when macOS does %s with Fn', async (fnSystemAction) => {
    await setup(status({ fnSystemAction }))
    expect(screen.queryByText(/macOS also uses the Fn key/)).toBeNull()
  })

  test('nothing with another hold key', async () => {
    await setup(status({ fnSystemAction: 'emoji', holdKey: 'right-option' }))
    expect(screen.queryByText(/macOS also uses the Fn key/)).toBeNull()
  })
})

describe('models', () => {
  test('an installed model shows its size and deletes after confirming', async () => {
    await setup(status())
    const models = screen.getByRole('list', { name: 'Models' })
    expect(within(models).getByText('Whisper Turbo')).toBeTruthy()
    expect(within(models).getByText(/574 MB/)).toBeTruthy()
    expect(within(models).getByText('Installed')).toBeTruthy()

    fireEvent.click(within(models).getByRole('button', { name: 'Delete Whisper Turbo' }))
    expect(ipc.voiceDeleteModel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await flush()
    expect(ipc.voiceDeleteModel).toHaveBeenCalledWith('whisper-turbo')
    expect(within(models).getByText('Not installed')).toBeTruthy()
  })

  test('a missing model downloads with the size on the button and shows progress', async () => {
    await setup(status({ installed: false }))
    const models = screen.getByRole('list', { name: 'Models' })
    expect(within(models).getByText('Not installed')).toBeTruthy()
    fireEvent.click(within(models).getByRole('button', { name: 'Download (574 MB)' }))
    expect(ipc.voiceDownloadModel).toHaveBeenCalledWith('whisper-turbo')
    fire('voice-model-progress', { model: 'whisper-turbo', received: 57404119, total: 574041195, done: false, error: null })
    expect(within(models).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('57404119')
  })

  test('a running download can be cancelled from the models list', async () => {
    vi.mocked(ipc.voiceCancelDownload).mockResolvedValue(undefined)
    await setup(status({ installed: false }))
    const models = screen.getByRole('list', { name: 'Models' })
    fireEvent.click(within(models).getByRole('button', { name: 'Download (574 MB)' }))
    fire('voice-model-progress', { model: 'whisper-turbo', received: 5, total: 574041195, done: false, error: null })
    fireEvent.click(within(models).getByRole('button', { name: 'Cancel download' }))
    expect(ipc.voiceCancelDownload).toHaveBeenCalledWith('whisper-turbo')
    fire('voice-model-progress', { model: 'whisper-turbo', received: 5, total: 574041195, done: true, error: null, cancelled: true })
    expect(within(models).queryByRole('progressbar')).toBeNull()
    expect(within(models).getByRole('button', { name: 'Download (574 MB)' })).toBeTruthy()
  })
})
