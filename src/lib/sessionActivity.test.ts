import { expect, test } from 'vitest'
import { effectiveActivity, acceptActivity } from './sessionActivity'

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
