import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import type { AccountSelection, WorkflowRun } from '../types'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const ipcMocks = vi.hoisted(() => ({
  getGithubActions: vi.fn(),
  getGithubWorkflowJobs: vi.fn(),
  getGithubWorkflowLog: vi.fn(),
  rerunWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  createSession: vi.fn(),
}))
vi.mock('../lib/ipc', () => ipcMocks)

vi.mock('../store/tasks', () => ({
  taskById: vi.fn(() => ({
    id: 't1',
    name: 'demo',
    projectId: 'p1',
    worktreePath: '/wt',
    branch: 'feat/x',
    agentType: 'claude',
  })),
}))
vi.mock('../store/sessions', () => ({
  sessionsForTask: vi.fn(() => []),
  sendMessage: vi.fn(),
}))
vi.mock('../store/taskContext', () => ({
  selectedSessionForTask: vi.fn(() => null),
}))
vi.mock('../store/ui', () => ({
  addToast: vi.fn(),
  dismissToast: vi.fn(),
  setSelectedSessionIdForTask: vi.fn(),
  openSettings: vi.fn(),
}))
vi.mock('../store/modelPicker', () => ({
  openModelPicker: vi.fn(),
}))
vi.mock('../store/editorView', () => ({
  setMainView: vi.fn(),
}))

const gitMocks = vi.hoisted(() => ({
  taskGit: vi.fn(() => ({
    status: null,
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null,
    checks: [],
    branchUrl: null,
    github: { owner: 'x', name: 'y', url: 'https://github.com/x/y' },
    lastLocalRefresh: 0,
    lastRemoteRefresh: 0,
  })),
}))
vi.mock('../store/git', () => gitMocks)

const githubDebugMocks = vi.hoisted(() => ({
  githubDebugEntriesForTask: vi.fn(() => [
    {
      id: 1,
      taskId: 't1',
      scope: 'overview',
      stage: 'fetch-success',
      mode: 'network-only',
      cacheState: 'miss',
      fromCache: false,
      durationMs: 42,
      emittedAt: 1_746_000_000_000,
      detail: 'overview refreshed',
    },
  ]),
}))
vi.mock('../store/githubDebug', () => githubDebugMocks)

import { ActionsPanel } from './ActionsPanel'
import { clearActionsState, stopPolling } from '../store/actions'
import { sendMessage, sessionsForTask } from '../store/sessions'
import { selectedSessionForTask } from '../store/taskContext'
import { addToast } from '../store/ui'
import { openModelPicker } from '../store/modelPicker'

function run(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: 1,
    number: 1,
    workflowName: 'CI',
    state: 'success',
    url: 'https://github.com/x/y/actions/runs/1',
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    headSha: 'abc',
    headBranch: 'feat/x',
    event: 'push',
    ...partial,
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

describe('<ActionsPanel /> layout', () => {
  beforeEach(() => {
    cleanup()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    stopPolling('t1')
    clearActionsState('t1')
    ipcMocks.getGithubActions.mockReset()
    ipcMocks.getGithubWorkflowJobs.mockReset()
    ipcMocks.getGithubWorkflowLog.mockReset()
    ipcMocks.rerunWorkflowRun.mockReset()
  })

  test('relative time is rendered after the hover action cluster on both failed and success rows', async () => {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [
        run({ databaseId: 1, state: 'failure', workflowName: 'CI' }),
        run({ databaseId: 2, state: 'success', workflowName: 'Release' }),
      ],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })
    ipcMocks.getGithubWorkflowJobs.mockResolvedValue({
      runId: 1,
      jobs: [],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })

    const { container } = render(() => <ActionsPanel taskId="t1" />)
    await flush()
    await flush()

    // Each run's row button has: workflow name, #num, action cluster, then time.
    // The time span must be the LAST child (far right, stable across row states).
    const rowButtons = container.querySelectorAll('button.group.w-full')
    expect(rowButtons.length).toBe(2)

    for (const btn of rowButtons) {
      const children = Array.from(btn.children)
      const last = children[children.length - 1]
      // Last element must be the time span (has tabular-nums + title attr == createdAt iso)
      expect(last?.getAttribute('title')).toMatch(/T\d{2}:\d{2}:\d{2}/)
    }
  })

  test('clicking a failed job expands an inline panel with logs and action buttons', async () => {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [
        run({ databaseId: 1, state: 'failure', workflowName: 'CI' }),
      ],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })
    ipcMocks.getGithubWorkflowJobs.mockResolvedValue({
      runId: 1,
      jobs: [
        { databaseId: 10, name: 'Type Check', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:12Z', url: 'https://github.com/x/y/runs/10' },
      ],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })
    ipcMocks.getGithubWorkflowLog.mockResolvedValue({
      jobId: 10,
      text: 'error TS2322: Type mismatch at foo.ts:17',
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })

    const { container } = render(() => <ActionsPanel taskId="t1" />)
    await flush()
    await flush()

    // Failed run auto-expands; find the job row button by its label text
    const jobBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('Type Check') && !b.textContent.includes('CI'),
    ) as HTMLElement
    expect(jobBtn).toBeTruthy()

    // Before clicking: no logs panel visible
    expect(container.textContent).not.toContain('error TS2322')

    fireEvent.click(jobBtn)
    await flush()
    await flush()

    // Logs panel appears with the log text
    expect(container.textContent).toContain('error TS2322')
    expect(ipcMocks.getGithubWorkflowLog).toHaveBeenCalledWith('t1', 10)

    // Action buttons are in the expanded panel
    expect(container.querySelector('[title="Re-run this job"]')).not.toBeNull()
    expect(container.querySelector('[title="Fix with Claude"]')).not.toBeNull()
    expect(container.querySelector('[title="Open on GitHub"]')).not.toBeNull()
  })

  test('rerunning a failing run optimistically renders the running (spinner) icon', async () => {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [
        run({ databaseId: 42, state: 'failure', workflowName: 'CI' }),
      ],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })
    ipcMocks.getGithubWorkflowJobs.mockResolvedValue({
      runId: 42,
      jobs: [
        { databaseId: 10, name: 'test', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
      ],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })
    ipcMocks.rerunWorkflowRun.mockResolvedValue(undefined)

    const { container } = render(() => <ActionsPanel taskId="t1" />)
    await flush()
    await flush()

    // Before: no spinning loader in the run row (failure icon is static)
    const rowBtn = container.querySelector('button.group.w-full') as HTMLElement
    expect(rowBtn).toBeTruthy()
    expect(rowBtn.querySelector('.animate-spin')).toBeNull()

    // Click the inline "Re-run failed jobs" action (role=button title="Re-run failed jobs")
    const rerunBtn = rowBtn.querySelector('[title="Re-run failed jobs"]') as HTMLElement
    expect(rerunBtn).toBeTruthy()
    fireEvent.click(rerunBtn)
    await flush()
    await flush()
    await flush()

    // After: the run's StateIcon reflects queued/running (amber, spinning)
    expect(ipcMocks.rerunWorkflowRun).toHaveBeenCalledWith('t1', 42, true)
    // Run row should no longer show the red failure X
    const redIcon = rowBtn.querySelector('.text-red-400')
    expect(redIcon).toBeNull()
  })

  test('dev builds render a GitHub debug panel with recent request activity', async () => {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [run({ databaseId: 1, state: 'success', workflowName: 'CI' })],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })

    const { getByText, container } = render(() => <ActionsPanel taskId="t1" />)
    await flush()

    expect(getByText('GitHub Debug')).toBeTruthy()
    expect(container.textContent).toContain('fetch-success')
    expect(container.textContent).toContain('overview')
    expect(container.textContent).toContain('network-only')
  })

  test('dev builds can copy the full GitHub debug log', async () => {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [run({ databaseId: 1, state: 'success', workflowName: 'CI' })],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })

    const { container } = render(() => <ActionsPanel taskId="t1" />)
    await flush()

    const copyButton = container.querySelector('[title="Copy all debug logs"]') as HTMLButtonElement | null
    expect(copyButton).toBeTruthy()

    await fireEvent.click(copyButton!)

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain('fetch-success')
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain('overview')
  })
})

// "Fix with Claude" sends the failure to a session. Its success toast says the
// session has the failure context, so it must not show when the send was
// blocked by an account problem (sendMessage resolves false after its own toast).
describe('<ActionsPanel /> fixing a failed job with Claude', () => {
  const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'
  const SENT_HERE = 'Sent failure context to session'
  const SENT_NEW = 'Started new session with failure context'

  const toastsOfType = (type: string) => vi.mocked(addToast).mock.calls.filter(call => call[1] === type).map(call => call[0])

  async function renderFailedJob() {
    ipcMocks.getGithubActions.mockResolvedValue({
      runs: [run({ databaseId: 1, state: 'failure', workflowName: 'CI' })],
      fetchedAt: 1, staleAt: 2, expiresAt: 3, isStale: false, fromCache: false,
    })
    ipcMocks.getGithubWorkflowJobs.mockResolvedValue({
      runId: 1,
      jobs: [{ databaseId: 10, name: 'Type Check', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:12Z', url: 'https://github.com/x/y/runs/10' }],
      fetchedAt: 1, staleAt: 2, expiresAt: 3, isStale: false, fromCache: false,
    })
    ipcMocks.getGithubWorkflowLog.mockResolvedValue({
      jobId: 10, text: 'error TS2322: Type mismatch at foo.ts:17',
      fetchedAt: 1, staleAt: 2, expiresAt: 3, isStale: false, fromCache: false,
    })
    const view = render(() => <ActionsPanel taskId="t1" />)
    await flush()
    await flush()
    return view
  }

  async function chooseFix(view: Awaited<ReturnType<typeof renderFailedJob>>, option: 'Fix in this session' | 'Fix in new session') {
    fireEvent.click(view.container.querySelector('[title="Fix with Claude"]') as HTMLElement)
    fireEvent.click(view.getByText(option))
    await flush()
    await flush()
  }

  /** The model picker's callback, for the "new session" path. */
  async function pickModel(account?: AccountSelection) {
    const request = vi.mocked(openModelPicker).mock.calls[0][0]
    await request.onPick('claude', 'opus', account)
    await flush()
  }

  beforeEach(() => {
    cleanup()
    stopPolling('t1')
    clearActionsState('t1')
    vi.mocked(addToast).mockClear()
    vi.mocked(sendMessage).mockReset()
    vi.mocked(openModelPicker).mockClear()
    vi.mocked(sessionsForTask).mockReturnValue([])
    vi.mocked(selectedSessionForTask).mockReturnValue('s1')
    ipcMocks.getGithubActions.mockReset()
    ipcMocks.getGithubWorkflowJobs.mockReset()
    ipcMocks.getGithubWorkflowLog.mockReset()
    ipcMocks.createSession.mockReset()
    ipcMocks.createSession.mockResolvedValue({ id: 'new-session' })
  })

  test('a fix sent to the current session says so', async () => {
    vi.mocked(sendMessage).mockResolvedValue(true)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in this session')

    expect(sendMessage).toHaveBeenCalledWith('s1', expect.stringContaining('Type Check'))
    expect(toastsOfType('success')).toEqual([SENT_HERE])
  })

  test('a fix blocked by an account problem does not say it was sent', async () => {
    vi.mocked(sendMessage).mockResolvedValue(false)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in this session')

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(toastsOfType('success')).toEqual([])
    // sendMessage has shown the account toast; nothing here adds a failure toast.
    expect(toastsOfType('error')).toEqual([])
  })

  test('a fix sent to a new session says so', async () => {
    vi.mocked(sendMessage).mockResolvedValue(true)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel()

    expect(sendMessage).toHaveBeenCalledWith('new-session', expect.stringContaining('Type Check'))
    expect(toastsOfType('success')).toEqual([SENT_NEW])
  })

  test('the picker is for the project of the task', async () => {
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')

    expect(openModelPicker).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })

  // The picker marks "Current" on the group of the session it was opened from,
  // its account too once the harness has accounts.
  test('the picker is told which account the current session runs on', async () => {
    vi.mocked(sessionsForTask).mockReturnValue([{ id: 's1', agentType: 'codex', model: 'gpt-5', accountId: 'c1' } as never])
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')

    expect(openModelPicker).toHaveBeenCalledWith(expect.objectContaining({ defaultAgent: 'codex', defaultModel: 'gpt-5', defaultAccountId: 'c1' }))
  })

  test('a current session on Default is the null account', async () => {
    vi.mocked(sessionsForTask).mockReturnValue([{ id: 's1', agentType: 'claude', model: null, accountId: null } as never])
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')

    expect(vi.mocked(openModelPicker).mock.calls[0][0].defaultAccountId).toBeNull()
  })

  test('without a session no account is named', async () => {
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')

    expect(vi.mocked(openModelPicker).mock.calls[0][0].defaultAccountId).toBeUndefined()
  })

  test('the session is created on the account picked', async () => {
    vi.mocked(sendMessage).mockResolvedValue(true)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel({ kind: 'account', id: 'a1' })

    expect(ipcMocks.createSession).toHaveBeenCalledWith('t1', 'claude', 'opus', { kind: 'account', id: 'a1' })
    expect(sendMessage).toHaveBeenCalledWith('new-session', expect.stringContaining('Type Check'))
  })

  test('without an account picked the project decides', async () => {
    vi.mocked(sendMessage).mockResolvedValue(true)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel()

    expect(ipcMocks.createSession).toHaveBeenCalledWith('t1', 'claude', 'opus', undefined)
  })

  test('a new-session fix blocked by an account problem does not say it was started', async () => {
    vi.mocked(sendMessage).mockResolvedValue(false)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel()

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(toastsOfType('success')).toEqual([])
    expect(toastsOfType('error')).toEqual([])
  })

  test('an account problem creating the session gets the account toast, not "Fix failed" with the raw error', async () => {
    ipcMocks.createSession.mockRejectedValue(removed)
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith('Acme was removed. Start a new session on another account.', 'error', expect.objectContaining({ title: 'Account removed' }))
    expect(toastsOfType('error').some(message => message.includes('ACCOUNT_ERROR') || message.startsWith('Fix failed'))).toBe(false)
  })

  test('other failures still say "Fix failed"', async () => {
    ipcMocks.createSession.mockRejectedValue('Task t1 not found')
    const view = await renderFailedJob()

    await chooseFix(view, 'Fix in new session')
    await pickModel()

    expect(toastsOfType('error')).toEqual(['Fix failed: Task t1 not found'])
  })
})
