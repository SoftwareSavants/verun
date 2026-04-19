import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

// Issue #166 — detached task windows mounted TaskWindowShell but never
// hydrated the projects + agents stores, so the new-session menu showed
// "no agents installed" and the Start button showed "set up a start command"
// even when both were configured. The fix: load both stores on mount.

const {
  loadProjectsMock,
  loadAgentsMock,
  loadTasksMock,
  initListenersMock,
  dismissSplashMock,
  initThemeMock,
  initQuitListenerMock,
  installContextMenuMock,
  refreshTaskGitMock,
  showWindowMock,
} = vi.hoisted(() => ({
  loadProjectsMock: vi.fn(() => Promise.resolve()),
  loadAgentsMock: vi.fn(() => Promise.resolve()),
  loadTasksMock: vi.fn(() => Promise.resolve()),
  initListenersMock: vi.fn(() => Promise.resolve()),
  dismissSplashMock: vi.fn(),
  initThemeMock: vi.fn(),
  initQuitListenerMock: vi.fn(),
  installContextMenuMock: vi.fn(),
  refreshTaskGitMock: vi.fn(),
  showWindowMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: showWindowMock,
    close: vi.fn(),
    setTitle: vi.fn(),
  }),
}))

vi.mock('../lib/windowContext', () => ({
  useWindowContext: () => ({ taskId: undefined, projectId: 'p-001', windowLabel: 'task-test', windowType: 'task' }),
}))

vi.mock('../lib/appInit', () => ({
  initListeners: initListenersMock,
  dismissSplash: dismissSplashMock,
  installContextMenu: installContextMenuMock,
  initQuitListener: initQuitListenerMock,
  showQuitConfirm: () => false,
  closeQuitDialog: vi.fn(),
}))

vi.mock('../lib/theme', () => ({ initTheme: initThemeMock }))

vi.mock('../store/git', () => ({ refreshTaskGit: refreshTaskGitMock }))

vi.mock('../store/tasks', () => ({
  loadTasks: loadTasksMock,
  taskById: () => undefined,
}))

vi.mock('../store/projects', () => ({
  loadProjects: loadProjectsMock,
  projectById: () => undefined,
}))

vi.mock('../store/agents', () => ({
  loadAgents: loadAgentsMock,
}))

vi.mock('../store/ui', () => ({
  selectedTaskId: () => null,
  setSelectedTaskId: vi.fn(),
  setSelectedProjectId: vi.fn(),
  showTerminal: () => false,
  setShowTerminal: vi.fn(),
  toggleTerminal: vi.fn(),
  rightPanelTab: () => 'changes',
  setRightPanelTab: vi.fn(),
  setShowQuickOpen: vi.fn(),
}))

vi.mock('../lib/platform', () => ({ modPressed: () => false }))

vi.mock('../store/terminals', () => ({
  spawnTerminal: vi.fn(),
  focusActiveTerminal: vi.fn(),
  terminalsForTask: () => [],
  activeTerminalId: () => null,
  setActiveTerminalForTask: vi.fn(),
  isStartCommandRunning: () => false,
  spawnStartCommand: vi.fn(),
  stopStartCommand: vi.fn(),
}))

vi.mock('../store/editorView', () => ({
  requestCloseTab: vi.fn(),
  reopenClosedTab: vi.fn(),
  nextTab: vi.fn(),
  prevTab: vi.fn(),
  activeTabPath: () => null,
  mainView: () => 'session',
}))

vi.mock('../lib/ipc', () => ({
  getTask: vi.fn(() => Promise.resolve(null)),
  quitApp: vi.fn(),
  forceCloseTaskWindow: vi.fn(),
}))

// Stub the heavy children so we don't drag in editor/xterm modules.
vi.mock('./TaskPanel', () => ({ TaskPanel: () => null }))
vi.mock('./NewTaskDialog', () => ({ NewTaskDialog: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./ToastContainer', () => ({ ToastContainer: () => null }))
vi.mock('./SelectionMenu', () => ({ SelectionMenu: () => null }))

import { TaskWindowShell } from './TaskWindowShell'

describe('TaskWindowShell hydration (issue #166)', () => {
  beforeEach(() => {
    loadProjectsMock.mockClear()
    loadAgentsMock.mockClear()
    loadTasksMock.mockClear()
    initListenersMock.mockClear()
    dismissSplashMock.mockClear()
    cleanup()
  })

  test('loads projects and agents on mount so detached windows have full data', async () => {
    render(() => <TaskWindowShell />)
    // onMount fires synchronously inside render; the awaited Promise.all
    // resolves on the next microtask tick.
    await Promise.resolve()
    await Promise.resolve()
    expect(loadProjectsMock).toHaveBeenCalledTimes(1)
    expect(loadAgentsMock).toHaveBeenCalledTimes(1)
  })

  test('still registers the IPC listeners and loads task data alongside the new hydration', async () => {
    render(() => <TaskWindowShell />)
    await Promise.resolve()
    await Promise.resolve()
    expect(initListenersMock).toHaveBeenCalledTimes(1)
    // ctx.projectId is set in the mock, so loadTasks(projectId) runs too.
    expect(loadTasksMock).toHaveBeenCalledWith('p-001')
  })
})
