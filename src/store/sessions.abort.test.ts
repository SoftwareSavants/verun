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
  sessions, setSessions,
  outputItems, setOutputItems,
  abortingSessions, setAbortingSessions,
  abortMessage,
  initSessionListeners,
} from './sessions'
import { addStep, clearSteps, getSteps } from './steps'
import * as ipc from '../lib/ipc'
import type { Session, OutputItem } from '../types'

const SID = 's-abort-001'

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

describe('abort flow with armed steps', () => {
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

  test('abortMessage sets abortingSessions flag and flips status to idle', async () => {
    setSessions([makeSession({ status: 'running' })])
    await abortMessage(SID)
    expect(abortingSessions[SID]).toBe(true)
    expect(sessions[0].status).toBe('idle')
    expect(ipc.abortMessage).toHaveBeenCalledWith(SID)
  })

  test('session-status:idle while aborting does NOT drain the armed step', async () => {
    setSessions([makeSession({ status: 'running' })])
    addStep({ sessionId: SID, message: 'queued work', armed: true })
    await abortMessage(SID)

    // Backend emits idle before graceful shutdown completes.
    // Drain must be skipped or the new --resume spawn races the old JSONL.
    fire('session-status', { sessionId: SID, status: 'idle' })

    expect(getSteps(SID).length).toBe(1)
    expect(getSteps(SID)[0].armed).toBe(true)
    expect(ipc.sendMessage).not.toHaveBeenCalled()
  })

  test('session-aborted clears flag, dequeues armed step, and pushes userMessage bubble', async () => {
    setSessions([makeSession({ status: 'running' })])
    addStep({ sessionId: SID, message: 'armed message', armed: true })
    await abortMessage(SID)
    fire('session-status', { sessionId: SID, status: 'idle' })

    // Graceful shutdown completes — now drain should happen.
    fire('session-aborted', SID)

    expect(abortingSessions[SID]).toBeUndefined()
    expect(getSteps(SID).length).toBe(0)
    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)

    // The user message bubble must appear in outputItems synchronously so the UI
    // renders the armed message immediately — this is the regression the user hit.
    const items: OutputItem[] = outputItems[SID] || []
    const userMsg = items.find(i => i.kind === 'userMessage')
    expect(userMsg).toBeDefined()
    expect(userMsg && userMsg.kind === 'userMessage' ? userMsg.text : undefined).toBe('armed message')
  })

  test('session-aborted on an already-running session does not drain (guard against stale idle check)', async () => {
    setSessions([makeSession({ status: 'running' })])
    addStep({ sessionId: SID, message: 'should wait', armed: true })
    // No abort flow — just a stray session-aborted event while still running.
    fire('session-aborted', SID)
    expect(getSteps(SID).length).toBe(1)
    expect(ipc.sendMessage).not.toHaveBeenCalled()
  })

  test('normal idle (no abort) drains armed step via session-status listener', async () => {
    setSessions([makeSession({ status: 'running' })])
    addStep({ sessionId: SID, message: 'normal queue', armed: true })

    fire('session-status', { sessionId: SID, status: 'idle' })

    expect(getSteps(SID).length).toBe(0)
    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)
    const items: OutputItem[] = outputItems[SID] || []
    expect(items.some(i => i.kind === 'userMessage')).toBe(true)
  })

  test('abortMessage rollback: ipc failure restores running status and clears flag', async () => {
    setSessions([makeSession({ status: 'running' })])
    vi.mocked(ipc.abortMessage).mockRejectedValueOnce(new Error('boom'))

    await expect(abortMessage(SID)).rejects.toThrow('boom')

    expect(abortingSessions[SID]).toBeUndefined()
    expect(sessions[0].status).toBe('running')
  })
})
