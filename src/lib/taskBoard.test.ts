import { expect, test } from 'vitest'
import { taskBoardState, agentsWorking } from './taskBoard'

test('archived wins over stale activity; attention wins over running', () => {
  expect(taskBoardState({ archived: true, running: true, approval: true }).column).toBe('archived')
  expect(taskBoardState({ running: true, approval: true })).toEqual({ column: 'attention', kind: 'input', label: 'Needs input' })
  expect(taskBoardState({ running: true, failedChecks: true }).column).toBe('attention')
})
test('idle is not done: idle, in-review and merged tasks land in separate columns', () => {
  expect(taskBoardState({})).toEqual({ column: 'idle', kind: 'idle', label: 'Idle' })
  expect(taskBoardState({ prOpen: true })).toEqual({ column: 'review', kind: 'pr-open', label: 'PR open' })
  expect(taskBoardState({ merged: true })).toEqual({ column: 'done', kind: 'merged', label: 'PR merged' })
  expect(taskBoardState({ running: true }).column).toBe('running')
  expect(taskBoardState({ running: true, prOpen: true }).column).toBe('running')
  expect(taskBoardState({ creating: true }).label).toBe('Setting up')
  expect(taskBoardState({ error: true }).column).toBe('attention')
  expect(taskBoardState({ conflicts: true }).label).toBe('Merge conflicts')
})
test('every state carries a distinct icon kind so status never relies on color alone', () => {
  expect(taskBoardState({ approval: true }).kind).toBe('input')
  expect(taskBoardState({ error: true }).kind).toBe('failed')
  expect(taskBoardState({ conflicts: true }).kind).toBe('conflicts')
  expect(taskBoardState({ failedChecks: true }).kind).toBe('ci-failed')
  expect(taskBoardState({ running: true }).kind).toBe('running')
  expect(taskBoardState({ creating: true }).kind).toBe('busy')
  expect(taskBoardState({ archiving: true }).kind).toBe('busy')
  expect(taskBoardState({ archived: true }).kind).toBe('archived')
})
test('unknown terminal activity never claims readiness', () => {
  expect(taskBoardState({ unknown: true })).toEqual({ column: 'unknown', kind: 'unknown', label: 'Status unavailable' })
  expect(taskBoardState({ unknown: true, running: true }).column).toBe('running')
  expect(taskBoardState({ unknown: true, approval: true }).column).toBe('attention')
})
test('background work after the turn ended reads as your turn, not running', () => {
  expect(taskBoardState({ background: true })).toEqual({ column: 'idle', kind: 'background', label: 'Your turn, work running in background' })
  expect(taskBoardState({ background: true, running: true }).kind).toBe('running')
  expect(taskBoardState({ background: true, approval: true }).kind).toBe('input')
})
test('background status says what is still running when the counts are known', () => {
  const label = (agents: number, shells: number, total: number) =>
    taskBoardState({ background: true, backgroundWork: { agents, shells, total } }).label
  expect(label(2, 1, 3)).toBe('Your turn, 2 agents and 1 shell still running')
  expect(label(1, 0, 1)).toBe('Your turn, 1 agent still running')
  expect(label(0, 2, 2)).toBe('Your turn, 2 shells still running')
  expect(label(2, 0, 3)).toBe('Your turn, 2 agents and 1 other task still running')
  expect(label(0, 0, 2)).toBe('Your turn, 2 background tasks still running')
})
test('keep-awake counts background work: the Mac sleeping would stall it', () => {
  expect(agentsWorking(taskBoardState({ running: true }))).toBe(true)
  expect(agentsWorking(taskBoardState({ background: true }))).toBe(true)
  expect(agentsWorking(taskBoardState({}))).toBe(false)
  expect(agentsWorking(taskBoardState({ approval: true }))).toBe(false)
})
