import { expect, test } from 'vitest'
import { effectiveActivity, acceptActivity, startedWaiting, finishedWork, clearsPendingApprovals } from './sessionActivity'

test('terminal and structured activity coexist without modifying process state', () => {
  expect(effectiveActivity('idle', false, 'working')).toEqual({ running: true, approval: false, error: false, unknown: false })
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

test('a terminal session notifies once when it starts waiting on the user', () => {
  expect(startedWaiting(undefined, 'waiting')).toBe(true)
  expect(startedWaiting('working', 'waiting')).toBe(true)
  expect(startedWaiting('waiting', 'waiting')).toBe(false)
  expect(startedWaiting('waiting', 'working')).toBe(false)
  expect(startedWaiting('working', 'idle')).toBe(false)
})

test('a session whose turn ended with background agents still running is working', () => {
  expect(effectiveActivity('background', false).running).toBe(true)
  expect(effectiveActivity('background', false, 'idle').running).toBe(true)
})

test('work is finished only when a working session settles, not when its turn hands off to background agents', () => {
  expect(finishedWork('running', 'idle')).toBe(true)
  expect(finishedWork('background', 'idle')).toBe(true)
  expect(finishedWork('background', 'error')).toBe(true)
  expect(finishedWork('running', 'background')).toBe(false)
  expect(finishedWork('idle', 'idle')).toBe(false)
})

test('approvals survive while background agents still run', () => {
  expect(clearsPendingApprovals('idle')).toBe(true)
  expect(clearsPendingApprovals('background')).toBe(false)
  expect(clearsPendingApprovals('running')).toBe(false)
})
