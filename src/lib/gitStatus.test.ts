import { describe, test, expect } from 'vitest'
import type { FileStatus } from '../types'
import { fanOut, badgeForEntry, conflictLabel } from './gitStatus'

const f = (over: Partial<FileStatus> = {}): FileStatus => ({
  path: 'x.ts',
  indexStatus: ' ',
  worktreeStatus: ' ',
  conflict: null,
  ...over,
})

describe('fanOut', () => {
  test('untracked produces a single unstaged entry', () => {
    const out = fanOut(f({ indexStatus: '?', worktreeStatus: '?' }))
    expect(out).toEqual([{ kind: 'unstaged', file: expect.any(Object) }])
  })

  test('staged-only produces a single staged entry', () => {
    const out = fanOut(f({ indexStatus: 'A', worktreeStatus: ' ' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('staged')
  })

  test('unstaged-only produces a single unstaged entry', () => {
    const out = fanOut(f({ indexStatus: ' ', worktreeStatus: 'M' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('unstaged')
  })

  test('MM produces both staged and unstaged entries', () => {
    const out = fanOut(f({ indexStatus: 'M', worktreeStatus: 'M' }))
    expect(out).toHaveLength(2)
    expect(out.map(e => e.kind).sort()).toEqual(['staged', 'unstaged'])
  })

  test('conflict produces a single conflict entry', () => {
    const out = fanOut(f({ indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('conflict')
  })
})

describe('badgeForEntry', () => {
  test('staged Added → A emerald', () => {
    const b = badgeForEntry({ kind: 'staged', file: f({ indexStatus: 'A' }) })
    expect(b.letter).toBe('A')
    expect(b.colorClass).toContain('emerald')
    expect(b.label).toBe('Added (staged)')
  })

  test('staged Modified → M amber', () => {
    const b = badgeForEntry({ kind: 'staged', file: f({ indexStatus: 'M' }) })
    expect(b.letter).toBe('M')
    expect(b.colorClass).toContain('amber')
  })

  test('untracked → U emerald', () => {
    const b = badgeForEntry({ kind: 'unstaged', file: f({ indexStatus: '?', worktreeStatus: '?' }) })
    expect(b.letter).toBe('U')
    expect(b.colorClass).toContain('emerald')
  })

  test('unstaged Modified → M amber', () => {
    const b = badgeForEntry({ kind: 'unstaged', file: f({ indexStatus: ' ', worktreeStatus: 'M' }) })
    expect(b.letter).toBe('M')
    expect(b.colorClass).toContain('amber')
  })

  test('conflict → ! red with kind label', () => {
    const b = badgeForEntry({ kind: 'conflict', file: f({ conflict: 'bothModified' }) })
    expect(b.letter).toBe('!')
    expect(b.colorClass).toContain('red')
    expect(b.tooltip).toContain('Both modified')
  })
})

describe('conflictLabel', () => {
  test('all variants have a human-readable label', () => {
    const variants = ['bothModified', 'bothAdded', 'bothDeleted', 'addedByUs', 'addedByThem', 'deletedByUs', 'deletedByThem'] as const
    for (const v of variants) {
      expect(conflictLabel(v)).not.toBe('')
    }
  })
})
