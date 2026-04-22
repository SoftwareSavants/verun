import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { buildPrMessage } from './GitActions'
import type { TaskGitState } from '../store/git'

// ---------------------------------------------------------------------------
// Mocks for component render tests
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('../lib/ipc', () => ({
  watchWorktree: vi.fn(),
  gitPush: vi.fn(),
  mergePullRequest: vi.fn(),
  markPrReady: vi.fn(),
}))
vi.mock('../lib/dismissable', () => ({ registerDismissable: vi.fn(() => () => {}) }))
vi.mock('../store/sessions', () => ({ sessionById: vi.fn(() => null), sendMessage: vi.fn() }))
vi.mock('../store/tasks', () => ({
  taskById: vi.fn(() => ({ id: 't-001', name: 'task', projectId: 'p-001', worktreePath: '/wt' })),
  archiveTask: vi.fn(),
}))
vi.mock('../store/projects', () => ({
  projectById: vi.fn(() => ({ id: 'p-001', repoPath: '/repo', baseBranch: 'main' })),
}))
vi.mock('../store/commands', () => ({ hasSkill: vi.fn(() => false), primeSkills: vi.fn() }))
vi.mock('../store/ui', () => ({ addToast: vi.fn() }))

const { taskGitMock, refreshTaskGitMock, invalidateRemoteMock } = vi.hoisted(() => ({
  taskGitMock: vi.fn(),
  refreshTaskGitMock: vi.fn(),
  invalidateRemoteMock: vi.fn(),
}))
vi.mock('../store/git', () => ({
  taskGit: taskGitMock,
  refreshTaskGit: refreshTaskGitMock,
  invalidateRemote: invalidateRemoteMock,
}))

function makeGitState(pr: TaskGitState['pr'] = null, overrides: Partial<TaskGitState> = {}): TaskGitState {
  return {
    status: { files: [], stats: [], totalInsertions: 0, totalDeletions: 0 },
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr,
    checks: [],
    branchUrl: null,
    github: null,
    lastLocalRefresh: Date.now(),
    lastRemoteRefresh: Date.now(),
    ...overrides,
  }
}

import { GitActions } from './GitActions'

function makeGit(overrides: Partial<TaskGitState> = {}): TaskGitState {
  return {
    status: null,
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null,
    checks: [],
    branchUrl: null,
    github: null,
    lastLocalRefresh: 0,
    lastRemoteRefresh: 0,
    ...overrides,
  }
}

describe('closed PR treated as no PR', () => {
  beforeEach(() => { cleanup() })

  test('shows Create PR button when PR is closed and tree is clean', () => {
    taskGitMock.mockReturnValue(makeGitState({
      number: 42, title: 'old PR', state: 'CLOSED', url: 'https://github.com/x', isDraft: false,
      mergeable: 'MERGEABLE', body: '',
    }))
    const { getByText } = render(() => <GitActions taskId="t-001" sessionId="s-001" />)
    expect(getByText('Create PR')).toBeTruthy()
  })
})

describe('buildPrMessage', () => {
  test('clean tree with commits - no commit preamble', () => {
    const git = makeGit({
      commits: [
        { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add foo', author: 'A', timestamp: 0, filesChanged: 1, insertions: 5, deletions: 0 },
      ],
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).not.toContain('commit all changes')
    expect(msg).toContain('create a pull request targeting main')
    expect(msg).toContain('abc1234')
    expect(msg).toContain('feat: add foo')
  })

  test('dirty tree - tells claude to commit first and lists files', () => {
    const git = makeGit({
      status: {
        files: [
          { path: 'src/foo.ts', status: 'M', staging: 'unstaged', oldPath: undefined },
          { path: 'src/bar.ts', status: 'A', staging: 'staged', oldPath: undefined },
        ],
        stats: [],
        totalInsertions: 10,
        totalDeletions: 2,
      },
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).toContain('commit all changes')
    expect(msg).toContain('src/foo.ts')
    expect(msg).toContain('src/bar.ts')
    expect(msg).toContain('create a pull request targeting main')
  })

  test('draft flag produces draft PR message', () => {
    const git = makeGit()
    const msg = buildPrMessage(git, 'main', true)
    expect(msg).toContain('draft pull request')
  })

  test('base branch is injected correctly', () => {
    const git = makeGit()
    const msg = buildPrMessage(git, 'develop', false)
    expect(msg).toContain('targeting develop')
  })

  test('does not ask claude to discover state it already has', () => {
    const git = makeGit({
      status: { files: [], stats: [], totalInsertions: 0, totalDeletions: 0 },
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).not.toContain('if there are any uncommitted changes')
    expect(msg).not.toContain('check')
  })

  test('unpushed commits with clean tree - tells claude to push first', () => {
    const git = makeGit({
      branchStatus: { ahead: 2, behind: 0, unpushed: 2 },
      commits: [
        { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add foo', author: 'A', timestamp: 0, filesChanged: 1, insertions: 5, deletions: 0 },
      ],
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).toContain('push to remote')
    expect(msg).not.toContain('commit all changes')
    expect(msg).toContain('create a pull request targeting main')
  })

  test('dirty tree - tells claude to commit and push', () => {
    const git = makeGit({
      status: {
        files: [{ path: 'src/foo.ts', status: 'M', staging: 'unstaged', oldPath: undefined }],
        stats: [],
        totalInsertions: 5,
        totalDeletions: 1,
      },
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).toContain('commit all changes')
    expect(msg).toContain('push to remote')
  })

  test('all pushed and clean tree - no push instruction', () => {
    const git = makeGit({
      branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
      commits: [
        { hash: 'abc1234', shortHash: 'abc1234', message: 'feat: add foo', author: 'A', timestamp: 0, filesChanged: 1, insertions: 5, deletions: 0 },
      ],
    })
    const msg = buildPrMessage(git, 'main', false)
    expect(msg).not.toContain('push to remote')
  })
})
