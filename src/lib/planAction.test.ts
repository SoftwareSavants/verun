import { describe, test, expect } from 'vitest'
import { decidePlanAction } from './planAction'
import type { ToolApprovalRequest } from '../types'

function exitPlanMode(): ToolApprovalRequest {
  return {
    requestId: 'req_1',
    sessionId: 's_1',
    toolName: 'ExitPlanMode',
    toolInput: { plan: 'do x' },
  }
}

function otherTool(): ToolApprovalRequest {
  return {
    requestId: 'req_2',
    sessionId: 's_1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  }
}

describe('decidePlanAction', () => {
  test('feedback + ExitPlanMode approval → deny with the feedback as message (issue #216)', () => {
    // This is the regression that #216 was about: clicking "Request changes"
    // with typed feedback during a plan approval must send a deny+message,
    // not an approve.
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: 'add error handling',
      approval: exitPlanMode(),
      pending: false,
    })
    expect(action).toEqual({
      kind: 'deny',
      requestId: 'req_1',
      sessionId: 's_1',
      message: 'add error handling',
    })
  })

  test('empty feedback + ExitPlanMode approval → approve', () => {
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: '',
      approval: exitPlanMode(),
      pending: false,
    })
    expect(action).toEqual({
      kind: 'approve',
      requestId: 'req_1',
      sessionId: 's_1',
    })
  })

  test('feedback + no approval (persisted plan viewer) → sendFeedback', () => {
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: 'add error handling',
      approval: null,
      pending: false,
    })
    expect(action).toEqual({
      kind: 'sendFeedback',
      sessionId: 's_1',
      message: 'add error handling',
    })
  })

  test('empty feedback + no approval (persisted plan viewer) → sendImplementation', () => {
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: '',
      approval: null,
      pending: false,
    })
    expect(action).toEqual({
      kind: 'sendImplementation',
      sessionId: 's_1',
    })
  })

  test('feedback + non-ExitPlanMode approval → sendFeedback, not deny (live approval is unrelated)', () => {
    // The plan viewer can theoretically render while a non-ExitPlanMode approval
    // is the first pending one for the session - don't repurpose that approval's
    // deny channel for plan feedback.
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: 'whatever',
      approval: otherTool(),
      pending: false,
    })
    expect(action).toEqual({
      kind: 'sendFeedback',
      sessionId: 's_1',
      message: 'whatever',
    })
  })

  test('pending action in flight → noop (guard against double-submit)', () => {
    const action = decidePlanAction({
      sessionId: 's_1',
      feedback: 'add error handling',
      approval: exitPlanMode(),
      pending: true,
    })
    expect(action).toEqual({ kind: 'noop' })
  })

  test('no session → noop', () => {
    const action = decidePlanAction({
      sessionId: null,
      feedback: 'add error handling',
      approval: exitPlanMode(),
      pending: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })
})
