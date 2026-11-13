import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import type { VoiceStatus, VoiceState } from '../types/voice'

const mocks = vi.hoisted(() => ({
  toggleDictation: vi.fn(),
  openDictationSetup: vi.fn(),
  voiceSetLanguage: vi.fn(),
  setDictationLanguage: vi.fn(),
}))

// The store's signals, driven by each test.
const voice = vi.hoisted(() => ({} as {
  status: () => VoiceStatus | null; setStatus: (s: VoiceStatus | null) => void
  state: () => VoiceState; setState: (s: VoiceState) => void
  level: () => number; setLevel: (l: number) => void
}))

vi.mock('../store/voice', async () => {
  const { createSignal } = await import('solid-js')
  const [status, setStatus] = createSignal<VoiceStatus | null>(null)
  const [state, setState] = createSignal<VoiceState>('idle')
  const [level, setLevel] = createSignal(0)
  Object.assign(voice, { status, setStatus, state, setState, level, setLevel })
  return {
    voiceStatus: status,
    voiceState: state,
    voiceLevel: level,
    toggleDictation: mocks.toggleDictation,
    openDictationSetup: mocks.openDictationSetup,
    setDictationLanguage: mocks.setDictationLanguage,
  }
})
vi.mock('../lib/ipc', () => ({ voiceSetLanguage: mocks.voiceSetLanguage }))

import { DictationControl } from './DictationControl'

const status = (over: Partial<VoiceStatus> = {}): VoiceStatus => ({
  supported: true, enabled: true, language: 'en', holdKey: 'fn', accessibility: true,
  microphone: 'granted', state: 'idle', models: [],
  languages: [
    { code: 'en', model: 'whisper-turbo', installed: true },
    { code: 'fr', model: 'whisper-turbo', installed: true },
    { code: 'ar', model: 'whisper-turbo', installed: false },
  ],
  ...over,
})

const mic = () => screen.getByRole('button', { name: 'Dictate' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.voiceSetLanguage.mockResolvedValue(status({ language: 'fr' }))
  mocks.setDictationLanguage.mockResolvedValue(undefined)
  voice.setStatus(status())
  voice.setState('idle')
  voice.setLevel(0)
})
afterEach(cleanup)

describe('DictationControl', () => {
  test('renders nothing before the status is known, or where dictation is not supported', () => {
    voice.setStatus(null)
    const { container } = render(() => <DictationControl />)
    expect(container.innerHTML).toBe('')
    voice.setStatus(status({ supported: false }))
    expect(container.innerHTML).toBe('')
  })

  test('shows the mic button when supported; clicking it toggles dictation without taking focus', () => {
    render(() => <DictationControl />)
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    const down = fireEvent.mouseDown(mic())
    expect(down).toBe(false) // default prevented: the composer keeps its caret
    fireEvent.click(mic())
    expect(mocks.toggleDictation).toHaveBeenCalledOnce()
  })

  test.each([
    ['fn', 'Dictate (hold Fn)'],
    ['right-option', 'Dictate (hold Right Option)'],
    ['right-command', 'Dictate (hold Right Command)'],
  ] as const)('the tooltip names the hold key %s', (holdKey, title) => {
    voice.setStatus(status({ holdKey }))
    render(() => <DictationControl />)
    expect(mic().title).toBe(title)
  })

  test('before dictation is set up the button offers setup and there is no language switcher', () => {
    voice.setStatus(status({ enabled: false }))
    render(() => <DictationControl />)
    expect(mic().title).toBe('Set up dictation')
    expect(screen.queryByRole('button', { name: /Dictation language/ })).toBeNull()
  })

  test('while recording: pressed, a live level meter, and nothing moves', () => {
    render(() => <DictationControl />)
    const size = (el: HTMLElement) => el.className.split(' ').filter(c => /^(w|h)-/.test(c))
    const idleSize = size(mic())
    voice.setState('recording')
    voice.setLevel(0.5)
    expect(mic().getAttribute('aria-pressed')).toBe('true')
    // The announced state is the status region's own text, not a label on top of it.
    expect(screen.getByRole('status').textContent).toBe('Recording')
    expect(screen.getByRole('status').hasAttribute('aria-label')).toBe(false)
    const bars = mic().querySelectorAll<HTMLElement>('[data-level-bar]')
    expect(bars.length).toBeGreaterThan(0)
    const before = bars[0].style.transform
    voice.setLevel(1)
    expect(bars[0].style.transform).not.toBe(before)
    // Same box in every state: the meter lives inside the fixed-size button.
    expect(size(mic())).toEqual(idleSize)
    expect(idleSize).toEqual(['w-7', 'h-7'])
  })

  test('while transcribing: a working state in the same place', () => {
    render(() => <DictationControl />)
    voice.setState('transcribing')
    expect(screen.getByRole('status').textContent).toBe('Transcribing')
    expect(mic().getAttribute('aria-pressed')).toBe('false')
  })

  test('idle has no recording or working state', () => {
    render(() => <DictationControl />)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  test('the switcher shows the language and lists only installed ones, by name, with the current one checked', () => {
    render(() => <DictationControl />)
    const switcher = screen.getByRole('button', { name: 'Dictation language: English' })
    expect(switcher.textContent).toBe('EN')
    fireEvent.click(switcher)
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map(i => i.textContent)).toEqual(['English', 'French'])
    expect(items.map(i => i.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  test('choosing a language sets it and closes the menu', () => {
    render(() => <DictationControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictation language: English' }))
    // Picking from the menu must not take focus (and the caret) from the composer.
    expect(fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: 'French' }))).toBe(false)
    expect(fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Add language...' }))).toBe(false)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'French' }))
    // Through the store, like the Settings select, so a pending choice from setup is dropped.
    expect(mocks.setDictationLanguage).toHaveBeenCalledWith('fr')
    expect(mocks.voiceSetLanguage).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  test('a status event keeps the menu rows, so a focused item stays focused', () => {
    render(() => <DictationControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictation language: English' }))
    const french = screen.getByRole('menuitemradio', { name: 'French' })
    french.focus()
    voice.setStatus(status())
    expect(french.isConnected).toBe(true)
    expect(document.activeElement).toBe(french)
  })

  test('Add language... opens dictation setup', () => {
    render(() => <DictationControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictation language: English' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add language...' }))
    expect(mocks.openDictationSetup).toHaveBeenCalledOnce()
    expect(mocks.openDictationSetup).toHaveBeenCalledWith({ reason: 'add-language' })
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
