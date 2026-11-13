import { expect, test } from 'vitest'
import { projectsByRecency, recentTasks } from './recentTasks'

const H = 3600_000
const now = 100 * 24 * H
const row = (id: string, column: string, hoursAgo: number) => ({ id, column: column as never, lastActive: now - hoursAgo * H })

test('one list, most recently active first, whatever the status', () => {
  const { recent } = recentTasks([row('idle-5h', 'idle', 5), row('run-1h', 'running', 1), row('pr-2h', 'review', 2), row('idle-now', 'idle', 0)], now)
  expect(recent.map(r => r.id)).toEqual(['idle-now', 'run-1h', 'pr-2h', 'idle-5h'])
})

test('what needs you is pinned above the list, so it is left out of it', () => {
  expect(recentTasks([row('ask', 'attention', 1), row('a', 'idle', 2)], now).recent.map(r => r.id)).toEqual(['a'])
})

test('tasks quiet for days fold away; running ones never do', () => {
  const { recent, quiet } = recentTasks([row('today', 'idle', 2), row('old-run', 'running', 24 * 9), row('last-week', 'done', 24 * 7)], now)
  expect(recent.map(r => r.id)).toEqual(['today', 'old-run'])
  expect(quiet.map(r => r.id)).toEqual(['last-week'])
})

test('archived tasks are not listed', () => {
  expect(recentTasks([row('a', 'archived', 1)], now)).toEqual({ recent: [], quiet: [] })
})

test('projects come by their latest task activity; projects without tasks keep their order after them', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const tasks = [{ projectId: 'c', lastActive: 5 }, { projectId: 'b', lastActive: 9 }, { projectId: 'c', lastActive: 12 }]
  expect(projectsByRecency(projects, tasks).map(p => p.id)).toEqual(['c', 'b', 'a', 'd'])
})
