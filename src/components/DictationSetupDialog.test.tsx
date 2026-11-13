import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'

// The first-run setup for dictation: microphone, language, model download,
// Accessibility for the hold key, then on. Each step is skipped once it is
// satisfied, and nothing (prompt, download, enable) happens before the user asks.
// Every request says why setup opened, and that decides the steps and the finish.

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
  voiceBegin: vi.fn(),
  voiceEnd: vi.fn(),
  voiceCancel: vi.fn(),
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
import {
  initVoice, openDictationSetup, toggleDictation, dictationSetupRequest, __resetVoiceForTests,
  type DictationSetupRequest, type SetupReason,
} from '../store/voice'
import { DictationSetupDialog } from './DictationSetupDialog'
import { DictationSettings } from './DictationSettings'
import { DictationControl } from './DictationControl'
import type { Language, VoiceStatus } from '../types/voice'

const CODES: Language[] = ['en', 'fr', 'es', 'ar', 'zh', 'hi', 'pt', 'ru', 'bn', 'ur', 'ja', 'de']

/** `installed` is the model; `missing` marks languages as not ready on their own (synthetic, for language tests). */
function status(over: Partial<VoiceStatus> & { installed?: boolean; missing?: Language[] } = {}): VoiceStatus {
  const { installed = true, missing = [], ...rest } = over
  return {
    supported: true, enabled: false, language: 'en', holdKey: 'fn', accessibility: true, fnSystemAction: 'none',
    microphone: 'granted', state: 'idle',
    models: [{ id: 'whisper-turbo', displayName: 'Whisper Turbo', installed, bytes: 574041195 }],
    languages: CODES.map(code => ({ code, model: 'whisper-turbo', installed: installed && !missing.includes(code) })),
    ...rest,
  }
}

const HINT_EMOJI = 'macOS also uses the Fn key to show the emoji picker. Turn that off in System Settings > Keyboard, or choose another hold key.'
const fire = (event: string, payload: unknown) => listeners.get(event)!({ payload })
const setStatus = (s: VoiceStatus) => fire('voice-status-changed', s)
const progress = (over: Record<string, unknown>) =>
  fire('voice-model-progress', { model: 'whisper-turbo', received: 0, total: 574041195, done: false, error: null, ...over })
const flush = () => new Promise(r => setTimeout(r, 0))
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

async function setup(s: VoiceStatus, request: DictationSetupRequest = { reason: 'enable' }) {
  vi.mocked(ipc.voiceStatus).mockResolvedValue(s)
  await initVoice()
  setStatus(s)
  render(() => <DictationSetupDialog />)
  openDictationSetup(request)
  await flush()
}

beforeEach(() => {
  vi.resetAllMocks()
  listeners.clear()
  __resetVoiceForTests()
  vi.mocked(ipc.voiceSetEnabled).mockImplementation(async enabled => status({ enabled }))
  vi.mocked(ipc.voiceSetLanguage).mockImplementation(async language => status({ language }))
  vi.mocked(ipc.voiceDownloadModel).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceSetTarget).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceOpenAccessibilitySettings).mockResolvedValue(undefined)
  vi.mocked(ipc.voiceBegin).mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('nothing happens before the user asks', () => {
  test('mounting with no request shows nothing and calls nothing', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ microphone: 'undetermined', installed: false }))
    await initVoice()
    render(() => <DictationSetupDialog />)
    await flush()
    expect(screen.queryByText('Allow microphone')).toBeNull()
    expect(ipc.voiceRequestMicrophone).not.toHaveBeenCalled()
    expect(ipc.voiceDownloadModel).not.toHaveBeenCalled()
    expect(ipc.voiceSetEnabled).not.toHaveBeenCalled()
  })

  const reasons: DictationSetupRequest[] = [
    { reason: 'enable' }, { reason: 'model-missing' }, { reason: 'add-language' }, { reason: 'language', language: 'ja' },
  ]
  test.each([
    ...reasons.map(r => ['all satisfied and on', r, status({ enabled: true })] as const),
    ...reasons.map(r => ['fresh and off', r, status({ microphone: 'undetermined', accessibility: false, installed: false })] as const),
  ])('opening (%s, %j) only shows', async (_, request, s) => {
    await setup(s, request)
    expect(screen.getByText('Set up dictation')).toBeTruthy()
    expect(ipc.voiceSetEnabled).not.toHaveBeenCalled()
    expect(ipc.voiceDownloadModel).not.toHaveBeenCalled()
    expect(ipc.voiceRequestMicrophone).not.toHaveBeenCalled()
    expect(ipc.voiceOpenAccessibilitySettings).not.toHaveBeenCalled()
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()
  })
})

describe('microphone step', () => {
  test('undetermined: Allow microphone asks, then re-reads the status', async () => {
    await setup(status({ microphone: 'undetermined' }))
    expect(ipc.voiceRequestMicrophone).not.toHaveBeenCalled()
    const allow = screen.getByRole('button', { name: 'Allow microphone' })
    expect(document.activeElement).toBe(allow)

    vi.mocked(ipc.voiceRequestMicrophone).mockResolvedValue('granted')
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status())
    fireEvent.click(allow)
    await flush()

    expect(ipc.voiceRequestMicrophone).toHaveBeenCalledOnce()
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy()
  })

  test('denied: points at System Settings and can check again', async () => {
    await setup(status({ microphone: 'denied' }))
    expect(screen.getByText(/Privacy & Security > Microphone/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow microphone' })).toBeNull()

    click('Check again')
    await flush()

    expect(ipc.voiceStatus).toHaveBeenCalledTimes(2)
    expect(ipc.voiceRequestMicrophone).not.toHaveBeenCalled()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('language step', () => {
  test('a granted microphone is skipped; all languages listed, current one chosen, installed ones Ready', async () => {
    await setup(status({ language: 'fr' }))
    expect(screen.queryByText('Allow microphone')).toBeNull()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map(r => r.labels?.[0]?.textContent?.replace('Ready', '').trim())).toEqual([
      'English', 'French', 'Spanish', 'Arabic', 'Chinese (Mandarin)', 'Hindi', 'Portuguese', 'Russian',
      'Bengali', 'Urdu', 'Japanese', 'German',
    ])
    expect((screen.getByLabelText(/French/) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByText('Ready')).toHaveLength(12)
  })

  test('Continue sets an installed language at once', async () => {
    await setup(status({ enabled: true }), { reason: 'add-language' })
    fireEvent.click(screen.getByLabelText(/French/))
    click('Continue')
    await flush()
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('fr')
  })

  test('a language that still needs its model is set only once the model shows installed', async () => {
    // Synthetic: English works today, Japanese waits for the model.
    const waiting = { ...status({ enabled: true, missing: ['ja'] }), models: status({ installed: false }).models }
    await setup(waiting, { reason: 'add-language' })
    fireEvent.click(screen.getByLabelText(/Japanese/))
    click('Continue')
    await flush()
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()

    click('Download (574 MB)')
    progress({ received: 574041195, done: true })
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()
    setStatus(status({ enabled: true }))
    await flush()
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('ja')
    expect(ipc.voiceSetLanguage).toHaveBeenCalledOnce()
  })

  test('Continue leaves an unchanged language alone', async () => {
    await setup(status())
    click('Continue')
    await flush()
    expect(ipc.voiceSetLanguage).not.toHaveBeenCalled()
    expect(screen.getByText('Dictation is ready.')).toBeTruthy()
  })

  test('Add language... shows the languages even with everything done', async () => {
    await setup(status({ enabled: true }), { reason: 'add-language' })
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy()
  })

  test('a status event keeps the same rows, so the focused radio stays focused', async () => {
    await setup(status())
    const french = screen.getByLabelText(/French/) as HTMLInputElement
    french.focus()
    setStatus(status())
    expect(french.isConnected).toBe(true)
    expect(document.activeElement).toBe(french)
  })
})

describe('download step', () => {
  test('a language from Settings skips the language step; the download waits for a click that names the size', async () => {
    await setup(status({ installed: false }), { reason: 'language', language: 'ja' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText(/Whisper Turbo/)).toBeTruthy()
    expect(ipc.voiceDownloadModel).not.toHaveBeenCalled()

    const download = screen.getByRole('button', { name: 'Download (574 MB)' })
    expect(document.activeElement).toBe(download)
    fireEvent.click(download)
    expect(ipc.voiceDownloadModel).toHaveBeenCalledWith('whisper-turbo')
  })

  test('shows progress from the progress events', async () => {
    await setup(status({ enabled: true, installed: false }), { reason: 'model-missing' })
    click('Download (574 MB)')
    progress({ received: 287020597 })

    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('287020597')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('574041195')
    expect(screen.getByText('287 MB / 574 MB')).toBeTruthy()
    expect(screen.getByText('The download continues in the background.')).toBeTruthy()
  })

  test('Cancel stops the download; once it ends the download button is back', async () => {
    vi.mocked(ipc.voiceCancelDownload).mockResolvedValue(undefined)
    await setup(status({ enabled: true, installed: false }), { reason: 'model-missing' })
    click('Download (574 MB)')
    progress({ received: 10 })
    click('Cancel download')
    expect(ipc.voiceCancelDownload).toHaveBeenCalledWith('whisper-turbo')
    progress({ received: 10, done: true, cancelled: true })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/failed/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Download (574 MB)' })).toBeTruthy()
  })

  test('an error shows its text and Try again downloads again', async () => {
    await setup(status({ enabled: true, installed: false }), { reason: 'model-missing' })
    click('Download (574 MB)')
    progress({ received: 10, done: true, error: 'Connection reset' })

    expect(screen.getByText(/Connection reset/)).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    click('Try again')
    expect(ipc.voiceDownloadModel).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  test('a finished download moves on by itself', async () => {
    await setup(status({ enabled: true, installed: false, accessibility: false }), { reason: 'model-missing' })
    click('Download (574 MB)')
    progress({ received: 574041195, done: true })
    setStatus(status({ enabled: true, accessibility: false }))
    expect(screen.getByRole('button', { name: 'Open System Settings' })).toBeTruthy()
  })

  test('closing mid-download keeps it running; the mic button reopens on the progress', async () => {
    await setup(status({ installed: false }))
    fireEvent.click(screen.getByLabelText(/French/))
    click('Continue')
    await flush()
    click('Download (574 MB)')
    progress({ received: 100_000_000 })

    click('Close')
    expect(dictationSetupRequest()).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()

    progress({ received: 200_000_000 })
    toggleDictation()
    await flush()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('200000000')
    expect(ipc.voiceDownloadModel).toHaveBeenCalledOnce()
  })

  test('a model-missing error lands on the download step', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ enabled: true, installed: false }))
    await initVoice()
    render(() => <DictationSetupDialog />)
    fire('voice-error', { window: 'main', take: null, error: 'model-missing' })
    await flush()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Download (574 MB)' })).toBeTruthy()
  })

  test('a language with no known model says so and can be closed', async () => {
    await setup({ ...status({ installed: false }), models: [] }, { reason: 'language', language: 'ja' })
    expect(screen.getByText(/No speech model is available for Japanese/)).toBeTruthy()
    click('Close')
    expect(dictationSetupRequest()).toBeNull()
  })
})

describe('after a model-missing error', () => {
  test('the finished download goes on to the end, not back to the languages', async () => {
    await setup(status({ enabled: true, installed: false }), { reason: 'model-missing' })
    click('Download (574 MB)')
    progress({ received: 574041195, done: true })
    setStatus(status({ enabled: true }))
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('Dictation is ready.')).toBeTruthy()
  })
})

describe('accessibility step', () => {
  test('opens System Settings, re-checks on window focus and on Check again', async () => {
    await setup(status({ enabled: true, accessibility: false }), { reason: 'model-missing' })
    expect(screen.getByText(/holding Fn to talk/i)).toBeTruthy()

    click('Open System Settings')
    expect(ipc.voiceOpenAccessibilitySettings).toHaveBeenCalledOnce()

    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ enabled: true }))
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
    expect(screen.getByText('Dictation is ready.')).toBeTruthy()
  })

  test('Check again re-reads the status', async () => {
    await setup(status({ enabled: true, accessibility: false }), { reason: 'model-missing' })
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    click('Check again')
    await flush()
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
  })

  test('the focus re-check goes away with the dialog', async () => {
    // Off, so the store's own Accessibility watch (while on without it) is not in play.
    await setup(status({ accessibility: false }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dictationSetupRequest()).toBeNull()
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before)
  })

  test('one focus re-check with the dialog open over Settings -> Dictation', async () => {
    await setup(status({ enabled: true, accessibility: false }), { reason: 'model-missing' })
    render(() => <DictationSettings />)
    await flush()
    const before = vi.mocked(ipc.voiceStatus).mock.calls.length
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(ipc.voiceStatus).toHaveBeenCalledTimes(before + 1)
  })

  test('Skip, use the button only, then Done turns dictation on', async () => {
    await setup(status({ accessibility: false }))
    click('Continue')
    await flush()
    click('Skip, use the button only')
    expect(screen.getByText(/The mic button works now/)).toBeTruthy()

    click('Done')
    await flush()
    expect(ipc.voiceSetEnabled).toHaveBeenCalledWith(true)
    expect(dictationSetupRequest()).toBeNull()
  })
})

describe('Fn also used by macOS', () => {
  test.each([
    ['input-source', 'macOS also uses the Fn key to change the input source. Turn that off in System Settings > Keyboard, or choose another hold key.'],
    ['emoji', 'macOS also uses the Fn key to show the emoji picker. Turn that off in System Settings > Keyboard, or choose another hold key.'],
    ['dictation', 'macOS also uses the Fn key to start macOS dictation. Turn that off in System Settings > Keyboard, or choose another hold key.'],
  ] as const)('the hold key step says macOS also acts on Fn (%s)', async (fnSystemAction, line) => {
    await setup(status({ enabled: true, accessibility: false, fnSystemAction }), { reason: 'model-missing' })
    expect(screen.getByText(/holding Fn to talk/i)).toBeTruthy()
    expect(screen.getByText(line)).toBeTruthy()
  })

  test('so does the last step, which names the hold key', async () => {
    await setup(status({ enabled: true, fnSystemAction: 'emoji' }), { reason: 'model-missing' })
    expect(screen.getByText('Dictation is ready.')).toBeTruthy()
    expect(screen.getByText(HINT_EMOJI)).toBeTruthy()
  })

  test.each(['none', 'unknown'] as const)('nothing when macOS does %s with Fn', async (fnSystemAction) => {
    await setup(status({ enabled: true, accessibility: false, fnSystemAction }), { reason: 'model-missing' })
    expect(screen.queryByText(/macOS also uses the Fn key/)).toBeNull()
  })

  test('nothing with another hold key', async () => {
    await setup(status({ enabled: true, accessibility: false, holdKey: 'right-command', fnSystemAction: 'dictation' }), { reason: 'model-missing' })
    expect(screen.queryByText(/macOS also uses the Fn key/)).toBeNull()
  })
})

describe('finish', () => {
  test('turning it on: Done enables dictation', async () => {
    await setup(status())
    click('Continue')
    await flush()
    click('Done')
    await flush()
    expect(ipc.voiceSetEnabled).toHaveBeenCalledWith(true)
    expect(dictationSetupRequest()).toBeNull()
  })

  test('Done does not re-enable dictation that is already on', async () => {
    await setup(status({ enabled: true }))
    click('Continue')
    await flush()
    click('Done')
    await flush()
    expect(ipc.voiceSetEnabled).not.toHaveBeenCalled()
  })

  test.each([
    ['language', { reason: 'language', language: 'fr' }],
    ['add-language', { reason: 'add-language' }],
  ] as const)('%s: Done sets the language and leaves dictation off', async (_, request) => {
    await setup(status(), request as DictationSetupRequest)
    if ((request.reason as SetupReason) === 'add-language') {
      fireEvent.click(screen.getByLabelText(/French/))
      click('Continue')
      await flush()
    }
    expect(screen.queryByText('Dictation is ready.')).toBeNull()
    expect(screen.getByText('French is ready.')).toBeTruthy()
    click('Done')
    await flush()
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('fr')
    expect(ipc.voiceSetLanguage).toHaveBeenCalledOnce()
    expect(ipc.voiceSetEnabled).not.toHaveBeenCalled()
    expect(dictationSetupRequest()).toBeNull()
  })
})

describe('escape', () => {
  test('closes the dialog and not what is behind it (Settings)', async () => {
    await setup(status())
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)
    expect(dictationSetupRequest()).toBeNull()
    expect(behind).not.toHaveBeenCalled()
  })
})

describe('entry points', () => {
  test('the mic button while dictation is off opens setup instead of recording', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ microphone: 'undetermined' }))
    await initVoice()
    render(() => <DictationSetupDialog />)
    toggleDictation()
    await flush()
    expect(ipc.voiceBegin).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Allow microphone' })).toBeTruthy()
  })
})

describe('a pending language is applied only for the latest choice, with its download in play', () => {
  // Synthetic: English works today, Japanese waits for the model.
  const waiting = () => ({ ...status({ enabled: true, missing: ['ja'] }), models: status({ installed: false }).models })
  const ready = () => status({ enabled: true })
  const chooseJapanese = async () => {
    await setup(waiting(), { reason: 'add-language' })
    fireEvent.click(screen.getByLabelText(/Japanese/))
    click('Continue')
    await flush()
  }
  const appliedJapanese = () => vi.mocked(ipc.voiceSetLanguage).mock.calls.filter(c => c[0] === 'ja').length

  test('a newer choice in the composer switcher drops it', async () => {
    await chooseJapanese()
    render(() => <DictationControl available />)
    click('Dictation language: English')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'French' }))
    await flush()
    expect(ipc.voiceSetLanguage).toHaveBeenCalledWith('fr')
    setStatus(ready())
    await flush()
    expect(appliedJapanese()).toBe(0)
  })

  test('closing setup before the download starts drops it', async () => {
    await chooseJapanese()
    click('Close')
    setStatus(ready())
    await flush()
    expect(appliedJapanese()).toBe(0)
  })

  test('closing setup with its download running keeps it: applied once the download completes', async () => {
    await chooseJapanese()
    click('Download (574 MB)')
    progress({ received: 1 })
    click('Close')
    progress({ received: 574041195, done: true })
    setStatus(ready())
    await flush()
    expect(appliedJapanese()).toBe(1)
  })

  test('a failed download drops it, even if the model arrives later', async () => {
    await chooseJapanese()
    click('Download (574 MB)')
    progress({ received: 1, done: true, error: 'Connection reset' })
    setStatus(ready())
    await flush()
    expect(appliedJapanese()).toBe(0)
  })

  test('Done does not send the language again when the status path already sent it', async () => {
    await chooseJapanese()
    click('Download (574 MB)')
    progress({ received: 574041195, done: true })
    // The status path sends `ja`; its reply has not arrived yet.
    vi.mocked(ipc.voiceSetLanguage).mockReturnValue(new Promise(() => {}))
    setStatus(ready())
    await flush()
    click('Done')
    await flush()
    expect(appliedJapanese()).toBe(1)
  })
})

describe('after a failed download', () => {
  const failedThenOpen = async (request: DictationSetupRequest) => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue(status({ enabled: true, installed: false }))
    await initVoice()
    progress({ received: 1, done: true, error: 'Connection reset' })
    render(() => <DictationSetupDialog />)
    openDictationSetup(request)
    await flush()
  }

  test('Add language... still shows the language list', async () => {
    await failedThenOpen({ reason: 'add-language' })
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy()
  })

  test('turning it on goes back to the failed download', async () => {
    await failedThenOpen({ reason: 'enable' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('the hold key permission is only asked when turning dictation on', () => {
  test.each([
    ['add-language', { reason: 'add-language' }],
    ['language', { reason: 'language', language: 'fr' }],
  ] as const)('%s with no Accessibility goes to Done', async (_, request) => {
    await setup(status({ enabled: true, accessibility: false }), request as DictationSetupRequest)
    if (request.reason === 'add-language') {
      click('Continue')
      await flush()
    }
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })
})
