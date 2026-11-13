import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  selected: null as string | null,
  tasks: [] as { id: string; projectId: string; archived: boolean; createdAt: number }[],
  last: {} as Record<string, number>,
}))
vi.mock('../lib/ipc', () => ({}))
vi.mock('./ui', () => ({ selectedProjectId: () => mocks.selected, requestNewTaskForProject: vi.fn(), pickAndAddProject: vi.fn() }))
vi.mock('./tasks', () => ({ tasks: mocks.tasks }))
vi.mock('./lastActive', () => ({ lastActiveAt: (t: { id: string; createdAt: number }) => mocks.last[t.id] ?? t.createdAt }))

import { draftProjectOptions, openNewTask } from './newTask'
import { setProjects } from './projects'
import { pickAndAddProject, requestNewTaskForProject } from './ui'

const project = (id: string, name: string) => ({ id, name, repoPath: `/${id}`, baseBranch: 'main', setupHook: '', destroyHook: '', startCommand: '', autoStart: false, createdAt: 1, defaultAgentType: 'claude' }) as never
const setTasks = (...list: [id: string, projectId: string, lastActive: number, archived?: boolean][]) => {
  mocks.tasks.splice(0, mocks.tasks.length, ...list.map(([id, projectId, , archived = false]) => ({ id, projectId, archived, createdAt: 1 })))
  mocks.last = Object.fromEntries(list.map(([id, , lastActive]) => [id, lastActive]))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.selected = null
  setTasks()
  setProjects([project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')])
})

test('a new task starts in the project you are looking at', () => {
  mocks.selected = 'b'
  openNewTask()
  expect(requestNewTaskForProject).toHaveBeenCalledWith('b')
})

test('with no project in view, it starts in the most recently active one', () => {
  setTasks(['t1', 'a', 10], ['t2', 'c', 20])
  mocks.selected = 'deleted-project'
  openNewTask()
  expect(requestNewTaskForProject).toHaveBeenCalledWith('c')
})

test('with no projects yet, it asks for one first', () => {
  setProjects([])
  openNewTask()
  expect(requestNewTaskForProject).not.toHaveBeenCalled()
  expect(pickAndAddProject).toHaveBeenCalledOnce()
})

test('a draft can move to any project, most recently active first; archived work does not count', () => {
  setTasks(['t1', 'a', 10], ['t2', 'c', 99, true], ['t3', 'b', 20])
  expect(draftProjectOptions()).toEqual([{ value: 'b', label: 'Beta' }, { value: 'a', label: 'Alpha' }, { value: 'c', label: 'Gamma' }])
})
