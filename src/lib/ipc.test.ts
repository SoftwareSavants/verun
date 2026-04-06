import { describe, test, expect } from 'vitest'
import * as ipc from './ipc'

describe('ipc', () => {
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

  test('utility functions are exported', () => {
    expect(typeof ipc.openInFinder).toBe('function')
  })
})
