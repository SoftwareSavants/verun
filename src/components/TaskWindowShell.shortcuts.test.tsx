import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

// Issue #243 — Cmd+T (new session) didn't fire in detached task windows
// because TaskWindowShell never registered the handler. Layout.tsx had it
// for the main window but the detached shell did not. The model picker also
// needs to mount in the detached window so the request can actually surface.

const {
  openModelPickerMock,
  createSessionMock,
  setSelectedSessionIdForTaskMock,
  setMainViewMock,
  modelPickerRequestMock,
} = vi.hoisted(() => ({
  openModelPickerMock: vi.fn(),
  createSessionMock: vi.fn(() => Promise.resolve({ id: 'new-session-id' })),
  setSelectedSessionIdForTaskMock: vi.fn(),
  setMainViewMock: vi.fn(),
  modelPickerRequestMock: vi.fn(() => null),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: vi.fn(),
    close: vi.fn(),
    setTitle: vi.fn(),
  }),
}))

vi.mock('../lib/windowContext', () => ({
  useWindowContext: () => ({ taskId: 't-001', projectId: undefined, windowLabel: 'task-test', windowType: 'task' }),
}))

vi.mock('../lib/appInit', () => ({
  initListeners: vi.fn(() => Promise.resolve()),
  dismissSplash: vi.fn(),
  installContextMenu: vi.fn(),
  initQuitListener: vi.fn(),
  showQuitConfirm: () => false,
  closeQuitDialog: vi.fn(),
}))

vi.mock('../lib/theme', () => ({ initTheme: vi.fn() }))
vi.mock('../store/git', () => ({ refreshTaskGit: vi.fn() }))
vi.mock('../store/tasks', () => ({
  loadTasks: vi.fn(() => Promise.resolve()),
  taskById: () => ({ id: 't-001', agentType: 'claude', projectId: 'p-001' }),
}))
vi.mock('../store/projects', () => ({
  loadProjects: vi.fn(() => Promise.resolve()),
  projectById: () => undefined,
}))
vi.mock('../store/agents', () => ({ loadAgents: vi.fn(() => Promise.resolve()) }))

vi.mock('../store/ui', () => ({
  selectedTaskId: () => 't-001',
  setSelectedTaskId: vi.fn(),
  setSelectedProjectId: vi.fn(),
  showTerminal: () => false,
  setShowTerminal: vi.fn(),
  toggleTerminal: vi.fn(),
  rightPanelTab: () => 'changes',
  setRightPanelTab: vi.fn(),
  setShowQuickOpen: vi.fn(),
  setFocusSearchRequest: vi.fn(),
  setSelectedSessionIdForTask: setSelectedSessionIdForTaskMock,
}))

vi.mock('../lib/platform', () => ({
  modPressed: (e: KeyboardEvent) => e.metaKey || e.ctrlKey,
}))

vi.mock('../store/terminals', () => ({
  spawnTerminal: vi.fn(),
  focusActiveTerminal: vi.fn(),
  terminalsForTask: () => [],
  activeTerminalId: () => null,
  setActiveTerminalForTask: vi.fn(),
  isStartCommandRunning: () => false,
  spawnStartCommand: vi.fn(),
  stopStartCommand: vi.fn(),
  hydrateTerminalsForTask: vi.fn(),
}))

vi.mock('../store/editorView', () => ({
  requestCloseTab: vi.fn(),
  reopenClosedTab: vi.fn(),
  nextTab: vi.fn(),
  prevTab: vi.fn(),
  activeTabPath: () => null,
  mainView: () => 'session',
  setMainView: setMainViewMock,
}))

vi.mock('../store/modelPicker', () => ({
  modelPickerRequest: modelPickerRequestMock,
  openModelPicker: openModelPickerMock,
  closeModelPicker: vi.fn(),
}))

vi.mock('../store/sessions', () => ({
  createSession: createSessionMock,
  sessionsForTask: () => [{ id: 's-1', agentType: 'claude', model: 'opus-4-5' }],
}))

vi.mock('../store/taskContext', () => ({
  selectedSessionForTask: () => 's-1',
}))

vi.mock('../lib/ipc', () => ({
  getTask: vi.fn(() => Promise.resolve(null)),
  quitApp: vi.fn(),
  forceCloseTaskWindow: vi.fn(),
}))

vi.mock('../store/fileSync', () => ({
  activeConflict: () => ({ taskId: 't-001', relativePath: 'src/a.ts', diskContent: 'a', verunContent: 'b' }),
  dismissConflict: vi.fn(),
  resolveConflictDiscard: vi.fn(),
  resolveConflictOverwrite: vi.fn(),
}))

vi.mock('./TaskPanel', () => ({ TaskPanel: () => null }))
vi.mock('./NewTaskDialog', () => ({ NewTaskDialog: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./ToastContainer', () => ({ ToastContainer: () => null }))
vi.mock('./SelectionMenu', () => ({ SelectionMenu: () => null }))
vi.mock('./ModelPicker', () => ({ ModelPicker: (props: { open: boolean }) => (
  <div data-testid="model-picker" data-open={String(props.open)} />
) }))
vi.mock('./FileConflictDialog', () => ({ FileConflictDialog: () => (
  <div data-testid="file-conflict-dialog" />
) }))

import { TaskWindowShell } from './TaskWindowShell'

describe('TaskWindowShell keyboard shortcuts (issue #243)', () => {
  beforeEach(() => {
    openModelPickerMock.mockClear()
    createSessionMock.mockClear()
    setSelectedSessionIdForTaskMock.mockClear()
    setMainViewMock.mockClear()
    modelPickerRequestMock.mockReturnValue(null)
    cleanup()
  })

  test('Cmd+T opens model picker for new session on the active task', async () => {
    render(() => <TaskWindowShell />)
    await Promise.resolve()

    const ev = new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)

    expect(openModelPickerMock).toHaveBeenCalledTimes(1)
    const arg = openModelPickerMock.mock.calls[0][0]
    expect(arg.title).toBe('New session')
    expect(arg.defaultAgent).toBe('claude')
  })

  test('Cmd+Shift+T does NOT open model picker (it reopens closed tab)', async () => {
    render(() => <TaskWindowShell />)
    await Promise.resolve()

    const ev = new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)

    expect(openModelPickerMock).not.toHaveBeenCalled()
  })

  test('renders ModelPicker component so the picker can surface in detached windows', async () => {
    const { findByTestId } = render(() => <TaskWindowShell />)
    await Promise.resolve()

    const picker = await findByTestId('model-picker')
    expect(picker).toBeTruthy()
  })

  // Save-time disk-divergence checks live in the detached window's editor
  // too, so the conflict dialog must mount here or saves fail silently.
  test('renders FileConflictDialog so save-time disk conflicts can be resolved', async () => {
    const { findByTestId } = render(() => <TaskWindowShell />)
    await Promise.resolve()

    const dialog = await findByTestId('file-conflict-dialog')
    expect(dialog).toBeTruthy()
  })
})
