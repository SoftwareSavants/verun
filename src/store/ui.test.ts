import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/ipc', () => ({
  openTaskWindow: vi.fn(),
}))

const openDialogMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
}))

import {
  newTaskProjectId,
  setNewTaskProjectId,
  requestNewTaskForProject,
  focusOrSelectTask,
  markTaskWindowed,
  selectedTaskId,
  setSelectedTaskId,
  selectedProjectId,
  setSelectedProjectId,
  addProjectPath,
  setAddProjectPath,
  pickAndAddProject,
  setSelectedSessionIdForTask,
  siblingTaskInList,
} from './ui'
import { selectedSessionForTask, clearTaskContext } from './taskContext'
import * as ipc from '../lib/ipc'

describe('new-task dialog signal', () => {
  beforeEach(() => {
    setNewTaskProjectId(null)
  })

  test('newTaskProjectId starts null', () => {
    expect(newTaskProjectId()).toBeNull()
  })

  test('requestNewTaskForProject sets newTaskProjectId so the dialog opens', () => {
    requestNewTaskForProject('p-001')
    expect(newTaskProjectId()).toBe('p-001')
  })
})

describe('focusOrSelectTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSelectedTaskId(null)
    setSelectedProjectId(null)
    // Reset windowed state
    markTaskWindowed('t-001', false)
    markTaskWindowed('t-002', false)
  })

  test('focuses existing window when task is already windowed', () => {
    markTaskWindowed('t-001', true)
    focusOrSelectTask({ id: 't-001', projectId: 'p-001', name: 'my-task' })
    expect(ipc.openTaskWindow).toHaveBeenCalledWith('t-001', 'my-task')
    expect(selectedTaskId()).toBeNull()
    expect(selectedProjectId()).toBeNull()
  })

  test('passes undefined for taskName when task has no name', () => {
    markTaskWindowed('t-001', true)
    focusOrSelectTask({ id: 't-001', projectId: 'p-001', name: null })
    expect(ipc.openTaskWindow).toHaveBeenCalledWith('t-001', undefined)
  })

  test('selects task in main view when not windowed', () => {
    focusOrSelectTask({ id: 't-002', projectId: 'p-002', name: null })
    expect(ipc.openTaskWindow).not.toHaveBeenCalled()
    expect(selectedTaskId()).toBe('t-002')
    expect(selectedProjectId()).toBe('p-002')
  })
})

describe('setSelectedSessionIdForTask', () => {
  beforeEach(() => {
    localStorage.clear()
    clearTaskContext('t-A')
    clearTaskContext('t-B')
    setSelectedTaskId(null)
  })

  test('writes to the explicitly passed task, ignoring currently-selected task', () => {
    // User is on task A, but an async effect for task B fires setSelectedSessionIdForTask.
    // Regression for cross-task session leak: setSelectedSessionId used to read the
    // current selectedTaskId at call time, so a late-completing effect would clobber
    // whichever task the user had switched to.
    setSelectedTaskId('t-A')
    setSelectedSessionIdForTask('t-B', 's-B1')

    expect(selectedSessionForTask('t-B')).toBe('s-B1')
    expect(selectedSessionForTask('t-A')).toBeNull()
  })

  test('persists to per-task lastSession storage', () => {
    setSelectedSessionIdForTask('t-A', 's-A1')
    expect(localStorage.getItem('verun:lastSession:t-A')).toBe('s-A1')
  })
})

describe('siblingTaskInList', () => {
  const tasks = [
    { id: 't-a' },
    { id: 't-b' },
    { id: 't-c' },
  ]

  test('returns null for empty list', () => {
    expect(siblingTaskInList([], null, 'down')).toBeNull()
    expect(siblingTaskInList([], 't-a', 'up')).toBeNull()
  })

  test('down with no selection picks first', () => {
    expect(siblingTaskInList(tasks, null, 'down')?.id).toBe('t-a')
  })

  test('up with no selection picks last', () => {
    expect(siblingTaskInList(tasks, null, 'up')?.id).toBe('t-c')
  })

  test('down moves to next', () => {
    expect(siblingTaskInList(tasks, 't-a', 'down')?.id).toBe('t-b')
    expect(siblingTaskInList(tasks, 't-b', 'down')?.id).toBe('t-c')
  })

  test('up moves to previous', () => {
    expect(siblingTaskInList(tasks, 't-c', 'up')?.id).toBe('t-b')
    expect(siblingTaskInList(tasks, 't-b', 'up')?.id).toBe('t-a')
  })

  test('wraps from last to first when going down', () => {
    expect(siblingTaskInList(tasks, 't-c', 'down')?.id).toBe('t-a')
  })

  test('wraps from first to last when going up', () => {
    expect(siblingTaskInList(tasks, 't-a', 'up')?.id).toBe('t-c')
  })

  test('falls back to first/last when current id is not in list', () => {
    expect(siblingTaskInList(tasks, 'gone', 'down')?.id).toBe('t-a')
    expect(siblingTaskInList(tasks, 'gone', 'up')?.id).toBe('t-c')
  })
})

describe('pickAndAddProject', () => {
  beforeEach(() => {
    openDialogMock.mockReset()
    setAddProjectPath(null)
  })

  test('sets addProjectPath with the picked directory so AddProjectDialog opens', async () => {
    openDialogMock.mockResolvedValueOnce('/tmp/my-repo')
    await pickAndAddProject()
    expect(openDialogMock).toHaveBeenCalledWith({ directory: true, multiple: false })
    expect(addProjectPath()).toBe('/tmp/my-repo')
  })

  test('does nothing when the user cancels the native picker', async () => {
    openDialogMock.mockResolvedValueOnce(null)
    await pickAndAddProject()
    expect(addProjectPath()).toBeNull()
  })
})
