import { expect, test } from 'vitest'
import { statusSections } from './statusView'

const H = 3600_000
const now = 100 * 24 * H
const row = (id: string, column: string, hoursAgo: number) => ({ id, column: column as never, lastActive: now - hoursAgo * H })

test('groups by status in board order, newest first, skipping empty groups', () => {
  const sections = statusSections([
    row('old-idle', 'idle', 5), row('run', 'running', 1), row('new-idle', 'idle', 1),
    row('ask', 'attention', 30), row('pr', 'review', 2),
  ], now)
  expect(sections.map(s => s.id)).toEqual(['attention', 'running', 'idle', 'review'])
  expect(sections.find(s => s.id === 'idle')!.recent.map(r => r.id)).toEqual(['new-idle', 'old-idle'])
})

test('tasks quiet for days fold away so the active ones stand out', () => {
  const [idle] = statusSections([row('today', 'idle', 2), row('last-week', 'idle', 24 * 7)], now)
  expect(idle.recent.map(r => r.id)).toEqual(['today'])
  expect(idle.quiet.map(r => r.id)).toEqual(['last-week'])
})

test('what needs you or is running never folds, however old', () => {
  const sections = statusSections([row('ask', 'attention', 24 * 30), row('run', 'running', 24 * 30)], now)
  expect(sections.every(s => s.quiet.length === 0)).toBe(true)
})

test('archived tasks are not part of the view', () => {
  expect(statusSections([row('a', 'archived', 1)], now)).toEqual([])
})
