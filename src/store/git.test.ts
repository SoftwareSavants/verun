import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

const eventMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => void>()
  return {
    listeners,
    listen: vi.fn(async (name: string, cb: (event: { payload: any }) => void) => {
      listeners.set(name, cb)
      return () => listeners.delete(name)
    }),
    emit: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/event', () => eventMocks)

const uiMocks = vi.hoisted(() => {
  let selectedTask: string | null = null
  return {
    selectedTaskId: () => selectedTask,
    __setSelectedTaskId: (taskId: string | null) => {
      selectedTask = taskId
    },
  }
})

vi.mock('./ui', () => uiMocks)

vi.mock('../lib/ipc', () => ({
  getGitStatus: vi.fn().mockResolvedValue({ files: [], summary: '' }),
  getBranchCommits: vi.fn().mockResolvedValue([]),
  getBranchStatus: vi.fn().mockResolvedValue([0, 0, 0]),
  checkGithub: vi.fn().mockResolvedValue(null),
  getGithubOverview: vi.fn().mockResolvedValue({
    github: null,
    branchUrl: null,
    pr: null,
    checks: [],
    fetchedAt: 1,
    staleAt: 2,
    expiresAt: 3,
    isStale: false,
    fromCache: false,
  }),
}))

import { clearTaskGitState, initGitListeners, refreshTaskGit, taskGit } from './git'
import * as ipc from '../lib/ipc'

describe('refreshTaskGit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    uiMocks.__setSelectedTaskId(null)
    clearTaskGitState('t-debounce')
    clearTaskGitState('t-force')
    clearTaskGitState('t-local-default')
    clearTaskGitState('t-remote')
    clearTaskGitState('t-a')
    clearTaskGitState('t-b')
    clearTaskGitState('t-github-source')
    vi.mocked(ipc.getGitStatus).mockClear()
    vi.mocked(ipc.getBranchCommits).mockClear()
    vi.mocked(ipc.getBranchStatus).mockClear()
    vi.mocked(ipc.checkGithub).mockClear()
    vi.mocked(ipc.getGithubOverview).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('debounces rapid local refreshes - only one fetch per task after settle', async () => {
    // Fire three rapid refreshes without awaiting
    refreshTaskGit('t-debounce', { local: true, remote: false })
    refreshTaskGit('t-debounce', { local: true, remote: false })
    refreshTaskGit('t-debounce', { local: true, remote: false })

    // Nothing should have fired yet
    expect(ipc.getGitStatus).not.toHaveBeenCalled()

    // Advance past debounce window
    await vi.runAllTimersAsync()

    // Only one actual fetch despite three calls
    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
  })

  test('force refresh bypasses debounce and fires immediately', async () => {
    const p = refreshTaskGit('t-force', { local: true, remote: false, force: true })
    await p

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
  })

  test('default refresh is local-only and does not fetch remote overview', async () => {
    refreshTaskGit('t-local-default')

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.checkGithub).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).not.toHaveBeenCalled()
  })

  test('explicit remote refresh fetches consolidated overview once', async () => {
    const p = refreshTaskGit('t-remote', { local: false, remote: true, force: true })
    await p

    expect(ipc.getGitStatus).not.toHaveBeenCalled()
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).toHaveBeenCalledWith('t-remote', 'network-only')
  })

  test('independent tasks each get their own debounce', async () => {
    refreshTaskGit('t-a', { local: true, remote: false })
    refreshTaskGit('t-b', { local: true, remote: false })

    await vi.runAllTimersAsync()

    // Both tasks fetched, one call each
    expect(ipc.getGitStatus).toHaveBeenCalledTimes(2)
    expect(ipc.getGitStatus).toHaveBeenCalledWith('t-a')
    expect(ipc.getGitStatus).toHaveBeenCalledWith('t-b')
  })

  test('remote refresh does not overwrite github repo set by local detection', async () => {
    vi.mocked(ipc.checkGithub).mockResolvedValueOnce({
      owner: 'local',
      name: 'repo',
      url: 'https://github.com/local/repo',
    })
    vi.mocked(ipc.getGithubOverview).mockResolvedValueOnce({
      github: {
        owner: 'remote',
        name: 'repo',
        url: 'https://github.com/remote/repo',
      },
      branchUrl: null,
      pr: null,
      checks: [],
      fetchedAt: 1,
      staleAt: 2,
      expiresAt: 3,
      isStale: false,
      fromCache: false,
    })

    await refreshTaskGit('t-github-source', { local: true, remote: false, force: true })
    await refreshTaskGit('t-github-source', { local: false, remote: true, force: true })

    expect(taskGit('t-github-source').github).toEqual({
      owner: 'local',
      name: 'repo',
      url: 'https://github.com/local/repo',
    })
  })

  test('git-local-changed with remoteLikelyChanged refreshes remote overview for tracked tasks', async () => {
    await refreshTaskGit('t-remote', { local: false, remote: true, force: true })
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(1)

    await initGitListeners()
    eventMocks.listeners.get('git-local-changed')?.({ payload: { taskId: 't-remote', remoteLikelyChanged: true } })

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(2)
  })

  test('git-local-changed without remoteLikelyChanged stays local-only', async () => {
    await refreshTaskGit('t-remote', { local: false, remote: true, force: true })
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(1)

    await initGitListeners()
    eventMocks.listeners.get('git-local-changed')?.({ payload: { taskId: 't-remote' } })

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(1)
  })

  test('git-local-changed with remoteLikelyChanged refreshes remote overview for the selected task even before remote tracking', async () => {
    uiMocks.__setSelectedTaskId('t-selected')

    await initGitListeners()
    eventMocks.listeners.get('git-local-changed')?.({ payload: { taskId: 't-selected', remoteLikelyChanged: true } })

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).toHaveBeenCalledWith('t-selected', 'network-only')
  })

  test('file-tree-changed refreshes local git state without remote overview', async () => {
    await initGitListeners()
    eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId: 't-file-edit', path: 'src' } })

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.getGitStatus).toHaveBeenCalledWith('t-file-edit')
    expect(ipc.getGithubOverview).not.toHaveBeenCalled()
  })

  test('file-tree-changed bursts debounce into one local git refresh', async () => {
    await initGitListeners()
    eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId: 't-file-edit', path: 'src' } })
    eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId: 't-file-edit', path: 'src/components' } })
    eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId: 't-file-edit', path: 'src/store' } })

    await vi.runAllTimersAsync()

    expect(ipc.getGitStatus).toHaveBeenCalledTimes(1)
    expect(ipc.getGithubOverview).not.toHaveBeenCalled()
  })
})
