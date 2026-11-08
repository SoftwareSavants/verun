import { beforeEach, expect, test } from 'vitest'
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
