import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest'

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

import { sessions, setSessions, initSessionListeners } from './sessions'
import type { Session } from '../types'

const SID = 's-resume-001'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: SID,
  taskId: 't-001',
  name: null,
  resumeSessionId: null,
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
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

describe('session-resume-id event', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
  })

  test('updates session.resumeSessionId in place when Rust extracts it from the first turn', () => {
    setSessions([makeSession({ resumeSessionId: null })])

    fire('session-resume-id', { sessionId: SID, resumeSessionId: 'cs-abc-123' })

    const s = sessions.find(x => x.id === SID)
    expect(s?.resumeSessionId).toBe('cs-abc-123')
  })

  test('clears resumeSessionId when payload is empty (e.g. clear_session_history)', () => {
    setSessions([makeSession({ resumeSessionId: 'cs-old' })])

    fire('session-resume-id', { sessionId: SID, resumeSessionId: '' })

    const s = sessions.find(x => x.id === SID)
    expect(s?.resumeSessionId).toBeNull()
  })

  test('ignores events for unknown sessions', () => {
    setSessions([makeSession({ resumeSessionId: 'cs-existing' })])

    fire('session-resume-id', { sessionId: 'unknown-sid', resumeSessionId: 'cs-other' })

    const s = sessions.find(x => x.id === SID)
    expect(s?.resumeSessionId).toBe('cs-existing')
  })
})
