import { expect, test } from 'vitest'
import { workState, notificationFor } from './sessionNotifications'

test('one work state per session, from chat status, approvals and terminal hooks alike', () => {
  expect(workState('running', false)).toBe('working')
  // Background work left running: Claude usually resumes when it reports
  // back, so no "completed" yet, though the board shows it as your turn.
  expect(workState('background', false)).toBe('working')
  expect(workState('idle', false, 'idle', 2)).toBe('working')
  expect(workState('idle', false, 'working')).toBe('working')
  expect(workState('idle', true)).toBe('needs-input')
  expect(workState('idle', false, 'waiting')).toBe('needs-input')
  expect(workState('error', false)).toBe('failed')
  expect(workState('idle', false, 'failed')).toBe('failed')
  expect(workState('idle', false, 'idle')).toBe('finished')
  expect(workState('idle', false)).toBe('finished')
  // Unreadable terminal status: no claim either way.
  expect(workState('idle', false, 'unknown')).toBeNull()
})

test('notifies only when work actually finishes, fails or needs you', () => {
  expect(notificationFor('working', 'finished', false)).toBe('completed')
  expect(notificationFor('working', 'failed', false)).toBe('failed')
  expect(notificationFor('working', 'needs-input', false)).toBe('needs-input')
  expect(notificationFor('finished', 'needs-input', false)).toBe('needs-input')
})

test('stays quiet for your own stops, first sightings, and non-transitions', () => {
  expect(notificationFor('working', 'finished', true)).toBeNull()
  expect(notificationFor(undefined, 'finished', false)).toBeNull()
  expect(notificationFor(undefined, 'needs-input', false)).toBeNull()
  expect(notificationFor('finished', 'finished', false)).toBeNull()
  expect(notificationFor('needs-input', 'needs-input', false)).toBeNull()
  expect(notificationFor('finished', 'working', false)).toBeNull()
  // Answering the question resumes work; that's not a completion.
  expect(notificationFor('needs-input', 'working', false)).toBeNull()
})
