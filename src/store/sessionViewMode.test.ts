import { beforeEach, describe, expect, test, vi } from 'vitest'

describe('sessionViewMode store', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  async function fresh() {
    return import('./sessionViewMode')
  }

  test('defaults to ui when nothing is persisted', async () => {
    const m = await fresh()
    expect(m.claudeDefaultViewMode()).toBe('ui')
    expect(m.sessionViewMode('s1')).toBe('ui')
  })

  test('setClaudeDefaultViewMode writes to localStorage and updates the signal', async () => {
    const m = await fresh()
    m.setClaudeDefaultViewMode('terminal')
    expect(m.claudeDefaultViewMode()).toBe('terminal')
    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('terminal')
  })

  test('sessionViewMode falls back to app default for sessions without overrides', async () => {
    localStorage.setItem('verun:claudeDefaultViewMode', 'terminal')
    const m = await fresh()
    expect(m.sessionViewMode('s-new')).toBe('terminal')
    expect(m.hasSessionViewModeOverride('s-new')).toBe(false)
  })

  test('setSessionViewMode stores an override visible to subsequent reads', async () => {
    const m = await fresh()
    m.setSessionViewMode('s1', 'terminal')
    expect(m.sessionViewMode('s1')).toBe('terminal')
    expect(m.hasSessionViewModeOverride('s1')).toBe(true)
    expect(localStorage.getItem('verun:claudeViewMode:s1')).toBe('terminal')
  })

  test('setSessionViewMode(null) clears the override and falls back to default', async () => {
    localStorage.setItem('verun:claudeDefaultViewMode', 'terminal')
    const m = await fresh()
    m.setSessionViewMode('s1', 'ui')
    expect(m.sessionViewMode('s1')).toBe('ui')
    m.setSessionViewMode('s1', null)
    expect(m.sessionViewMode('s1')).toBe('terminal')
    expect(m.hasSessionViewModeOverride('s1')).toBe(false)
    expect(localStorage.getItem('verun:claudeViewMode:s1')).toBeNull()
  })

  test('sessionViewMode returns default for null/undefined session id without crashing', async () => {
    const m = await fresh()
    expect(m.sessionViewMode(null)).toBe('ui')
    expect(m.sessionViewMode(undefined)).toBe('ui')
  })
})
