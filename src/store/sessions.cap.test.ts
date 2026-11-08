import { describe, test, expect, beforeAll, vi } from 'vitest'

// The in-memory output of a session is capped. Past the cap the listener must
// not trim on every flush: that pinned the length at the cap (so the chat,
// keyed on length, stopped updating) and copied the whole array per flush.
// It trims in chunks instead.

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
vi.mock('../lib/ipc', () => ({}))
vi.mock('../lib/notifications', () => ({ notify: vi.fn() }))
vi.mock('./tasks', () => ({ setTasks: vi.fn(), taskById: vi.fn(() => ({ name: 't' })) }))
vi.mock('./ui', () => ({
  markTaskUnread: vi.fn(),
  markSessionUnread: vi.fn(),
  addToast: vi.fn(),
  openSettings: vi.fn(),
}))

import { outputItems, setOutputItems, initSessionListeners, MAX_ITEMS_IN_MEMORY, OUTPUT_TRIM_CHUNK } from './sessions'
import type { OutputItem } from '../types'

const SID = 's-cap'
const text = (t: string) => ({ kind: 'text', text: t }) as OutputItem

function flush(items: OutputItem[]) {
  for (const cb of listeners.get('session-output') || []) cb({ payload: { sessionId: SID, items } })
}

describe('session output cap', () => {
  beforeAll(async () => { await initSessionListeners() })

  test('flushes past the cap keep growing until a chunk is due, then trim to the cap', () => {
    setOutputItems(SID, Array.from({ length: MAX_ITEMS_IN_MEMORY }, (_, i) => text(`old-${i}`)))

    flush([text('a')])
    expect(outputItems[SID].length).toBe(MAX_ITEMS_IN_MEMORY + 1)
    flush([text('b')])
    expect(outputItems[SID].length).toBe(MAX_ITEMS_IN_MEMORY + 2)
    expect((outputItems[SID][outputItems[SID].length - 1] as { text: string }).text).toBe('b')

    flush(Array.from({ length: OUTPUT_TRIM_CHUNK }, (_, i) => text(`new-${i}`)))
    expect(outputItems[SID].length).toBe(MAX_ITEMS_IN_MEMORY)
    expect((outputItems[SID][outputItems[SID].length - 1] as { text: string }).text).toBe(`new-${OUTPUT_TRIM_CHUNK - 1}`)
  })
})
