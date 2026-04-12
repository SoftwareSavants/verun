import { describe, test, expect, beforeEach, vi } from 'vitest'

// Mock the IPC module before importing the store
vi.mock('../lib/ipc', () => ({
  listSteps: vi.fn().mockResolvedValue([]),
  addStep: vi.fn().mockResolvedValue(undefined),
  updateStep: vi.fn().mockResolvedValue(undefined),
  deleteStep: vi.fn().mockResolvedValue(undefined),
  reorderSteps: vi.fn().mockResolvedValue(undefined),
  disarmAllSteps: vi.fn().mockResolvedValue(undefined),
}))

import { getSteps, addStep, removeStep, updateStep, reorderSteps, disarmAllSteps, dequeueArmedStep, extractStep, clearSteps } from './steps'
import * as ipc from '../lib/ipc'

describe('steps store', () => {
  beforeEach(() => {
    // Clear steps for all sessions by clearing known test sessions
    clearSteps('s-001')
    clearSteps('s-002')
    vi.clearAllMocks()
  })

  test('starts empty', () => {
    expect(getSteps('s-001')).toEqual([])
  })

  test('getSteps returns empty array for null/undefined', () => {
    expect(getSteps(null)).toEqual([])
    expect(getSteps(undefined)).toEqual([])
  })

  test('addStep adds to the store and calls IPC', () => {
    addStep({ sessionId: 's-001', message: 'Do thing 1', armed: false })
    const steps = getSteps('s-001')
    expect(steps.length).toBe(1)
    expect(steps[0].message).toBe('Do thing 1')
    expect(steps[0].armed).toBe(false)
    expect(steps[0].sessionId).toBe('s-001')
    expect(steps[0].sortOrder).toBe(0)
    expect(ipc.addStep).toHaveBeenCalledOnce()
  })

  test('addStep increments sortOrder', () => {
    addStep({ sessionId: 's-001', message: 'First', armed: false })
    addStep({ sessionId: 's-001', message: 'Second', armed: true })
    const steps = getSteps('s-001')
    expect(steps[0].sortOrder).toBe(0)
    expect(steps[1].sortOrder).toBe(1)
  })

  test('addStep stores mode settings', () => {
    addStep({ sessionId: 's-001', message: 'With modes', armed: false, model: 'opus', planMode: true, fastMode: true, thinkingMode: false })
    const step = getSteps('s-001')[0]
    expect(step.model).toBe('opus')
    expect(step.planMode).toBe(true)
    expect(step.fastMode).toBe(true)
    expect(step.thinkingMode).toBe(false)
  })

  test('addStep serializes attachments', () => {
    const attachments = [{ name: 'img.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) }]
    addStep({ sessionId: 's-001', message: 'With image', armed: false, attachments })
    const step = getSteps('s-001')[0]
    expect(step.attachmentsJson).not.toBeNull()
    const parsed = JSON.parse(step.attachmentsJson!)
    expect(parsed[0].name).toBe('img.png')
    expect(parsed[0].mimeType).toBe('image/png')
    expect(parsed[0].dataBase64).toBe('AQIDBA==')
  })

  test('addStep with no attachments sets null', () => {
    addStep({ sessionId: 's-001', message: 'No images', armed: false })
    expect(getSteps('s-001')[0].attachmentsJson).toBeNull()
  })

  test('steps are scoped by session', () => {
    addStep({ sessionId: 's-001', message: 'Session 1', armed: false })
    addStep({ sessionId: 's-002', message: 'Session 2', armed: false })
    expect(getSteps('s-001').length).toBe(1)
    expect(getSteps('s-002').length).toBe(1)
    expect(getSteps('s-001')[0].message).toBe('Session 1')
  })

  test('removeStep removes from store and calls IPC', () => {
    addStep({ sessionId: 's-001', message: 'To remove', armed: false })
    const id = getSteps('s-001')[0].id
    removeStep('s-001', id)
    expect(getSteps('s-001').length).toBe(0)
    expect(ipc.deleteStep).toHaveBeenCalledWith(id)
  })

  test('removeStep only removes the target', () => {
    addStep({ sessionId: 's-001', message: 'Keep', armed: false })
    addStep({ sessionId: 's-001', message: 'Remove', armed: false })
    const removeId = getSteps('s-001')[1].id
    removeStep('s-001', removeId)
    expect(getSteps('s-001').length).toBe(1)
    expect(getSteps('s-001')[0].message).toBe('Keep')
  })

  test('updateStep changes message', () => {
    addStep({ sessionId: 's-001', message: 'Original', armed: false })
    const id = getSteps('s-001')[0].id
    updateStep('s-001', id, { message: 'Updated' })
    expect(getSteps('s-001')[0].message).toBe('Updated')
    expect(ipc.updateStep).toHaveBeenCalled()
  })

  test('updateStep toggles armed', () => {
    addStep({ sessionId: 's-001', message: 'Test', armed: false })
    const id = getSteps('s-001')[0].id
    updateStep('s-001', id, { armed: true })
    expect(getSteps('s-001')[0].armed).toBe(true)
  })

  test('updateStep changes mode settings', () => {
    addStep({ sessionId: 's-001', message: 'Test', armed: false, planMode: false, fastMode: false })
    const id = getSteps('s-001')[0].id
    updateStep('s-001', id, { planMode: true, fastMode: true, model: 'opus' })
    const step = getSteps('s-001')[0]
    expect(step.planMode).toBe(true)
    expect(step.fastMode).toBe(true)
    expect(step.model).toBe('opus')
  })

  test('updateStep changes attachmentsJson', () => {
    addStep({ sessionId: 's-001', message: 'Test', armed: false })
    const id = getSteps('s-001')[0].id
    updateStep('s-001', id, { attachmentsJson: '[{"name":"file.png"}]' })
    expect(getSteps('s-001')[0].attachmentsJson).toBe('[{"name":"file.png"}]')
  })

  test('reorderSteps changes order', () => {
    addStep({ sessionId: 's-001', message: 'A', armed: false })
    addStep({ sessionId: 's-001', message: 'B', armed: false })
    addStep({ sessionId: 's-001', message: 'C', armed: false })
    const steps = getSteps('s-001')
    const ids = [steps[2].id, steps[0].id, steps[1].id] // C, A, B
    reorderSteps('s-001', ids)
    const reordered = getSteps('s-001')
    expect(reordered.map(s => s.message)).toEqual(['C', 'A', 'B'])
    expect(reordered.map(s => s.sortOrder)).toEqual([0, 1, 2])
    expect(ipc.reorderSteps).toHaveBeenCalledWith('s-001', ids)
  })

  test('disarmAllSteps sets all armed to false', () => {
    addStep({ sessionId: 's-001', message: 'Armed 1', armed: true })
    addStep({ sessionId: 's-001', message: 'Armed 2', armed: true })
    addStep({ sessionId: 's-001', message: 'Paused', armed: false })
    disarmAllSteps('s-001')
    expect(getSteps('s-001').every(s => !s.armed)).toBe(true)
    expect(ipc.disarmAllSteps).toHaveBeenCalledWith('s-001')
  })

  test('disarmAllSteps does not remove steps', () => {
    addStep({ sessionId: 's-001', message: 'Keep me', armed: true })
    disarmAllSteps('s-001')
    expect(getSteps('s-001').length).toBe(1)
  })

  test('dequeueArmedStep returns and removes first armed step', () => {
    addStep({ sessionId: 's-001', message: 'Paused', armed: false })
    addStep({ sessionId: 's-001', message: 'Armed', armed: true })
    addStep({ sessionId: 's-001', message: 'Also armed', armed: true })

    const step = dequeueArmedStep('s-001')
    expect(step).toBeDefined()
    expect(step!.message).toBe('Armed')
    expect(getSteps('s-001').length).toBe(2)
    expect(getSteps('s-001').map(s => s.message)).toEqual(['Paused', 'Also armed'])
    expect(ipc.deleteStep).toHaveBeenCalledWith(step!.id)
  })

  test('dequeueArmedStep returns undefined when no armed steps', () => {
    addStep({ sessionId: 's-001', message: 'Paused', armed: false })
    expect(dequeueArmedStep('s-001')).toBeUndefined()
  })

  test('dequeueArmedStep returns undefined for empty session', () => {
    expect(dequeueArmedStep('s-001')).toBeUndefined()
  })

  test('extractStep removes specific step by id', () => {
    addStep({ sessionId: 's-001', message: 'A', armed: false })
    addStep({ sessionId: 's-001', message: 'B', armed: false })
    addStep({ sessionId: 's-001', message: 'C', armed: false })
    const targetId = getSteps('s-001')[1].id // B

    const extracted = extractStep('s-001', targetId)
    expect(extracted).toBeDefined()
    expect(extracted!.message).toBe('B')
    expect(getSteps('s-001').length).toBe(2)
    expect(getSteps('s-001').map(s => s.message)).toEqual(['A', 'C'])
  })

  test('extractStep returns undefined for missing id', () => {
    addStep({ sessionId: 's-001', message: 'A', armed: false })
    expect(extractStep('s-001', 'nonexistent')).toBeUndefined()
  })

  test('clearSteps removes all steps for session', () => {
    addStep({ sessionId: 's-001', message: 'A', armed: false })
    addStep({ sessionId: 's-001', message: 'B', armed: true })
    clearSteps('s-001')
    expect(getSteps('s-001')).toEqual([])
  })

  test('clearSteps does not affect other sessions', () => {
    addStep({ sessionId: 's-001', message: 'Session 1', armed: false })
    addStep({ sessionId: 's-002', message: 'Session 2', armed: false })
    clearSteps('s-001')
    expect(getSteps('s-001')).toEqual([])
    expect(getSteps('s-002').length).toBe(1)
  })
})
