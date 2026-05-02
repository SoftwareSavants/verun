import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'
import type { GitStatus, BranchCommit, FileStatus } from '../types'

const { watchWorktreeMock, refreshTaskGitMock, gitStageMock, gitUnstageMock, gitDiscardMock, gitCommitMock } = vi.hoisted(() => ({
  watchWorktreeMock: vi.fn(),
  refreshTaskGitMock: vi.fn(),
  gitStageMock: vi.fn().mockResolvedValue(undefined),
  gitUnstageMock: vi.fn().mockResolvedValue(undefined),
  gitDiscardMock: vi.fn().mockResolvedValue(undefined),
  gitCommitMock: vi.fn().mockResolvedValue('hash'),
}))

const [gitState, setGitState] = createStore<Record<string, any>>({})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  watchWorktree: watchWorktreeMock,
  getCommitFiles: vi.fn().mockResolvedValue({ files: [], stats: [], totalInsertions: 0, totalDeletions: 0 }),
  openInApp: vi.fn(),
  openInFinder: vi.fn(),
  gitStage: gitStageMock,
  gitUnstage: gitUnstageMock,
  gitDiscard: gitDiscardMock,
  gitDiscardAllUnstaged: vi.fn().mockResolvedValue(undefined),
  gitUnstageAll: vi.fn().mockResolvedValue(undefined),
  gitResolveConflict: vi.fn().mockResolvedValue(undefined),
  gitCommit: gitCommitMock,
  gitCommitAmend: vi.fn().mockResolvedValue('h'),
  gitCommitAndPush: vi.fn().mockResolvedValue('h'),
  getFileDiff: vi.fn().mockResolvedValue(''),
}))

vi.mock('../store/git', () => ({
  taskGit: (taskId: string) => gitState[taskId] ?? {
    status: null, commits: [], branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null, checks: [], branchUrl: null, github: null,
    lastLocalRefresh: 0, lastRemoteRefresh: 0,
  },
  refreshTaskGit: (...args: unknown[]) => refreshTaskGitMock(...args),
}))

vi.mock('../store/changesActions', () => ({
  stageOne: vi.fn(),
  unstageOne: vi.fn(),
  discardOne: vi.fn(),
  resolveConflict: vi.fn(),
  stageConflictAsIs: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardAllUnstaged: vi.fn(),
  commitWithFallback: vi.fn(),
  commitAndPush: vi.fn(),
  commitAmend: vi.fn(),
}))

vi.mock('../store/ui', () => ({ selectedTaskId: () => 'task-code', addToast: vi.fn() }))
vi.mock('../store/tasks', () => ({ taskById: () => ({ worktreePath: '/tmp/worktree' }) }))
vi.mock('../store/files', () => ({ diffTabKey: () => 'k' }))
vi.mock('../store/editorView', () => ({
  openDiffTab: vi.fn(),
  openFilePinned: vi.fn(),
  revealFileInTree: vi.fn(),
  mainView: () => 'session',
}))
vi.mock('../lib/fileIcons', () => ({ getFileIcon: vi.fn(() => () => null) }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))

import { CodeChanges } from './CodeChanges'

const status = (files: FileStatus[]): GitStatus => ({
  files,
  stats: files.map(f => ({ path: f.path, insertions: 1, deletions: 0 })),
  totalInsertions: files.length,
  totalDeletions: 0,
})

describe('<CodeChanges />', () => {
  beforeEach(() => {
    cleanup()
    watchWorktreeMock.mockClear()
    refreshTaskGitMock.mockReset()
    gitStageMock.mockClear()
    gitUnstageMock.mockClear()
    gitDiscardMock.mockClear()
    setGitState('task-code', {
      status: status([
        { path: 'mm.ts',          indexStatus: 'M', worktreeStatus: 'M', conflict: null },
        { path: 'staged-only.ts', indexStatus: 'A', worktreeStatus: ' ', conflict: null },
        { path: 'untracked.ts',   indexStatus: '?', worktreeStatus: '?', conflict: null },
        { path: 'conflict.ts',    indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' },
      ]),
      commits: [{ hash: 'h1', shortHash: 'h1', message: 'init', author: 'me', timestamp: 1, filesChanged: 1, insertions: 1, deletions: 0 }] as BranchCommit[],
      branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
      pr: null, checks: [], branchUrl: null, github: null,
      lastLocalRefresh: 0, lastRemoteRefresh: 0,
    })
  })

  test('MM file produces both staged and unstaged rows', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    const occurrences = container.textContent?.match(/mm\.ts/g) ?? []
    expect(occurrences.length).toBe(2)
  })

  test('conflict appears under Conflicts section with ! letter', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('Conflicts')
    expect(container.textContent).toContain('conflict.ts')
    expect(container.textContent).toContain('!')
  })

  test('untracked appears in Changes with U letter', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('untracked.ts')
    expect(container.textContent).toContain('U')
  })

  test('header shows segmented counts', () => {
    const { container } = render(() => <CodeChanges taskId="task-code" />)
    expect(container.textContent).toContain('1 conflict')
    expect(container.textContent).toContain('2 staged') // mm.ts staged + staged-only.ts
    expect(container.textContent).toContain('2 changes') // mm.ts unstaged + untracked.ts
  })
})
