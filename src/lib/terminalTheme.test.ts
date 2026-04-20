import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { subscribeXtermToAppearance } from './terminalTheme'
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
