import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { Task } from '../types'

vi.mock('../lib/ipc', () => ({}))

import {
  setTasks,
  pinnedTasksForProject,
  unpinnedActiveTasksForProject,
  activeTasksForProject,
} from './tasks'

const makeTask = (overrides: Partial<Task>): Task => ({
  id: 'id',
  projectId: 'p1',
  name: null,
  worktreePath: '/tmp/wt',
  branch: 'b',
  createdAt: 0,
  mergeBaseSha: null,
  portOffset: 0,
  archived: false,
  archivedAt: null,
  lastCommitMessage: null,
  parentTaskId: null,
  agentType: 'claude',
  isPinned: false,
  ...overrides,
})

describe('tasks pinned selectors (#61)', () => {
  beforeEach(() => setTasks([]))

  test('pinnedTasksForProject returns only pinned, non-archived tasks for the project', () => {
    setTasks([
      makeTask({ id: 'main', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'trunk', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'regular', projectId: 'p1', isPinned: false }),
      makeTask({ id: 'archived-pin', projectId: 'p1', isPinned: true, archived: true }),
      makeTask({ id: 'other-proj', projectId: 'p2', isPinned: true }),
    ])

    const ids = pinnedTasksForProject('p1').map((t) => t.id)
    expect(ids).toEqual(['main', 'trunk'])
  })

  test('unpinnedActiveTasksForProject excludes pinned and archived tasks', () => {
    setTasks([
      makeTask({ id: 'main', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'task-a', projectId: 'p1', isPinned: false }),
      makeTask({ id: 'task-b', projectId: 'p1', isPinned: false, archived: true }),
    ])

    const ids = unpinnedActiveTasksForProject('p1').map((t) => t.id)
    expect(ids).toEqual(['task-a'])
  })

  test('pinned + unpinned selectors partition the same set as activeTasksForProject', () => {
    setTasks([
      makeTask({ id: 'main', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'task-a', projectId: 'p1', isPinned: false }),
      makeTask({ id: 'task-b', projectId: 'p1', isPinned: false }),
    ])

    const active = activeTasksForProject('p1').map((t) => t.id).sort()
    const combined = [
      ...pinnedTasksForProject('p1').map((t) => t.id),
      ...unpinnedActiveTasksForProject('p1').map((t) => t.id),
    ].sort()
    expect(combined).toEqual(active)
  })

  test('empty project returns empty arrays from both selectors', () => {
    setTasks([])
    expect(pinnedTasksForProject('p1')).toEqual([])
    expect(unpinnedActiveTasksForProject('p1')).toEqual([])
  })

  test('pinnedTasksForProject is scoped to projectId (multi-project isolation)', () => {
    setTasks([
      makeTask({ id: 'main-p1', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'main-p2', projectId: 'p2', isPinned: true }),
      makeTask({ id: 'main-p3', projectId: 'p3', isPinned: true }),
    ])
    expect(pinnedTasksForProject('p2').map((t) => t.id)).toEqual(['main-p2'])
  })

  test('archived pinned task is excluded from pinnedTasksForProject', () => {
    setTasks([
      makeTask({ id: 'live', projectId: 'p1', isPinned: true, archived: false }),
      makeTask({ id: 'dead', projectId: 'p1', isPinned: true, archived: true }),
    ])
    expect(pinnedTasksForProject('p1').map((t) => t.id)).toEqual(['live'])
  })

  test('unpinnedActiveTasksForProject excludes pinned even when non-archived', () => {
    setTasks([
      makeTask({ id: 'main', projectId: 'p1', isPinned: true }),
      makeTask({ id: 'regular', projectId: 'p1', isPinned: false }),
    ])
    expect(unpinnedActiveTasksForProject('p1').map((t) => t.id)).toEqual([
      'regular',
    ])
  })
})

// ---------------------------------------------------------------------------
// Main pinned detection — identified by worktree_path === project.repo_path.
// The Sidebar's context menu and TaskPanel's header badge both branch on this
// property; protect the rule with explicit tests so it survives refactors.
// ---------------------------------------------------------------------------

function isMainPinned(
  task: { worktreePath: string; isPinned: boolean },
  project: { repoPath: string },
): boolean {
  return task.isPinned && task.worktreePath === project.repoPath
}

describe('isMainPinned detection', () => {
  test('true when pinned and worktreePath equals repoPath', () => {
    expect(
      isMainPinned(
        { worktreePath: '/repo', isPinned: true },
        { repoPath: '/repo' },
      ),
    ).toBe(true)
  })

  test('false for a pinned branch task (different worktree)', () => {
    expect(
      isMainPinned(
        { worktreePath: '/repo/.verun/worktrees/trunk', isPinned: true },
        { repoPath: '/repo' },
      ),
    ).toBe(false)
  })

  test('false for a non-pinned task even if paths match', () => {
    expect(
      isMainPinned(
        { worktreePath: '/repo', isPinned: false },
        { repoPath: '/repo' },
      ),
    ).toBe(false)
  })
})
