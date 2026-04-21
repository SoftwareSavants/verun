import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest'
import { produce } from 'solid-js/store'

type Listener = (event: { payload: unknown }) => void
const listeners = new Map<string, Listener[]>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: Listener) => {
    const arr = listeners.get(name) || []
    arr.push(cb)
    listeners.set(name, arr)
    return Promise.resolve(() => {})
  }),
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('../lib/ipc', () => ({
  listSteps: vi.fn().mockResolvedValue([]),
  addStep: vi.fn().mockResolvedValue(undefined),
  updateStep: vi.fn().mockResolvedValue(undefined),
  deleteStep: vi.fn().mockResolvedValue(undefined),
  reorderSteps: vi.fn().mockResolvedValue(undefined),
  disarmAllSteps: vi.fn().mockResolvedValue(undefined),
  abortMessage: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
}))

vi.mock('../lib/notifications', () => ({ notify: vi.fn() }))
vi.mock('../lib/binary', () => ({
  deserializeAttachments: vi.fn(() => undefined),
  serializeAttachments: vi.fn(() => null),
}))
vi.mock('./tasks', () => ({
  setTasks: vi.fn(),
  taskById: vi.fn(() => ({ name: 'test-task' })),
}))
vi.mock('./ui', () => ({
  markTaskUnread: vi.fn(),
  markTaskAttention: vi.fn(),
  clearTaskAttention: vi.fn(),
  markSessionUnread: vi.fn(),
}))

import {
  setSessions,
  setOutputItems,
  setAbortingSessions,
  steerSession,
  initSessionListeners,
} from './sessions'
import { clearSteps, getSteps } from './steps'
import * as ipc from '../lib/ipc'
import type { Session } from '../types'

const SID = 's-steer-001'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: SID,
  taskId: 't-001',
  name: null,
  resumeSessionId: null,
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  parentSessionId: null,
  forkedAtMessageUuid: null,
  agentType: 'claude' as const,
  model: null,
  closedAt: null,
  ...overrides,
})

function fire(name: string, payload: unknown) {
  const arr = listeners.get(name) || []
  for (const cb of arr) cb({ payload })
}

describe('steerSession', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems(produce(store => { delete store[SID] }))
    setAbortingSessions(produce(store => { delete store[SID] }))
    clearSteps(SID)
    vi.clearAllMocks()
  })

  test('queues an armed step and then aborts — does not sendMessage directly', async () => {
    // Regression: handleSteer used to call abortMessage then immediately
    // sendMessage. The second call raced the in-flight interrupt and hit
    // Rust's busy guard (task.rs "Session is already processing a message"),
    // silently failing. Claude kept running, UI flipped to idle — classic
    // desync. The fix: queue an armed step so the session-aborted listener
    // drains it after graceful shutdown completes.
    setSessions([makeSession({ status: 'running' })])

    await steerSession(SID, 'new direction', undefined, 'sonnet', false, false, false)

    expect(ipc.abortMessage).toHaveBeenCalledWith(SID)
    expect(ipc.sendMessage).not.toHaveBeenCalled()
    const steps = getSteps(SID)
    expect(steps.length).toBe(1)
    expect(steps[0].armed).toBe(true)
    expect(steps[0].message).toBe('new direction')
    expect(steps[0].model).toBe('sonnet')
  })

  test('armed step drains via session-aborted listener after graceful shutdown', async () => {
    setSessions([makeSession({ status: 'running' })])

    await steerSession(SID, 'steered message', undefined, undefined, false, false, false)
    // Backend signals graceful shutdown finished — drain should now fire.
    fire('session-status', { sessionId: SID, status: 'idle' })
    fire('session-aborted', SID)

    expect(getSteps(SID).length).toBe(0)
    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)
    expect(ipc.sendMessage).toHaveBeenCalledWith(SID, 'steered message', undefined, undefined, false, false, false)
  })
})
