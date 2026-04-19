import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('../lib/ipc', () => ({
  listSteps: vi.fn().mockResolvedValue([]),
  respondToApproval: vi.fn().mockResolvedValue(undefined),
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

import { denyToolUse } from './sessions'
import * as ipc from '../lib/ipc'

describe('denyToolUse with feedback message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('denyToolUse without feedback omits the message', async () => {
    await denyToolUse('req_1', 's_1')
    expect(ipc.respondToApproval).toHaveBeenCalledWith('req_1', 'deny', undefined, undefined)
  })

  test('denyToolUse with feedback forwards the message to the CLI', async () => {
    // Regression: the plan viewer's "Request changes..." input used to fire
    // denyToolUse without the typed text, then send a separate sendMessage.
    // Claude never saw the feedback, and the plan UI stayed open because of
    // the race between the two calls. denyToolUse must accept a third
    // `message` argument and pass it through to respond_to_approval — the
    // Rust side then emits it as the `message` field in the deny response,
    // which Claude reads as the reason and continues the turn.
    await denyToolUse('req_2', 's_1', 'add error handling to step 3')
    expect(ipc.respondToApproval).toHaveBeenCalledWith(
      'req_2',
      'deny',
      undefined,
      'add error handling to step 3',
    )
  })
})
