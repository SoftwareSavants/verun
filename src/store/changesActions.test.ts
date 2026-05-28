import { describe, test, expect, beforeEach } from 'vitest'
import { gitStates, setGitStates } from './git'
import {
  optimisticStage,
  optimisticUnstage,
  optimisticDiscard,
  optimisticResolve,
} from './changesActions'
import type { FileStatus } from '../types'

const status = (files: FileStatus[]) => ({
  files,
  stats: [],
  totalInsertions: 0,
  totalDeletions: 0,
})

beforeEach(() => {
  setGitStates({ 't1': {
    status: status([]),
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null, checks: [], branchUrl: null, github: null,
    lastLocalRefresh: 0, lastRemoteRefresh: 0,
  } })
})

describe('optimisticStage', () => {
  test('untracked → A staged', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: '?', worktreeStatus: '?', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('A')
    expect(f.worktreeStatus).toBe(' ')
  })

  test('worktree-modified → indexStatus = M, worktreeStatus = " "', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })

  test('MM → keeps indexStatus M, clears worktreeStatus', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'M', worktreeStatus: 'M', conflict: null }]))
    optimisticStage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })
})

describe('optimisticUnstage', () => {
  test('staged-only A → untracked', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'A', worktreeStatus: ' ', conflict: null }]))
    optimisticUnstage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe('?')
    expect(f.worktreeStatus).toBe('?')
  })

  test('staged M → unstaged M', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'M', worktreeStatus: ' ', conflict: null }]))
    optimisticUnstage('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.indexStatus).toBe(' ')
    expect(f.worktreeStatus).toBe('M')
  })
})

describe('optimisticDiscard', () => {
  test('removes the file from the list', () => {
    setGitStates('t1', 'status', status([
      { path: 'a.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null },
      { path: 'b.ts', indexStatus: ' ', worktreeStatus: 'M', conflict: null },
    ]))
    optimisticDiscard('t1', 'a.ts')
    expect(gitStates['t1']!.status!.files.map(f => f.path)).toEqual(['b.ts'])
  })
})

describe('optimisticResolve', () => {
  test('clears conflict, sets indexStatus to M, clears worktreeStatus', () => {
    setGitStates('t1', 'status', status([{ path: 'a.ts', indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }]))
    optimisticResolve('t1', 'a.ts')
    const f = gitStates['t1']!.status!.files[0]
    expect(f.conflict).toBeNull()
    expect(f.indexStatus).toBe('M')
    expect(f.worktreeStatus).toBe(' ')
  })
})
