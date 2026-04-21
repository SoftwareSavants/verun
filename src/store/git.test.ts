import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  getGitStatus: vi.fn().mockResolvedValue({ files: [], summary: '' }),
  getBranchCommits: vi.fn().mockResolvedValue([]),
  getBranchStatus: vi.fn().mockResolvedValue([0, 0, 0]),
  getPullRequest: vi.fn().mockResolvedValue(null),
  getBranchUrl: vi.fn().mockResolvedValue(null),
  checkGithub: vi.fn().mockResolvedValue(null),
  getCiChecks: vi.fn().mockResolvedValue([]),
}))

import { refreshTaskGit } from './git'
import * as ipc from '../lib/ipc'

describe('refreshTaskGit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(ipc.getGitStatus).mockClear()
    vi.mocked(ipc.getBranchCommits).mockClear()
    vi.mocked(ipc.getBranchStatus).mockClear()
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

  test('independent tasks each get their own debounce', async () => {
    refreshTaskGit('t-a', { local: true, remote: false })
    refreshTaskGit('t-b', { local: true, remote: false })

    await vi.runAllTimersAsync()

    // Both tasks fetched, one call each
    expect(ipc.getGitStatus).toHaveBeenCalledTimes(2)
    expect(ipc.getGitStatus).toHaveBeenCalledWith('t-a')
    expect(ipc.getGitStatus).toHaveBeenCalledWith('t-b')
  })
})
