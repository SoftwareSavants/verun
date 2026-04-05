import { describe, test, expect } from 'vitest'
import * as ipc from './ipc'

describe('ipc', () => {
  test('all agent lifecycle functions are exported', () => {
    expect(typeof ipc.spawnAgent).toBe('function')
    expect(typeof ipc.killAgent).toBe('function')
    expect(typeof ipc.restartAgent).toBe('function')
    expect(typeof ipc.listAgents).toBe('function')
  })

  test('all worktree functions are exported', () => {
    expect(typeof ipc.createWorktree).toBe('function')
    expect(typeof ipc.deleteWorktree).toBe('function')
    expect(typeof ipc.listWorktrees).toBe('function')
  })

  test('session and filesystem functions are exported', () => {
    expect(typeof ipc.getSession).toBe('function')
    expect(typeof ipc.openInFinder).toBe('function')
  })

  test('git operation functions are exported', () => {
    expect(typeof ipc.getDiff).toBe('function')
    expect(typeof ipc.mergeBranch).toBe('function')
  })
})
