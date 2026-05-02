import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as ipc from './ipc'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'

describe('ipc', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  test('all project functions are exported', () => {
    expect(typeof ipc.addProject).toBe('function')
    expect(typeof ipc.listProjects).toBe('function')
    expect(typeof ipc.deleteProject).toBe('function')
  })

  test('all task functions are exported', () => {
    expect(typeof ipc.createTask).toBe('function')
    expect(typeof ipc.listTasks).toBe('function')
    expect(typeof ipc.getTask).toBe('function')
    expect(typeof ipc.deleteTask).toBe('function')
    expect(typeof ipc.archiveTask).toBe('function')
    expect(typeof ipc.checkTaskWorktree).toBe('function')
    expect(typeof ipc.restoreTask).toBe('function')
  })

  test('all session functions are exported', () => {
    expect(typeof ipc.createSession).toBe('function')
    expect(typeof ipc.sendMessage).toBe('function')
    expect(typeof ipc.abortMessage).toBe('function')
    expect(typeof ipc.listSessions).toBe('function')
    expect(typeof ipc.getSession).toBe('function')
    expect(typeof ipc.getOutputLines).toBe('function')
  })

  test('all git/worktree functions are exported', () => {
    expect(typeof ipc.getDiff).toBe('function')
    expect(typeof ipc.mergeBranch).toBe('function')
    expect(typeof ipc.getBranchStatus).toBe('function')
    expect(typeof ipc.getRepoInfo).toBe('function')
  })

  test('consolidated GitHub wrappers are exported', () => {
    expect(typeof ipc.getGithubOverview).toBe('function')
    expect(typeof ipc.getGithubActions).toBe('function')
    expect(typeof ipc.getGithubWorkflowJobs).toBe('function')
    expect(typeof ipc.getGithubWorkflowLog).toBe('function')
  })

  test('utility functions are exported', () => {
    expect(typeof ipc.openInFinder).toBe('function')
  })

  test('blob store wrappers are exported', () => {
    expect(typeof ipc.uploadAttachment).toBe('function')
    expect(typeof ipc.getBlob).toBe('function')
    expect(typeof ipc.getStorageStats).toBe('function')
  })

  describe('askSideQuestion', () => {
    test('forwards camelCase args to ask_side_question and resolves to typed object', async () => {
      vi.mocked(invoke).mockResolvedValueOnce({ response: 'ok', synthetic: false })
      const result = await ipc.askSideQuestion('s1', 'q?')
      expect(invoke).toHaveBeenCalledWith('ask_side_question', { sessionId: 's1', question: 'q?' })
      expect(result).toEqual({ response: 'ok', synthetic: false })
    })

    test('resolves to null when CLI cannot answer', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(null)
      const result = await ipc.askSideQuestion('s1', 'q?')
      expect(result).toBeNull()
    })

    test('rejects when invoke throws', async () => {
      vi.mocked(invoke).mockRejectedValueOnce(new Error('No active session'))
      await expect(ipc.askSideQuestion('s1', 'q?')).rejects.toThrow('No active session')
    })
  })
})
