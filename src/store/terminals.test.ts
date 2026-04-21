import { describe, test, expect, beforeEach, vi } from 'vitest'

const listenCallbacks = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    listenCallbacks.set(event, cb)
    return Promise.resolve(() => listenCallbacks.delete(event))
  }),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  ptyListForTask: vi.fn().mockResolvedValue([]),
  ptySpawn: vi.fn(),
  ptyClose: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
}))

import * as ipc from '../lib/ipc'
import {
  terminals,
  terminalsForTask,
  hydrateTerminalsForTask,
  isTaskHydrated,
  consumeInitialReplay,
  markSeqWritten,
  registerXterm,
  initTerminalListeners,
  closeTerminalsForTask,
} from './terminals'
import type { PtyListEntry, PtyOutputEvent } from '../types'

function makeEntry(overrides: Partial<PtyListEntry> = {}): PtyListEntry {
  return {
    terminalId: 'p-1',
    taskId: 't-1',
    name: 'zsh',
    isStartCommand: false,
    hookType: null,
    bufferedOutput: '',
    seq: 0,
    ...overrides,
  }
}

function fakeXterm() {
  return {
    write: vi.fn(),
    focus: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    rows: 24,
    cols: 80,
  }
}

beforeEach(() => {
  closeTerminalsForTask('t-1')
  closeTerminalsForTask('t-2')
  vi.clearAllMocks()
})

describe('hydrateTerminalsForTask', () => {
  test('marks the task as hydrated even when no PTYs exist', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([])
    expect(isTaskHydrated('t-1')).toBe(false)
    await hydrateTerminalsForTask('t-1')
    expect(isTaskHydrated('t-1')).toBe(true)
    expect(terminalsForTask('t-1')).toHaveLength(0)
  })

  test('populates store with entries from ipc including replay + seq', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-shell', name: 'zsh', bufferedOutput: 'hello', seq: 5 }),
    ])
    await hydrateTerminalsForTask('t-1')
    const list = terminalsForTask('t-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('p-shell')
    expect(list[0].initialReplay).toEqual({ data: 'hello', seq: 5 })
  })

  test('puts hooks and start command before regular shells', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'shell', name: 'zsh' }),
      makeEntry({ terminalId: 'dev', name: 'Dev Server', isStartCommand: true }),
      makeEntry({ terminalId: 'setup', name: 'Setup', hookType: 'setup' }),
    ])
    await hydrateTerminalsForTask('t-1')
    const list = terminalsForTask('t-1').map(t => t.id)
    // hooks / start cmd get unshifted, so they end up first in insertion order
    expect(list[0]).not.toBe('shell')
    expect(list).toContain('shell')
    expect(list).toContain('dev')
    expect(list).toContain('setup')
  })

  test('is idempotent for already-known terminals', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValue([
      makeEntry({ terminalId: 'p-a' }),
    ])
    await hydrateTerminalsForTask('t-1')
    await hydrateTerminalsForTask('t-1')
    expect(terminalsForTask('t-1')).toHaveLength(1)
  })

  test('re-hydration syncs store: adds new backend PTYs and prunes missing ones', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-a' }),
      makeEntry({ terminalId: 'p-b' }),
    ])
    await hydrateTerminalsForTask('t-1')
    expect(terminalsForTask('t-1').map(t => t.id).sort()).toEqual(['p-a', 'p-b'])

    // Second snapshot: p-a closed in another window, p-c spawned there.
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-b' }),
      makeEntry({ terminalId: 'p-c', bufferedOutput: 'hi from other window', seq: 3 }),
    ])
    await hydrateTerminalsForTask('t-1')

    const ids = terminalsForTask('t-1').map(t => t.id).sort()
    expect(ids).toEqual(['p-b', 'p-c'])
    const pc = terminalsForTask('t-1').find(t => t.id === 'p-c')
    expect(pc?.initialReplay).toEqual({ data: 'hi from other window', seq: 3 })
  })

  test('pruning during re-hydration does not auto-spawn a replacement shell', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-only' }),
    ])
    await hydrateTerminalsForTask('t-1')
    expect(terminalsForTask('t-1')).toHaveLength(1)

    // Backend now reports zero PTYs (all closed elsewhere). Must not spawn a
    // replacement via removeTerminal's fallback.
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([])
    await hydrateTerminalsForTask('t-1')

    expect(terminalsForTask('t-1')).toHaveLength(0)
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
  })

  test('still marks hydrated when ipc throws (prevents spawn deadlock)', async () => {
    vi.mocked(ipc.ptyListForTask).mockRejectedValueOnce(new Error('boom'))
    await hydrateTerminalsForTask('t-1')
    expect(isTaskHydrated('t-1')).toBe(true)
  })

  test('omits initialReplay when buffered output is empty', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-empty', bufferedOutput: '', seq: 0 }),
    ])
    await hydrateTerminalsForTask('t-1')
    expect(terminals.find(t => t.id === 'p-empty')?.initialReplay).toBeUndefined()
  })
})

describe('pty-output seq dedupe', () => {
  test('drops events with seq <= markSeqWritten boundary', async () => {
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-1', bufferedOutput: 'snap', seq: 10 }),
    ])
    await hydrateTerminalsForTask('t-1')
    await initTerminalListeners()

    // Simulate ShellTerminal.onMount: consume replay, mark seq, then register
    const replay = consumeInitialReplay('p-1')
    expect(replay).toEqual({ data: 'snap', seq: 10 })
    const term = fakeXterm()
    markSeqWritten('p-1', replay!.seq)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerXterm('p-1', term as any, { fit: vi.fn() } as any)

    const cb = listenCallbacks.get('pty-output')!
    // seq 5 is below the snapshot boundary — must be dropped
    cb({ payload: { terminalId: 'p-1', data: 'stale', seq: 5 } satisfies PtyOutputEvent })
    // Let the rAF-batched buffer flush
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(term.write).not.toHaveBeenCalled()

    // seq 11 is fresh — must be written
    cb({ payload: { terminalId: 'p-1', data: 'fresh', seq: 11 } satisfies PtyOutputEvent })
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(term.write).toHaveBeenCalledWith('fresh')
  })

  test('buffers events arriving before registerXterm and flushes on register', async () => {
    await initTerminalListeners()
    const cb = listenCallbacks.get('pty-output')!

    // Event arrives before xterm mounts — stashed in pendingChunks
    cb({ payload: { terminalId: 'p-pending', data: 'early', seq: 1 } satisfies PtyOutputEvent })

    const term = fakeXterm()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerXterm('p-pending', term as any, { fit: vi.fn() } as any)
    expect(term.write).toHaveBeenCalledWith('early')
  })

  test('filters pending chunks already covered by a snapshot replay', async () => {
    await initTerminalListeners()
    const cb = listenCallbacks.get('pty-output')!

    // Live chunks arrive first
    cb({ payload: { terminalId: 'p-race', data: 'old', seq: 3 } satisfies PtyOutputEvent })
    cb({ payload: { terminalId: 'p-race', data: 'new', seq: 7 } satisfies PtyOutputEvent })

    // Hydration snapshot at seq 5 covers 'old' but not 'new'
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-race', bufferedOutput: 'SNAP', seq: 5 }),
    ])
    await hydrateTerminalsForTask('t-1')

    const term = fakeXterm()
    const replay = consumeInitialReplay('p-race')!
    markSeqWritten('p-race', replay.seq)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerXterm('p-race', term as any, { fit: vi.fn() } as any)

    // Only seq-7 chunk should flush — seq-3 was covered by the snapshot
    expect(term.write).toHaveBeenCalledWith('new')
    expect(term.write).not.toHaveBeenCalledWith('old')
  })
})
