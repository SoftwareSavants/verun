import { beforeEach, expect, test, vi } from 'vitest'

const quick = { id: 'quick-tasks', name: 'Quick tasks', repoPath: '/Users/me', baseBranch: '', setupHook: '', destroyHook: '', startCommand: '', autoStart: false, createdAt: 1, defaultAgentType: 'claude' }
vi.mock('../lib/ipc', () => ({ ensureQuickProject: vi.fn(() => Promise.resolve(quick)) }))
vi.mock('./ui', () => ({ requestNewTaskForProject: vi.fn() }))

import { openQuickTask, isQuickProject } from './quickTasks'
import { projects, setProjects } from './projects'
import { requestNewTaskForProject } from './ui'

beforeEach(() => setProjects([]))

test('opens the composer under the quick project, adding it to the list once', async () => {
  await openQuickTask()
  await openQuickTask()
  expect(projects.filter(p => p.id === 'quick-tasks')).toHaveLength(1)
  expect(requestNewTaskForProject).toHaveBeenLastCalledWith('quick-tasks')
  expect(isQuickProject('quick-tasks')).toBe(true)
  expect(isQuickProject('p1')).toBe(false)
})
