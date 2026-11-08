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
  createSessionHandoff: vi.fn(),
}))
vi.mock('../lib/lsp', () => ({ getLspClient: vi.fn(() => Promise.resolve()) }))
vi.mock('../lib/newSession', () => ({ openNewSession: vi.fn() }))
// The harness icons are images; the tab is found by its session id.
vi.mock('./SvgIcon', () => ({ default: () => <span data-testid="agent-icon" /> }))
// The rest of the panel is not what this is about, and some of it needs a browser.
vi.mock('./ChatView', () => ({ ChatView: () => null }))
vi.mock('./ClaudeViewToggle', () => ({ ClaudeViewToggle: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
// Open menus render their items as plain buttons, so a test can pick one.
vi.mock('./ContextMenu', () => ({
  ContextMenu: (p: { open: boolean; items: { label?: string; action?: () => void }[] }) =>
    <>{p.open ? p.items.filter(i => i.label).map(i => <button data-menu-item onClick={() => i.action?.()}>{i.label}</button>) : null}</>,
}))
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
import { setAgents } from '../store/agents'
import * as ipc from '../lib/ipc'
import { fireEvent, screen } from '@solidjs/testing-library'
import { setSessions } from '../store/sessions'
import { setTasks } from '../store/tasks'
import { setSelectedTaskId } from '../store/ui'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'
import { makeSession } from '../test/sessionFixtures'
import type { AgentInfo, Session, Task } from '../types'

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
  setAgents([])
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

const agent = (id: AgentInfo['id'], name: string, installed = true) => ({ id, name, installed, models: [] }) as unknown as AgentInfo

describe('<TaskPanel /> session handoff', () => {
  beforeEach(() => {
    setAgents([agent('claude', 'Claude Code'), agent('codex', 'Codex'), agent('gemini', 'Gemini CLI'), agent('cursor', 'Cursor', false)])
  })

  test('right-clicking a session tab offers every other installed harness', async () => {
    const tab = await show([makeSession({ id: 's1', agentType: 'claude' })])
    fireEvent.contextMenu(tab('s1').getByText('Claude Code'))

    const labels = screen.getAllByRole('button').filter(b => b.hasAttribute('data-menu-item')).map(b => b.textContent)
    expect(labels).toContain('Hand off to Codex')
    expect(labels).toContain('Hand off to Gemini CLI')
    expect(labels).not.toContain('Hand off to Claude Code')
    expect(labels).not.toContain('Hand off to Cursor')
  })

  test('picking a harness creates the handoff from that session', async () => {
    vi.mocked(ipc.createSessionHandoff).mockResolvedValue({
      session: makeSession({ id: 's2', agentType: 'codex', parentSessionId: 's1' }),
      draft: 'packet', includedTurns: 0, omittedTurns: 0, transcriptPath: null,
    })
    const tab = await show([makeSession({ id: 's1', agentType: 'claude' })])
    fireEvent.contextMenu(tab('s1').getByText('Claude Code'))
    fireEvent.click(screen.getByText('Hand off to Codex'))

    await waitFor(() => expect(ipc.createSessionHandoff).toHaveBeenCalledWith('s1', 'codex', undefined, undefined))
  })

  test('a handoff session tab names the session it came from', async () => {
    const tab = await show([
      makeSession({ id: 's1', agentType: 'claude', name: 'Original' }),
      makeSession({ id: 's2', agentType: 'codex', parentSessionId: 's1' }),
    ])
    expect(tab('s2').getByTitle('Handed off from Original')).toBeTruthy()
    expect(tab('s1').queryByTitle(/Handed off from/)).toBeNull()
  })

  test('a fork is not marked as a handoff', async () => {
    const tab = await show([
      makeSession({ id: 's1', agentType: 'claude' }),
      makeSession({ id: 's2', agentType: 'claude', parentSessionId: 's1', forkedAtMessageUuid: 'm1' }),
    ])
    expect(tab('s2').queryByTitle(/Handed off from/)).toBeNull()
  })
})
