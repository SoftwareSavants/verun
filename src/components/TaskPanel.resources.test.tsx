import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@solidjs/testing-library'

// Switching tasks must not start heavy per-task resources the user hasn't asked
// for: no tsgo LSP on selection, no xterm + shell until the terminal panel is
// opened for that task.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('../lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ipc')>()),
  listSessions: vi.fn(() => Promise.resolve([])),
  getOutputLines: vi.fn(() => Promise.resolve([])),
  listSteps: vi.fn(() => Promise.resolve([])),
  prewarmSession: vi.fn(() => Promise.resolve()),
}))
vi.mock('../lib/lsp', () => ({ getLspClient: vi.fn(() => Promise.resolve()) }))
vi.mock('../lib/newSession', () => ({ openNewSession: vi.fn() }))
vi.mock('./SvgIcon', () => ({ default: () => null }))
vi.mock('./ChatView', () => ({ ChatView: () => null }))
vi.mock('./ClaudeViewToggle', () => ({ ClaudeViewToggle: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))
vi.mock('./FileViewer', () => ({ FileViewer: () => null }))
vi.mock('./GitActions', () => ({ GitActions: () => null, hasGitActionsContent: () => false }))
vi.mock('./MessageInput', () => ({ MessageInput: () => null }))
vi.mock('./NewSessionMenu', () => ({ NewSessionMenu: () => null }))
vi.mock('./QuickOpen', () => ({ QuickOpen: () => null }))
vi.mock('./RightPanel', () => ({ RightPanel: () => null }))
vi.mock('./SessionTerminal', () => ({ SessionTerminal: () => null }))
vi.mock('./SettingsPage', () => ({ selectSettingsSection: vi.fn() }))
vi.mock('./SideQuestionPanel', () => ({ SideQuestionPanel: () => null }))
vi.mock('./StepList', () => ({ StepList: () => null }))
vi.mock('./TerminalPanel', () => ({
  TerminalPanel: (p: { taskId: string }) => <div data-testid="terminal-panel" data-task={p.taskId} />,
}))

import { TaskPanel } from './TaskPanel'
import { getLspClient } from '../lib/lsp'
import { setTasks } from '../store/tasks'
import { setSelectedTaskId, setShowTerminal } from '../store/ui'
import type { Task } from '../types'

const makeTask = (id: string): Task => ({
  id, projectId: 'p1', name: id, worktreePath: `/work/${id}`, branch: 'b', createdAt: 0, mergeBaseSha: null,
  portOffset: 0, archived: false, archivedAt: null, lastCommitMessage: null, parentTaskId: null, agentType: 'claude',
})

beforeEach(() => {
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(getLspClient).mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setTasks([])
  setSelectedTaskId(null)
})

const settle = () => new Promise(r => setTimeout(r, 20))

describe('<TaskPanel /> resource lifecycle', () => {
  test('selecting a task does not start its language server', async () => {
    setTasks([makeTask('r1')])
    setSelectedTaskId('r1')
    render(() => <TaskPanel />)
    await settle()
    expect(getLspClient).not.toHaveBeenCalled()
  })

  test('the terminal panel mounts only once it is opened for the task', async () => {
    setTasks([makeTask('r2'), makeTask('r3')])
    setSelectedTaskId('r2')
    setShowTerminal(false)
    const { queryByTestId } = render(() => <TaskPanel />)
    await settle()
    expect(queryByTestId('terminal-panel')).toBeNull()

    setShowTerminal(true)
    await waitFor(() => expect(queryByTestId('terminal-panel')).not.toBeNull())

    // Hiding keeps it mounted (xterm state preserved)...
    setShowTerminal(false)
    await settle()
    expect(queryByTestId('terminal-panel')).not.toBeNull()

    // ...but a task whose terminal was never opened gets none.
    setSelectedTaskId('r3')
    setShowTerminal(false)
    await settle()
    expect(queryByTestId('terminal-panel')).toBeNull()

    setSelectedTaskId('r2')
    await settle()
    expect(queryByTestId('terminal-panel')?.getAttribute('data-task')).toBe('r2')
  })
})
