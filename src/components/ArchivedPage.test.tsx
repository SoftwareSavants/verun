import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import type { Task } from '../types'

// Restoring an archived task runs the project's setup hook again, on the
// project's accounts. The page says "Task restored" only when it was; a restore
// the account stopped has already shown its toast, and the task is still here.
const mocks = vi.hoisted(() => ({
  restoreTask: vi.fn(),
  checkTaskWorktree: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({ checkTaskWorktree: mocks.checkTaskWorktree }))
vi.mock('../store/projects', () => ({
  projects: [{ id: 'p-001', name: 'my-app' }],
  projectById: () => ({ id: 'p-001', name: 'my-app' }),
}))

const archived: Task = {
  id: 't-001',
  projectId: 'p-001',
  name: 'Old work',
  worktreePath: '/tmp/wt',
  branch: 'old-work',
  createdAt: 1000,
  mergeBaseSha: null,
  portOffset: 0,
  archived: true,
  archivedAt: 2000,
  lastCommitMessage: null,
  parentTaskId: null,
  agentType: 'claude',
}
vi.mock('../store/tasks', () => ({
  archivedTasksForProject: () => [archived],
  restoreTask: mocks.restoreTask,
}))

import { ArchivedPage } from './ArchivedPage'
import { toasts, setToasts } from '../store/ui'

const shown = () => toasts().map(t => `${t.type}: ${t.message}`)

async function restore() {
  fireEvent.click(screen.getByTitle('Restore task'))
  await waitFor(() => expect(mocks.restoreTask).toHaveBeenCalledOnce())
  // Let what follows the restore run.
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.restoreTask.mockReset()
  mocks.checkTaskWorktree.mockReset()
  mocks.checkTaskWorktree.mockResolvedValue([true, true])
  setToasts([])
})

afterEach(() => cleanup())

describe('ArchivedPage restore', () => {
  test('says the task was restored once it was', async () => {
    mocks.restoreTask.mockResolvedValue(true)
    render(() => <ArchivedPage />)

    await restore()

    expect(mocks.restoreTask).toHaveBeenCalledWith('t-001')
    expect(shown()).toEqual(['success: Task restored'])
  })

  test('does not say so when the account stopped the restore', async () => {
    // restoreTask resolves false after raising the account toast itself.
    mocks.restoreTask.mockResolvedValue(false)
    render(() => <ArchivedPage />)

    await restore()

    expect(shown()).toEqual([])
    // Still listed, and can be restored again.
    expect(screen.getByText('Old work')).toBeTruthy()
    expect((screen.getByTitle('Restore task') as HTMLButtonElement).closest('tr')!.className).not.toContain('opacity-50')
  })

  test('asks about the folder before restoring, and restores nothing when it is gone', async () => {
    mocks.checkTaskWorktree.mockResolvedValue([false, true])
    render(() => <ArchivedPage />)

    fireEvent.click(screen.getByTitle('Restore task'))
    await waitFor(() => expect(mocks.checkTaskWorktree).toHaveBeenCalledWith('t-001'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.restoreTask).not.toHaveBeenCalled()
    expect(shown()).toEqual([])
  })
})
