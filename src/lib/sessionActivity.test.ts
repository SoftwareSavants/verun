import { expect, test } from 'vitest'
import { effectiveActivity, acceptActivity, clearsPendingApprovals } from './sessionActivity'

test('terminal and structured activity coexist without modifying process state', () => {
  expect(effectiveActivity('idle', false, 'working')).toEqual({ running: true, background: false, approval: false, error: false, unknown: false })
  expect(effectiveActivity('running', false, 'idle').running).toBe(true)
  expect(effectiveActivity('idle', true, 'idle').approval).toBe(true)
  expect(effectiveActivity('idle', false, 'waiting').approval).toBe(true)
  expect(effectiveActivity('idle', false, 'unknown').unknown).toBe(true)
  expect(effectiveActivity('error', false).error).toBe(true)
  expect(effectiveActivity('error', false, 'idle').error).toBe(true)
  expect(effectiveActivity('running', true).approval).toBe(true)
  expect(effectiveActivity('running', false, 'ended').running).toBe(true)
})

test('snapshot arriving after a newer event cannot overwrite it', () => {
  expect(acceptActivity(12, 11)).toBe(false)
  expect(acceptActivity(12, 12)).toBe(false)
  expect(acceptActivity(12, 13)).toBe(true)
  expect(acceptActivity(undefined, 1)).toBe(true)
})


test('a turn that ended with background work left is the user\'s turn, not running', () => {
  // Chat: the turn ended with subagents or shells still going.
  expect(effectiveActivity('background', false)).toMatchObject({ running: false, background: true })
  // Terminal: Claude is at its prompt with background tasks still counted.
  expect(effectiveActivity('idle', false, 'idle', 2)).toMatchObject({ running: false, background: true })
  // Actually working wins.
  expect(effectiveActivity('idle', false, 'working', 2)).toMatchObject({ running: true, background: false })
  expect(effectiveActivity('idle', false, 'idle', 0).background).toBe(false)
})


test('approvals survive while background agents still run', () => {
  expect(clearsPendingApprovals('idle')).toBe(true)
  expect(clearsPendingApprovals('background')).toBe(false)
  expect(clearsPendingApprovals('running')).toBe(false)
})
