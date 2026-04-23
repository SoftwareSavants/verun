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
} from './ui'
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
