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
const ui = vi.hoisted(() => ({
  markTaskUnread: vi.fn(),
  markTaskAttention: vi.fn(),
  clearTaskAttention: vi.fn(),
  markSessionUnread: vi.fn(),
  addToast: vi.fn(),
  openSettings: vi.fn(),
}))
vi.mock('./ui', () => ui)

import {
  setSessions,
  setOutputItems,
  setAbortingSessions,
  initSessionListeners,
} from './sessions'
import { sendStep } from './sessions'
import { addStep, clearSteps, getSteps, extractStep } from './steps'
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
  accountId: null,
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

// A step comes off the queue to be sent. When the session's account stops the
// send (sendMessage resolves false after its toast), the step is not lost: it
// goes back where it was, and the queue is paused so nothing retries by itself.
describe('a queued step the account stops', () => {
  const signedOut = 'ACCOUNT_ERROR:{"kind":"signedOut","accountId":"a1","label":"Acme","projects":[],"message":null}'
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const queue = () => getSteps(SID).map(step => ({ message: step.message, armed: step.armed }))

  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([makeSession({ status: 'running' })])
    setOutputItems(produce(store => { delete store[SID] }))
    setAbortingSessions(produce(store => { delete store[SID] }))
    clearSteps(SID)
    vi.clearAllMocks()
    vi.mocked(ipc.sendMessage).mockReset()
    vi.mocked(ipc.sendMessage).mockResolvedValue(undefined)
  })

  test('an armed step the session drains goes back on the queue, paused with the rest of it', async () => {
    addStep({ sessionId: SID, message: 'first', armed: true })
    addStep({ sessionId: SID, message: 'second', armed: true })
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(signedOut)

    fire('session-status', { sessionId: SID, status: 'idle' })
    await settle()

    expect(queue()).toEqual([{ message: 'first', armed: false }, { message: 'second', armed: false }])
    expect(ipc.disarmAllSteps).toHaveBeenCalledWith(SID)
    expect(ipc.addStep).toHaveBeenCalledWith(expect.any(String), SID, 'first', null, false, null, null, null, null, 0)
    // The toast is the only thing the user is told, and only once.
    expect(ui.addToast).toHaveBeenCalledTimes(1)
  })

  test('a paused queue is not drained by the next idle', async () => {
    addStep({ sessionId: SID, message: 'first', armed: true })
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(signedOut)
    fire('session-status', { sessionId: SID, status: 'idle' })
    await settle()
    vi.mocked(ipc.sendMessage).mockClear()

    fire('session-status', { sessionId: SID, status: 'idle' })
    await settle()

    expect(ipc.sendMessage).not.toHaveBeenCalled()
    expect(queue()).toEqual([{ message: 'first', armed: false }])
  })

  test('a step drained after an abort goes back too', async () => {
    setSessions([makeSession({ status: 'idle' })])
    setAbortingSessions(produce(store => { store[SID] = true }))
    addStep({ sessionId: SID, message: 'steered', armed: true })
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(signedOut)

    fire('session-aborted', SID)
    await settle()

    expect(queue()).toEqual([{ message: 'steered', armed: false }])
  })

  test('a step sent by hand goes back where it was when the account stops it', async () => {
    addStep({ sessionId: SID, message: 'first', armed: false })
    addStep({ sessionId: SID, message: 'second', armed: false })
    const second = extractStep(SID, getSteps(SID)[1].id)!
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(signedOut)

    await expect(sendStep(second)).resolves.toBe(false)

    expect(queue()).toEqual([{ message: 'first', armed: false }, { message: 'second', armed: false }])
  })

  // What a step is sent with is what it was queued with. The values are all
  // different from the defaults, and thinking and fast mode are opposite, so a
  // swapped or dropped argument cannot pass.
  test('a step is sent with its own model, modes and attachments', async () => {
    const attachments: AttachmentRef[] = [{ hash: 'h-1', mimeType: 'image/png', name: 'a.png', size: 3 }]
    addStep({ sessionId: SID, message: 'fire me', armed: false, attachments, model: 'opus', planMode: true, thinkingMode: false, fastMode: true })
    const step = extractStep(SID, getSteps(SID)[0].id)!

    await expect(sendStep(step)).resolves.toBe(true)

    expect(ipc.sendMessage).toHaveBeenCalledWith(SID, 'fire me', attachments, 'opus', true, false, true)
  })

  test('the other way round: no plan mode, thinking on, fast mode off', async () => {
    addStep({ sessionId: SID, message: 'fire me', armed: false, model: 'sonnet', planMode: false, thinkingMode: true, fastMode: false })
    const step = extractStep(SID, getSteps(SID)[0].id)!

    await sendStep(step)

    expect(ipc.sendMessage).toHaveBeenCalledWith(SID, 'fire me', undefined, 'sonnet', false, true, false)
  })

  test('a step queued with no model or modes is sent with none, which is undefined and not null', async () => {
    addStep({ sessionId: SID, message: 'plain', armed: false })
    const step = extractStep(SID, getSteps(SID)[0].id)!
    expect(step).toMatchObject({ model: null, planMode: null, thinkingMode: null, fastMode: null })

    await sendStep(step)

    expect(ipc.sendMessage).toHaveBeenCalledWith(SID, 'plain', undefined, undefined, undefined, undefined, undefined)
  })

  test('an armed step the session drains is sent with the same arguments', async () => {
    const attachments: AttachmentRef[] = [{ hash: 'h-2', mimeType: 'image/png', name: 'b.png', size: 4 }]
    addStep({ sessionId: SID, message: 'drain me', armed: true, attachments, model: 'opus', planMode: true, thinkingMode: false, fastMode: true })

    fire('session-status', { sessionId: SID, status: 'idle' })
    await settle()

    expect(ipc.sendMessage).toHaveBeenCalledWith(SID, 'drain me', attachments, 'opus', true, false, true)
  })

  test('a step that was sent stays off the queue and the rest is left as it was', async () => {
    addStep({ sessionId: SID, message: 'first', armed: true })
    addStep({ sessionId: SID, message: 'second', armed: true })

    fire('session-status', { sessionId: SID, status: 'idle' })
    await settle()

    expect(ipc.sendMessage).toHaveBeenCalledTimes(1)
    expect(queue()).toEqual([{ message: 'second', armed: true }])
    expect(ipc.disarmAllSteps).not.toHaveBeenCalled()
    expect(ui.addToast).not.toHaveBeenCalled()
  })

  test('any other failure leaves the step off the queue, as it did', async () => {
    addStep({ sessionId: SID, message: 'first', armed: false })
    const step = extractStep(SID, getSteps(SID)[0].id)!
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce('Session is busy')

    await expect(sendStep(step)).rejects.toBe('Session is busy')

    expect(queue()).toEqual([])
  })
})
