import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { Task, Session } from '../types'

// Bug #135 — the task-created event handler calls loadTasks, which reads
// from the DB before the async write queue has applied InsertTask. That
// empty read wipes the placeholder out of the store. When ipc.createTask's
// .then() later runs, it must still deposit the real task or the sidebar
// loses it until the next refresh.

let createTaskResolve: ((v: { task: Task; session: Session }) => void) | null = null
let listTasksResult: Task[] = []
let archiveTaskResolve: (() => void) | null = null
let archiveTaskReject: ((e: Error) => void) | null = null

vi.mock('../lib/ipc', () => ({
  createTask: vi.fn(() => new Promise<{ task: Task; session: Session }>((resolve) => {
    createTaskResolve = resolve
  })),
  listTasks: vi.fn(() => Promise.resolve(listTasksResult)),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  archiveTask: vi.fn(() => new Promise<void>((resolve, reject) => {
    archiveTaskResolve = resolve
    archiveTaskReject = reject
  })),
  restoreTask: vi.fn().mockResolvedValue(undefined),
  renameTask: vi.fn().mockResolvedValue(undefined),
}))

import { tasks, setTasks, startTaskCreation, loadTasks, archiveTask } from './tasks'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-real',
  projectId: 'project-1',
  name: null,
  worktreePath: '/tmp/worktree',
  branch: 'spooky-armadillo',
  createdAt: 1000,
  mergeBaseSha: null,
  portOffset: 0,
  archived: false,
  archivedAt: null,
  lastCommitMessage: null,
  parentTaskId: null,
  agentType: 'claude',
  ...overrides,
})

const makeSession = (): Session => ({
  id: 'session-1',
  taskId: 'task-real',
  name: null,
  resumeSessionId: null,
  status: 'idle',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  parentSessionId: null,
  forkedAtMessageUuid: null,
  agentType: 'claude',
  model: null,
})

describe('archiveTask', () => {
  beforeEach(() => {
    setTasks([])
    archiveTaskResolve = null
    archiveTaskReject = null
    vi.clearAllMocks()
  })

  test('marks the task archived in the store before the IPC resolves (issue #138)', async () => {
    setTasks([makeTask({ id: 'task-real', archived: false })])

    const promise = archiveTask('task-real')
    // The IPC has not resolved yet; the optimistic update should already
    // have flipped the task to archived so the sidebar reflects it instantly.
    expect(tasks[0].archived).toBe(true)

    archiveTaskResolve!()
    await promise
    expect(tasks[0].archived).toBe(true)
  })

  test('reverts archived flag if the IPC rejects', async () => {
    setTasks([makeTask({ id: 'task-real', archived: false })])

    const promise = archiveTask('task-real')
    expect(tasks[0].archived).toBe(true)

    archiveTaskReject!(new Error('boom'))
    await expect(promise).rejects.toThrow('boom')
    expect(tasks[0].archived).toBe(false)
  })
})

describe('startTaskCreation', () => {
  beforeEach(() => {
    setTasks([])
    createTaskResolve = null
    listTasksResult = []
    vi.clearAllMocks()
  })

  test('preserves the new task when loadTasks races before the IPC response (issue #135)', async () => {
    // Kick off creation — placeholder lands in the store immediately
    startTaskCreation('project-1', 'main')
    expect(tasks.length).toBe(1)
    expect(tasks[0].branch).toBe('setting up…')

    // Simulate the task-created event handler running in the same window:
    // loadTasks reads from the DB before the async write queue has applied
    // InsertTask, so the returned list is stale (empty). This wipes the
    // placeholder out of the store.
    listTasksResult = []
    await loadTasks('project-1')
    expect(tasks.length).toBe(0)

    // Now the IPC response arrives with the real task. The .then() handler
    // must still land the task in the store, otherwise the sidebar shows
    // nothing until the next refresh.
    const real = makeTask()
    createTaskResolve!({ task: real, session: makeSession() })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tasks.length).toBe(1)
    expect(tasks[0].id).toBe('task-real')
  })
})
