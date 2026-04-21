import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'
import { createSignal } from 'solid-js'
import type { GitStatus, BranchCommit } from '../types'

const { watchWorktreeMock, refreshTaskGitMock } = vi.hoisted(() => ({
  watchWorktreeMock: vi.fn(),
  refreshTaskGitMock: vi.fn(),
}))

const [gitState, setGitState] = createStore<Record<string, any>>({})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  watchWorktree: watchWorktreeMock,
  getCommitFiles: vi.fn().mockResolvedValue({ files: [] }),
  openInApp: vi.fn(),
  openInFinder: vi.fn(),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  stageAll: vi.fn(),
  createCommit: vi.fn(),
  discardFile: vi.fn(),
  getFileDiff: vi.fn().mockResolvedValue(''),
}))

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

vi.mock('../store/files', () => ({
  diffTabKey: vi.fn(),
}))

vi.mock('../store/editorView', () => ({
  openDiffTab: vi.fn(),
  openFilePinned: vi.fn(),
  revealFileInTree: vi.fn(),
  mainView: () => 'session',
}))

vi.mock('../lib/fileIcons', () => ({
  getFileIcon: vi.fn(() => () => null),
}))

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}))

import { CodeChanges } from './CodeChanges'

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
    watchWorktreeMock.mockClear()
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

  test('calls watchWorktree on mount', () => {
    render(() => <CodeChanges taskId="task-code" />)
    expect(watchWorktreeMock).toHaveBeenCalledWith('task-code')
  })

  test('calls watchWorktree when taskId changes', async () => {
    const [taskId, setTaskId] = createSignal('task-code')
    render(() => <CodeChanges taskId={taskId()} />)

    watchWorktreeMock.mockClear()
    setGitState('task-code-2', {
      status: null,
      commits: [],
      branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
      pr: null,
      checks: [],
      branchUrl: null,
      github: null,
      lastLocalRefresh: 0,
      lastRemoteRefresh: 0,
    })
    setTaskId('task-code-2')

    expect(watchWorktreeMock).toHaveBeenCalledWith('task-code-2')
  })
})
