import { describe, test, expect, beforeEach, vi } from 'vitest'

// appInit wires every store into the window. These tests cover the accounts
// part of that wiring; the stores themselves are stubbed.
const mocks = vi.hoisted(() => {
  const ok = () => vi.fn(() => Promise.resolve())
  return {
    initAccountListeners: ok(),
    loadAccounts: ok(),
    openSettings: vi.fn(),
    show: ok(),
    setFocus: ok(),
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
  getCurrentWindow: () => ({ show: mocks.show, setFocus: mocks.setFocus }),
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
  mocks.show.mockClear()
  mocks.setFocus.mockClear()
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
    handler!({ payload: { section: 'accounts' } })

    expect(mocks.openSettings).toHaveBeenCalledWith('accounts')
    await vi.waitFor(() => expect(mocks.setFocus).toHaveBeenCalledTimes(1))
    expect(mocks.show).toHaveBeenCalledTimes(1)
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
