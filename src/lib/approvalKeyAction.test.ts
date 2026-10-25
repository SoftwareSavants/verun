import { describe, test, expect } from 'vitest'
import { decideApprovalKeyAction } from './approvalKeyAction'

const base = { isInputFocused: false, defaultToNo: false }

describe('decideApprovalKeyAction', () => {
  test('Enter and y allow a normal approval', () => {
    expect(decideApprovalKeyAction({ ...base, key: 'Enter' })).toBe('allow')
    expect(decideApprovalKeyAction({ ...base, key: 'y' })).toBe('allow')
  })

  test('Escape and n deny', () => {
    expect(decideApprovalKeyAction({ ...base, key: 'Escape' })).toBe('deny')
    expect(decideApprovalKeyAction({ ...base, key: 'n' })).toBe('deny')
  })

  test('typing in an input only lets Escape through', () => {
    const focused = { ...base, isInputFocused: true }
    expect(decideApprovalKeyAction({ ...focused, key: 'Enter' })).toBe('noop')
    expect(decideApprovalKeyAction({ ...focused, key: 'n' })).toBe('noop')
    expect(decideApprovalKeyAction({ ...focused, key: 'Escape' })).toBe('deny')
  })

  test('default-to-no approvals never allow from the keyboard', () => {
    const safe = { ...base, defaultToNo: true }
    expect(decideApprovalKeyAction({ ...safe, key: 'Enter' })).toBe('deny')
    expect(decideApprovalKeyAction({ ...safe, key: 'y' })).toBe('noop')
    expect(decideApprovalKeyAction({ ...safe, key: 'Escape' })).toBe('deny')
  })
})
