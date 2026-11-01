import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import capability from '../../src-tauri/capabilities/default.json'

// appInit wires every store into the window. These tests cover the accounts
// part of that wiring; the stores themselves are stubbed.
const mocks = vi.hoisted(() => {
  const ok = () => vi.fn(() => Promise.resolve())
  // The window calls in the order they were made.
  const windowCalls: string[] = []
  const windowCall = (name: string) => vi.fn(() => { windowCalls.push(name); return Promise.resolve() })
  return {
    initAccountListeners: ok(),
    loadAccounts: ok(),
    openSettings: vi.fn(),
    unminimize: windowCall('unminimize'),
    show: windowCall('show'),
    setFocus: windowCall('setFocus'),
    windowCalls,
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    // Read when initListeners runs, so a test can make this a task window.
    window: { isMainWindow: true },
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ unminimize: mocks.unminimize, show: mocks.show, setFocus: mocks.setFocus }),
}))
vi.mock('@choochmeque/tauri-plugin-notifications-api', () => ({ onNotificationClicked: vi.fn() }))
vi.mock('./notifications', () => ({ consumePendingNav: vi.fn(), clearDeliveredNotifications: vi.fn() }))
vi.mock('./windowContext', () => ({
  windowContext: { windowLabel: 'main' },
  get isMainWindow() { return mocks.window.isMainWindow },
}))
vi.mock('./ipc', () => ({ reloadEnvPath: vi.fn(() => Promise.resolve()), listProjects: vi.fn(() => Promise.resolve([])), listAvailableAgents: vi.fn(() => Promise.resolve([])) }))

vi.mock('../store/accounts', () => ({ initAccountListeners: mocks.initAccountListeners, loadAccounts: mocks.loadAccounts }))
vi.mock('../store/ui', () => ({
  addToast: vi.fn(),
  setSelectedTaskId: vi.fn(),
  setSelectedProjectId: vi.fn(),
  setPendingSessionNav: vi.fn(),
  openSettings: mocks.openSettings,
  OPEN_SETTINGS_EVENT: 'open-settings',
}))

// The other stores, which this file has no opinion about.
vi.mock('../store/activity', () => ({ initActivityListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/projects', () => ({ loadProjects: vi.fn(() => Promise.resolve()), initProjectListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/agents', () => ({ loadAgents: vi.fn(() => Promise.resolve()), initAgentListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/sessions', () => ({
  initSessionListeners: vi.fn(() => Promise.resolve()),
  initSessionWindowFocusRefresh: vi.fn(),
  syncSessionStatuses: vi.fn(() => Promise.resolve()),
  loadSessions: vi.fn(() => Promise.resolve()),
}))
vi.mock('../store/terminals', () => ({ initTerminalListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/git', () => ({ initGitListeners: vi.fn(() => Promise.resolve()), initWindowFocusRefresh: vi.fn(), refreshTaskGit: vi.fn() }))
vi.mock('../store/githubDebug', () => ({ initGitHubDebugListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/actions', () => ({ initActionsListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/fileSync', () => ({ initOpenFilesRefresh: vi.fn() }))
vi.mock('../store/setup', () => ({ initSetupListeners: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/resource-monitor', () => ({ initResourceMonitor: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/problems', () => ({ initProblemsListener: vi.fn() }))
vi.mock('../store/tasks', () => ({ loadTasks: vi.fn(() => Promise.resolve()), taskById: vi.fn() }))

import { initListeners, loadInitialData } from './appInit'

beforeEach(() => {
  mocks.initAccountListeners.mockClear()
  mocks.loadAccounts.mockClear()
  mocks.openSettings.mockClear()
  mocks.unminimize.mockClear()
  mocks.show.mockClear()
  mocks.setFocus.mockClear()
  mocks.windowCalls.length = 0
  mocks.listeners.clear()
  mocks.window.isMainWindow = true
})

describe('accounts in every window', () => {
  test('initListeners registers the accounts-changed listener and waits for it', async () => {
    let registered = false
    mocks.initAccountListeners.mockImplementationOnce(() => new Promise<void>(resolve => setTimeout(() => { registered = true; resolve() }, 5)))

    await initListeners()

    expect(mocks.initAccountListeners).toHaveBeenCalledTimes(1)
    expect(registered).toBe(true)
  })

  test('loadInitialData loads the accounts', async () => {
    await loadInitialData()
    expect(mocks.loadAccounts).toHaveBeenCalledTimes(1)
  })
})

describe('open-settings', () => {
  test('the main window opens Settings on the section a task window asked for, and comes forward', async () => {
    await initListeners()

    const handler = mocks.listeners.get('open-settings')
    expect(handler).toBeDefined()
    await handler!({ payload: { section: 'accounts' } })

    expect(mocks.openSettings).toHaveBeenCalledWith('accounts')
    // Unminimize and show first: setFocus alone is unreliable on macOS when the
    // window is minimized or behind another app (open_task_window does the same).
    expect(mocks.windowCalls).toEqual(['unminimize', 'show', 'setFocus'])
  })

  describe('when a window call fails', () => {
    let error: ReturnType<typeof vi.spyOn>
    beforeEach(() => { error = vi.spyOn(console, 'error').mockImplementation(() => {}) })
    afterEach(() => error.mockRestore())

    // Each call is independent: a refused unminimize (a window that is not
    // minimized, a missing permission) must not keep the window from being shown.
    test.each(['unminimize', 'show', 'setFocus'] as const)('%s failing is logged, and the others still run', async (name) => {
      mocks[name].mockImplementationOnce(() => {
        mocks.windowCalls.push(name)
        return Promise.reject(new Error('not allowed'))
      })
      await initListeners()

      await mocks.listeners.get('open-settings')!({ payload: { section: 'accounts' } })

      expect(mocks.windowCalls).toEqual(['unminimize', 'show', 'setFocus'])
      expect(error).toHaveBeenCalledOnce()
      expect(String(error.mock.calls[0])).toContain(name)
      // Settings is open whatever happened to the window.
      expect(mocks.openSettings).toHaveBeenCalledWith('accounts')
    })
  })

  test('a request without a section opens Settings where it was', async () => {
    await initListeners()

    mocks.listeners.get('open-settings')!({ payload: { section: null } })

    expect(mocks.openSettings).toHaveBeenCalledWith(undefined)
  })

  test('a task window does not listen: it has no Settings to open', async () => {
    mocks.window.isMainWindow = false

    await initListeners()

    expect(mocks.listeners.has('open-settings')).toBe(false)
  })
})

// A window call the capability does not grant is refused at runtime and nowhere
// else, so the build and the other tests pass without it. These are the calls
// that bring a window to the front.
describe('the window capability', () => {
  test('grants every call that brings a window forward', () => {
    expect(capability.windows).toEqual(expect.arrayContaining(['main', 'task-*']))
    expect(capability.permissions).toEqual(expect.arrayContaining([
      'core:window:allow-unminimize',
      'core:window:allow-show',
      'core:window:allow-set-focus',
    ]))
  })
})
