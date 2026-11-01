import { expect, test } from 'vitest'
import { taskBoardState } from './taskBoard'

test('archived wins over stale activity; attention wins over running', () => {
  expect(taskBoardState({ archived: true, running: true, approval: true }).column).toBe('archived')
  expect(taskBoardState({ running: true, approval: true })).toEqual({ column: 'attention', label: 'Approval needed' })
  expect(taskBoardState({ running: true, failedChecks: true }).column).toBe('attention')
})
test('idle and merged tasks remain ready, never implicitly completed', () => {
  expect(taskBoardState({})).toEqual({ column: 'ready', label: 'Ready to continue' })
  expect(taskBoardState({ merged: true })).toEqual({ column: 'ready', label: 'PR merged' })
  expect(taskBoardState({ running: true }).column).toBe('running')
  expect(taskBoardState({ creating: true }).label).toBe('Setting up')
  expect(taskBoardState({ error: true }).column).toBe('attention')
  expect(taskBoardState({ conflicts: true }).label).toBe('Merge conflicts')
})
test('unknown terminal activity never claims readiness', () => {
  expect(taskBoardState({ unknown: true })).toEqual({ column: 'unknown', label: 'Status unavailable' })
  expect(taskBoardState({ unknown: true, running: true }).column).toBe('running')
  expect(taskBoardState({ unknown: true, approval: true }).column).toBe('attention')
})
