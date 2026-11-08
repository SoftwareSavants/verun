import { describe, test, expect, beforeEach, vi } from 'vitest'

const eventMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>()
  return {
    listeners,
    listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(name, cb)
      return () => listeners.delete(name)
    }),
  }
})
vi.mock('@tauri-apps/api/event', () => ({ listen: eventMocks.listen, emit: vi.fn() }))
vi.mock('../lib/ipc', () => ({
  watchWorktree: vi.fn(() => Promise.resolve()),
  unwatchWorktree: vi.fn(() => Promise.resolve()),
}))
vi.mock('./git', () => ({ refreshTaskGit: vi.fn(() => Promise.resolve()) }))
vi.mock('./sessions', () => ({
  sessionById: (id: string) => ({ id, taskId: id.replace('s-', 't-') }),
}))

import * as ipc from '../lib/ipc'
import { refreshTaskGit } from './git'
import { syncWatchedWorktrees, isWorktreeWatched } from './worktreeWatch'

beforeEach(() => {
  syncWatchedWorktrees([])
  vi.clearAllMocks()
})

describe('worktree watching', () => {
  test('watches only the given tasks and unwatches the ones that left', () => {
    syncWatchedWorktrees(['t-a'])
    expect(ipc.watchWorktree).toHaveBeenCalledWith('t-a')

    syncWatchedWorktrees(['t-b', 't-win'])
    expect(ipc.unwatchWorktree).toHaveBeenCalledWith('t-a')
    expect(ipc.watchWorktree).toHaveBeenCalledWith('t-b')
    expect(ipc.watchWorktree).toHaveBeenCalledWith('t-win')
    expect(isWorktreeWatched('t-a')).toBe(false)
    expect(isWorktreeWatched('t-b')).toBe(true)

    // Unchanged set: no IPC churn.
    vi.clearAllMocks()
    syncWatchedWorktrees(['t-win', 't-b'])
    expect(ipc.watchWorktree).not.toHaveBeenCalled()
    expect(ipc.unwatchWorktree).not.toHaveBeenCalled()
  })

  test('an unwatched task refreshes git when a session turn ends', async () => {
    syncWatchedWorktrees(['t-a'])
    await Promise.resolve()
    const onStatus = eventMocks.listeners.get('session-status')!
    expect(onStatus).toBeTruthy()

    onStatus({ payload: { sessionId: 's-other', status: 'idle' } })
    expect(refreshTaskGit).toHaveBeenCalledWith('t-other')

    // Watched tasks are kept fresh by the watcher; running is not a turn end.
    vi.mocked(refreshTaskGit).mockClear()
    onStatus({ payload: { sessionId: 's-a', status: 'idle' } })
    onStatus({ payload: { sessionId: 's-other', status: 'running' } })
    expect(refreshTaskGit).not.toHaveBeenCalled()
  })
})
