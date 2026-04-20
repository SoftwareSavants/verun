import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'
import { CodeChanges } from './CodeChanges'
import type { GitStatus, BranchCommit } from '../types'

const refreshTaskGitMock = vi.fn()
const [gitState, setGitState] = createStore<Record<string, any>>({})

vi.mock('../store/git', () => ({
  taskGit: (taskId: string) => gitState[taskId] ?? {
    status: null,
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null,
    checks: [],
    branchUrl: null,
    github: null,
    lastLocalRefresh: 0,
    lastRemoteRefresh: 0,
  },
  refreshTaskGit: (...args: unknown[]) => refreshTaskGitMock(...args),
}))

vi.mock('../store/ui', () => ({
  selectedTaskId: () => 'task-code',
}))

vi.mock('../store/tasks', () => ({
  taskById: () => ({ worktreePath: '/tmp/worktree' }),
}))

vi.mock('../store/editorView', () => ({
  openDiffTab: vi.fn(),
  openFilePinned: vi.fn(),
  revealFileInTree: vi.fn(),
  mainView: () => 'session',
}))

vi.mock('../lib/ipc', () => ({
  getCommitFiles: vi.fn(),
  openInApp: vi.fn(),
  openInFinder: vi.fn(),
}))

function makeStatus(count: number): GitStatus {
  return {
    files: Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      status: 'M',
      staging: 'unstaged',
    })),
    stats: Array.from({ length: count }, (_, i) => ({
      path: `src/file-${i}.ts`,
      insertions: i,
      deletions: 0,
    })),
    totalInsertions: count,
    totalDeletions: 0,
  }
}

function makeCommits(count: number): BranchCommit[] {
  return Array.from({ length: count }, (_, i) => ({
    hash: `hash-${i}`,
    shortHash: `h${i}`,
    message: `commit ${i}`,
    author: 'Tester',
    timestamp: 1_700_000_000 - i,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  }))
}

describe('<CodeChanges />', () => {
  beforeEach(() => {
    cleanup()
    refreshTaskGitMock.mockReset()
    setGitState('task-code', {
      status: makeStatus(1000),
      commits: makeCommits(1000),
      branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
      pr: null,
      checks: [],
      branchUrl: null,
      github: null,
      lastLocalRefresh: 0,
      lastRemoteRefresh: 0,
    })
    localStorage.setItem('verun:commitsOpen', 'true')
  })

  test('does not mount every changed file or commit row for large git state', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)

    expect(container.textContent).toContain('src/file-0.ts')
    expect(container.textContent).not.toContain('src/file-999.ts')
    expect(container.textContent).toContain('commit 0')
    expect(container.textContent).not.toContain('commit 999')
  })
})
