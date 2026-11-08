import { beforeEach, expect, test, vi } from 'vitest'
import { produce } from 'solid-js/store'
import { setSessions, setPendingApprovals } from './sessions'
import { setTasks } from './tasks'
import { taskStatus, needsYou } from './taskStatus'
import { DEMO_TASKS, DEMO_SESSIONS } from '../lib/seedData'
import type { ToolApprovalRequest } from '../types'

const task = { ...DEMO_TASKS[0], id: 't1' }
const session = { ...DEMO_SESSIONS[0], id: 's1', taskId: 't1', status: 'idle' as const, closedAt: null }

beforeEach(() => {
  setTasks([task])
  setSessions([session])
  clearApprovals()
})
// A store setter merges objects, so clearing has to delete keys explicitly.
const clearApprovals = () => setPendingApprovals(produce(s => { for (const k of Object.keys(s)) delete s[k] }))

test('a pending approval puts the task in Needs you, derived rather than stored', () => {
  expect(needsYou('t1')).toBe(false)
  setPendingApprovals({ s1: [{ requestId: 'r1', sessionId: 's1', toolName: 'Bash' } as ToolApprovalRequest] })
  expect(taskStatus('t1')).toMatchObject({ column: 'attention', kind: 'input' })
  clearApprovals()
  expect(needsYou('t1')).toBe(false)
})

test('sidebar and board share one reading of session state', () => {
  setSessions([{ ...session, status: 'running' }])
  expect(taskStatus('t1')).toMatchObject({ column: 'running', kind: 'running' })
  setSessions([{ ...session, status: 'error' }])
  expect(taskStatus('t1')).toMatchObject({ column: 'attention', kind: 'failed' })
  setSessions([{ ...session, status: 'running', closedAt: 1 }])
  expect(taskStatus('t1').kind).toBe('idle')
})

test('an old crashed session does not flag a task whose newest session is healthy', () => {
  const old = { ...session, id: 'old', status: 'error' as const, startedAt: 1 }
  const fresh = { ...session, id: 'new', status: 'running' as const, startedAt: 2 }
  setSessions([old, fresh])
  expect(taskStatus('t1')).toMatchObject({ column: 'running', kind: 'running' })
  setSessions([{ ...fresh, status: 'error' }, { ...old, status: 'idle' }])
  expect(taskStatus('t1').kind).toBe('failed')
})

test('a question waiting in any session still needs you', () => {
  setSessions([{ ...session, id: 'old', startedAt: 1 }, { ...session, id: 'new', startedAt: 2, status: 'running' }])
  setPendingApprovals({ old: [{ requestId: 'r', sessionId: 'old', toolName: 'AskUserQuestion' } as ToolApprovalRequest] })
  expect(taskStatus('t1').kind).toBe('input')
})

test('reading every task is not quadratic: task lookup does not scan the list', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ ...task, id: `t${i}`, archived: i === 7 }))
  setTasks(many)
  taskStatus('t0')
  const find = vi.spyOn(Array.prototype, 'find')
  try {
    for (const t of many) taskStatus(t.id)
    expect(find).not.toHaveBeenCalled()
  } finally {
    find.mockRestore()
  }
  expect(taskStatus('t7').kind).toBe('archived')
})
