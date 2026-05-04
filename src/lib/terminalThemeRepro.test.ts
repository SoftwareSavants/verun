import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { subscribeXtermToAppearance } from './terminalTheme'
import { applyAppearance, DEFAULT_PREFS } from './theme'

// xterm reaches into matchMedia / IntersectionObserver during open() — jsdom
// doesn't ship them. Bare-minimum stubs are enough for the DOM renderer path,
// which is what we hit here since jsdom has no canvas.
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }
  if (!('IntersectionObserver' in window)) {
    class IO {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: IO })
  }
})

describe('real XTerm responds to appearance changes', () => {
  let container: HTMLDivElement
  let term: XTerm

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(container)
  })

  afterEach(() => {
    term?.dispose()
    container.remove()
  })

  test('rawOptions.theme is replaced when appearance flips dark→light', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    term = new XTerm({ allowProposedApi: true, theme: { background: '#000000' } })
    term.open(container)
    const initial = (term.options as unknown as { theme: { background?: string } }).theme

    const unsub = subscribeXtermToAppearance(term)
    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })

    const after = (term.options as unknown as { theme: { background?: string } }).theme
    expect(after).toBeDefined()
    expect(after).not.toBe(initial)
    expect(after.background?.toLowerCase()).not.toBe(initial.background?.toLowerCase())
    unsub()
  })

  // Reproduces the user-reported bug: terminals started in one mode keep their
  // original colors after the user toggles to the other mode. xterm's DOM
  // renderer paints the viewport background via the scrollable element's inline
  // backgroundColor — so verifying that style flips proves the rendered output
  // (not just the option object) tracks the theme.
  test('rendered viewport background flips when appearance flips dark→light', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    term = new XTerm({ allowProposedApi: true })
    term.open(container)

    // The scrollable element's backgroundColor is set by xterm's Viewport on
    // every theme change.
    const findScrollable = () => container.querySelector('.xterm-scrollable-element') as HTMLElement | null
    const before = findScrollable()?.style.backgroundColor ?? ''
    expect(before).toBeTruthy()

    const unsub = subscribeXtermToAppearance(term)
    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })

    const after = findScrollable()?.style.backgroundColor ?? ''
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)

    unsub()
  })
})
