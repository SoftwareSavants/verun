import { beforeEach, describe, expect, test } from 'vitest'
import { setTasks } from './tasks'
import { clearRecentFilesForProject, recentFilesForProject, recordRecentFileOpen, removeRecentFile } from './recentFiles'
import type { Task } from '../types'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  projectId: 'project-1',
  name: null,
  worktreePath: '/tmp/project-1',
  branch: 'main',
  createdAt: 1000,
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

describe('recentFiles store', () => {
  beforeEach(() => {
    localStorage.clear()
    setTasks([])
    clearRecentFilesForProject('project-1')
    clearRecentFilesForProject('project-2')
  })

  test('records recent files by project using task context', () => {
    setTasks([makeTask()])

    recordRecentFileOpen('task-1', 'src/App.tsx')
    recordRecentFileOpen('task-1', '.env')

    expect(recentFilesForProject('project-1')).toEqual(['.env', 'src/App.tsx'])
  })

  test('moves an existing path to the front instead of duplicating it', () => {
    setTasks([makeTask()])

    recordRecentFileOpen('task-1', 'src/App.tsx')
    recordRecentFileOpen('task-1', 'src/components/QuickOpen.tsx')
    recordRecentFileOpen('task-1', 'src/App.tsx')

    expect(recentFilesForProject('project-1')).toEqual(['src/App.tsx', 'src/components/QuickOpen.tsx'])
  })

  test('removes a recent file without affecting other project entries', () => {
    setTasks([
      makeTask(),
      makeTask({ id: 'task-2', projectId: 'project-2', worktreePath: '/tmp/project-2' }),
    ])

    recordRecentFileOpen('task-1', '.env')
    recordRecentFileOpen('task-2', 'src/main.ts')
    removeRecentFile('project-1', '.env')

    expect(recentFilesForProject('project-1')).toEqual([])
    expect(recentFilesForProject('project-2')).toEqual(['src/main.ts'])
  })
})
