import { describe, test, expect } from 'vitest'
import { buildPrMessage } from './GitActions'
import type { TaskGitState } from '../store/git'

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
})
