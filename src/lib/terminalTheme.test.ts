import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getXtermTheme, subscribeXtermToAppearance } from './terminalTheme'
import { applyAppearance, DEFAULT_PREFS } from './theme'

// Minimal xterm stub - records option writes and refresh/clearTextureAtlas calls.
function makeStubTerm() {
  const calls: string[] = []
  const term = {
    options: {} as Record<string, unknown>,
    cols: 80,
    rows: 24,
    refresh: vi.fn((start: number, end: number) => calls.push(`refresh(${start},${end})`)),
    clearTextureAtlas: vi.fn(() => calls.push('clearTextureAtlas')),
  }
  // Trap option writes so we can assert order.
  term.options = new Proxy({} as Record<string, unknown>, {
    set(t, k, v) {
      calls.push(`set ${String(k)}`)
      t[k as string] = v
      return true
    },
    get(t, k) {
      return t[k as string]
    },
  })
  return { term, calls }
}

describe('subscribeXtermToAppearance', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('on appearance change, clears the texture atlas and refreshes the visible buffer', () => {
    const { term, calls } = makeStubTerm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeXtermToAppearance(term as any)

    applyAppearance({ ...DEFAULT_PREFS, codeFontSize: 17 })

    // The renderer cache (WebGL atlas) must be invalidated, otherwise font/theme
    // changes don't visibly repaint.
    expect(term.clearTextureAtlas).toHaveBeenCalledTimes(1)
    // And the visible buffer must be redrawn so changes are immediate.
    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1)
    // Options were applied before the cache was cleared.
    const setFontIdx = calls.indexOf('set fontSize')
    const clearIdx = calls.indexOf('clearTextureAtlas')
    expect(setFontIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeGreaterThan(setFontIdx)

    unsub()
  })

  test('theme background flips when mode switches between dark and light', () => {
    const { term } = makeStubTerm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeXtermToAppearance(term as any)

    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    const darkTheme = (term.options as Record<string, unknown>).theme as { background: string }

    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })
    const lightTheme = (term.options as Record<string, unknown>).theme as { background: string }

    expect(darkTheme.background).toBeDefined()
    expect(lightTheme.background).toBeDefined()
    // The whole point of switching modes: the visible terminal canvas color must change.
    expect(lightTheme.background.toLowerCase()).not.toBe(darkTheme.background.toLowerCase())

    unsub()
  })

  test('getXtermTheme reads the resolved CSS surface for the current mode', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    const darkBg = getXtermTheme().background
    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })
    const lightBg = getXtermTheme().background
    expect(darkBg).toBeDefined()
    expect(lightBg).toBeDefined()
    expect(lightBg!.toLowerCase()).not.toBe(darkBg!.toLowerCase())
  })

  // Repro for the user-reported bug: terminals started in dark mode kept
  // painting their original palette after switching to light. xterm v6's
  // WebGL renderer caches its atlas + cell model across `term.options.theme`
  // assignments, so the canonical fix is to dispose-and-reload the renderer.
  // The subscriber must call `reloadRenderer` between option writes and the
  // post-fit refresh — and only after the new theme is on the term, so the
  // fresh renderer activates against it.
  test('invokes reloadRenderer after theme is set, before refresh', () => {
    const { term, calls } = makeStubTerm()
    const reloadRenderer = vi.fn(() => calls.push('reloadRenderer'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeXtermToAppearance(term as any, undefined, reloadRenderer)

    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })

    expect(reloadRenderer).toHaveBeenCalledTimes(1)
    const themeIdx = calls.indexOf('set theme')
    const reloadIdx = calls.indexOf('reloadRenderer')
    const refreshIdx = calls.findIndex(c => c.startsWith('refresh('))
    expect(themeIdx).toBeGreaterThanOrEqual(0)
    expect(reloadIdx).toBeGreaterThan(themeIdx)
    expect(refreshIdx).toBeGreaterThan(reloadIdx)

    unsub()
  })

  test('reloadRenderer is optional — DOM-only callers still work', () => {
    const { term } = makeStubTerm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeXtermToAppearance(term as any)
    expect(() => applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })).not.toThrow()
    expect(term.refresh).toHaveBeenCalled()
    unsub()
  })

  test('unsub stops further updates', () => {
    const { term } = makeStubTerm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = subscribeXtermToAppearance(term as any)
    unsub()

    applyAppearance({ ...DEFAULT_PREFS, codeFontSize: 19 })

    expect(term.refresh).not.toHaveBeenCalled()
    expect(term.clearTextureAtlas).not.toHaveBeenCalled()
  })
})
