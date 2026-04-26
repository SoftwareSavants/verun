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
// Intentionally NOT mocking ../lib/binary — the real (de)serializer is what
// the bug lives behind.
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
  initSessionListeners,
} from './sessions'
import { addStep, clearSteps } from './steps'
import * as ipc from '../lib/ipc'
import type { Session, AttachmentRef } from '../types'

const SID = 's-armed-att-001'

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

describe('armed step drain with attachments', () => {
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

  // Regression: session-status:idle used JSON.parse(attachmentsJson) which
  // produced {name,mimeType,dataBase64} — the legacy in-band shape. After the
  // blob-store refactor, the wire is `AttachmentRef[]` (hash + metadata only);
  // bytes are resolved server-side. Lock in that the ref round-trips intact.
  test('drains armed step with attachment refs intact', () => {
    setSessions([makeSession({ status: 'running' })])
    const attachments: AttachmentRef[] = [
      { hash: 'h-img-1', mimeType: 'image/png', name: 'img.png', size: 4 },
    ]
    addStep({ sessionId: SID, message: 'with image', attachments, armed: true })

    fire('session-status', { sessionId: SID, status: 'idle' })

    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(ipc.sendMessage).mock.calls[0][2] as AttachmentRef[] | undefined
    expect(passed).toBeDefined()
    expect(passed!.length).toBe(1)
    expect(passed![0].name).toBe('img.png')
    expect(passed![0].mimeType).toBe('image/png')
    expect(passed![0].hash).toBe('h-img-1')
    expect(passed![0].size).toBe(4)
  })

  // Same path via the session-aborted listener (steered step after abort).
  // This one is already correct — lock it in so a future refactor cannot
  // regress both drain sites at once.
  test('drains armed step with attachment refs via session-aborted listener', () => {
    setSessions([makeSession({ status: 'idle' })])
    setAbortingSessions(produce(store => { store[SID] = true }))
    const attachments: AttachmentRef[] = [
      { hash: 'h-doc-1', mimeType: 'image/png', name: 'doc.png', size: 3 },
    ]
    addStep({ sessionId: SID, message: 'steered', attachments, armed: true })

    fire('session-aborted', SID)

    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(ipc.sendMessage).mock.calls[0][2] as AttachmentRef[] | undefined
    expect(passed).toBeDefined()
    expect(passed![0].hash).toBe('h-doc-1')
    expect(passed![0].size).toBe(3)
  })
})
