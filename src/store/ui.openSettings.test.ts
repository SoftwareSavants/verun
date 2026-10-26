import { describe, test, expect, beforeEach, vi } from 'vitest'

// A detached task window has no Settings page: only the main window renders it.
// Opening Settings from there (an account toast's "Log in") has to reach the
// main window, or the button does nothing.
const emit = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/api/event', () => ({ emit, listen: vi.fn() }))
vi.mock('../lib/windowContext', () => ({
  isTaskWindow: true,
  registerWindowedTaskChecker: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ openTaskWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { openSettings, showSettings, settingsSectionRequest, setShowSettings, setSettingsSectionRequest, OPEN_SETTINGS_EVENT } from './ui'

describe('openSettings in a task window', () => {
  beforeEach(() => {
    emit.mockClear()
    setShowSettings(false)
    setSettingsSectionRequest(null)
  })

  test('asks the main window to open Settings on the section', () => {
    openSettings('accounts')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(OPEN_SETTINGS_EVENT, { section: 'accounts' })
    // Nothing is opened here: there is no page in this window to show it.
    expect(showSettings()).toBe(false)
    expect(settingsSectionRequest()).toBeNull()
  })

  test('asks without a section too', () => {
    openSettings()
    expect(emit).toHaveBeenCalledWith(OPEN_SETTINGS_EVENT, { section: null })
  })

  test('the event is the one the main window listens for', () => {
    expect(OPEN_SETTINGS_EVENT).toBe('open-settings')
  })
})
