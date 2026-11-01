import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor, within } from '@solidjs/testing-library'

// The tab of a session says which account it runs on: a dot after the agent icon,
// none for a session on Default. TaskPanel is shared by the main window and the
// detached task windows, so this is what both show.
const mocks = vi.hoisted(() => ({ sessions: [] as unknown[] }))

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('../lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ipc')>()),
  listSessions: vi.fn(() => Promise.resolve(mocks.sessions)),
  getOutputLines: vi.fn(() => Promise.resolve([])),
  listSteps: vi.fn(() => Promise.resolve([])),
  prewarmSession: vi.fn(() => Promise.resolve()),
}))
vi.mock('../lib/lsp', () => ({ getLspClient: vi.fn(() => Promise.resolve()) }))
vi.mock('../lib/newSession', () => ({ openNewSession: vi.fn() }))
// The harness icons are images; the tab is found by its session id.
vi.mock('./SvgIcon', () => ({ default: () => <span data-testid="agent-icon" /> }))
// The rest of the panel is not what this is about, and some of it needs a browser.
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
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }))

import { TaskPanel } from './TaskPanel'
import { applySnapshot } from '../store/accounts'
import { setSessions } from '../store/sessions'
import { setTasks } from '../store/tasks'
import { setSelectedTaskId } from '../store/ui'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'
import { makeSession } from '../test/sessionFixtures'
import type { Session, Task } from '../types'

const task: Task = {
  id: 't1', projectId: 'p1', name: 'Task', worktreePath: '/work/t1', branch: 'funny-branch', createdAt: 0, mergeBaseSha: null,
  portOffset: 0, archived: false, archivedAt: null, lastCommitMessage: null, parentTaskId: null, agentType: 'claude',
}

/** Shows the panel of task `t1` with `sessions`, once their tabs are there. Returns a lookup of the tab of a session id. */
async function show(sessions: Session[]) {
  mocks.sessions = sessions
  setTasks([task])
  setSelectedTaskId('t1')
  const { container } = render(() => <TaskPanel />)
  await waitFor(() => expect(container.querySelectorAll('[data-session-id]')).toHaveLength(sessions.length))
  return (sessionId: string) => within(container.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement)
}

beforeEach(() => {
  // The panel scrolls the selected tab into view, by a selector it escapes; jsdom has neither.
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  Element.prototype.scrollIntoView = vi.fn()
  applySnapshot(makeSnapshot({ accounts: [makeAccount()] }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setSessions([])
  setTasks([])
  setSelectedTaskId(null)
})

describe('<TaskPanel /> session tabs', () => {
  test('a session on an account shows its dot after the agent icon', async () => {
    const tab = await show([makeSession({ name: 'Refactor', accountId: 'a1' })])

    const dot = tab('s1').getByTitle('Acme · dev@acme.com')
    expect(dot.style.backgroundColor).toBe('rgb(124, 58, 237)')
    expect(tab('s1').getByTestId('agent-icon').nextElementSibling).toBe(dot)
  })

  test('a session on Default shows no dot, so its tab is as it was', async () => {
    const tab = await show([makeSession({ name: 'Refactor', accountId: null })])

    expect(tab('s1').queryByRole('img')).toBeNull()
    expect(tab('s1').getByText('Refactor')).toBeTruthy()
  })

  test('each tab has the dot of its own account', async () => {
    const other = makeAccount({ id: 'a2', label: 'Beta', color: '#16a34a', identity: makeIdentity({ status: 'signedIn', email: 'me@beta.dev' }) })
    applySnapshot(makeSnapshot({ accounts: [makeAccount(), other] }))

    const tab = await show([
      makeSession({ id: 's1', name: 'First', accountId: 'a2' }),
      makeSession({ id: 's2', name: 'Second', accountId: null }),
      makeSession({ id: 's3', name: 'Third', accountId: 'a1' }),
    ])

    expect(tab('s1').getByRole('img').getAttribute('title')).toBe('Beta · me@beta.dev')
    expect(tab('s2').queryByRole('img')).toBeNull()
    expect(tab('s3').getByRole('img').getAttribute('title')).toBe('Acme · dev@acme.com')
  })
})
