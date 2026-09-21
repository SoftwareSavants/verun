import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createRoot, createEffect } from 'solid-js'

const listenCallbacks = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    listenCallbacks.set(event, cb)
    return Promise.resolve(() => listenCallbacks.delete(event))
  }),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  ptyListen: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
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
  spawnTerminal,
  activeTerminalId,
  spawnStartCommand,
  registerHookTerminal,
  refitActiveTerminal,
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
    cb({ payload: { terminalId: 'p-1', data: 'stale', seq: 5, sequence: 5 } satisfies PtyOutputEvent })
    // Let the rAF-batched buffer flush
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(term.write).not.toHaveBeenCalled()

    // seq 11 is fresh — must be written
    cb({ payload: { terminalId: 'p-1', data: 'fresh', seq: 11, sequence: 11 } satisfies PtyOutputEvent })
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(term.write).toHaveBeenCalledWith('fresh', expect.any(Function))
  })

  test('unmounted terminals rely on bounded backend replay instead of a JS queue', async () => {
    await initTerminalListeners()
    const cb = listenCallbacks.get('pty-output')!
    cb({ payload: { terminalId: 'p-pending', data: 'early', seq: 5, sequence: 1 } satisfies PtyOutputEvent })
    const term = fakeXterm()
    registerXterm('p-pending', term as any, { fit: vi.fn() } as any)
    expect(term.write).not.toHaveBeenCalled()
    expect(ipc.ptyListen).toHaveBeenCalledWith('p-pending', 0)
  })

  test('spawnTerminal lands the new instance and the active id atomically', async () => {
    // Reactive consumers (e.g. <For> inside TerminalPanel) may read both the
    // terminals store and activeTerminalId in one effect. If the two updates
    // are not batched, there is a window where the new terminal is in the
    // list but activeId still points to the previous one — which causes its
    // wrapper div to mount with display:none, leaving xterm with 0x0 dims.
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'p-new', shellName: 'zsh' })

    const observations: Array<{ ids: string[]; active: string | null }> = []
    let dispose: (() => void) | undefined

    await new Promise<void>((resolve) => {
      createRoot((d) => {
        dispose = d
        createEffect(() => {
          observations.push({
            ids: terminalsForTask('t-1').map(t => t.id),
            active: activeTerminalId('t-1'),
          })
        })
        spawnTerminal('t-1', 24, 80).then(() => resolve())
      })
    })
    dispose?.()

    // No observation should show the new terminal in the list while activeId
    // still points elsewhere (or nowhere).
    for (const o of observations) {
      if (o.ids.includes('p-new')) {
        expect(o.active).toBe('p-new')
      }
    }
  })

  test('subscribes after the snapshot and parses only catch-up output', async () => {
    await initTerminalListeners()
    vi.mocked(ipc.ptyListForTask).mockResolvedValueOnce([
      makeEntry({ terminalId: 'p-race', bufferedOutput: 'SNAP', seq: 4 }),
    ])
    await hydrateTerminalsForTask('t-1')
    const term = fakeXterm()
    const replay = consumeInitialReplay('p-race')!
    markSeqWritten('p-race', replay.seq)
    registerXterm('p-race', term as any, { fit: vi.fn() } as any)
    expect(ipc.ptyListen).toHaveBeenCalledWith('p-race', 4)
    listenCallbacks.get('pty-output')!({ payload: {
      terminalId: 'p-race', data: 'new', seq: 7, sequence: 2,
    } satisfies PtyOutputEvent })
    expect(term.write).toHaveBeenCalledWith('new', expect.any(Function))
  })
})


describe('terminal flow control', () => {
  test('subscribes from the replay checkpoint and acknowledges only after parsing', async () => {
    await initTerminalListeners()
    let parsed: (() => void) | undefined
    const term = fakeXterm()
    term.write.mockImplementation((_data: string, cb?: () => void) => { parsed = cb })
    markSeqWritten('flow-test', 10)
    registerXterm('flow-test', term as any, { fit: vi.fn() } as any)
    expect(ipc.ptyListen).toHaveBeenCalledWith('flow-test', 10)
    listenCallbacks.get('pty-output')!({ payload: { terminalId: 'flow-test', data: 'new', seq: 13, sequence: 1 } })
    expect(term.write).toHaveBeenCalledWith('new', expect.any(Function))
    expect(ipc.ptyAck).not.toHaveBeenCalled()
    parsed!()
    expect(ipc.ptyAck).toHaveBeenCalledWith('flow-test', 1)
  })
})


test('restarting an exited server releases its native replay buffer', async () => {
  vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'server', shellName: 'zsh' })
  await initTerminalListeners()
  await spawnStartCommand('t-1', 'serve')
  listenCallbacks.get('pty-exited')!({ payload: { terminalId: 'server', exitCode: 0 } })
  vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'server-next', shellName: 'zsh' })
  await spawnStartCommand('t-1', 'serve')
  expect(ipc.ptyClose).toHaveBeenCalledWith('server')
})

test('replacing a hook disposes its previous terminal and native buffer', () => {
  registerHookTerminal('t-1', 'old-hook', 'setup')
  const term = fakeXterm()
  registerXterm('old-hook', term as any, { fit: vi.fn() } as any)
  registerHookTerminal('t-1', 'new-hook', 'setup')
  expect(term.dispose).toHaveBeenCalledOnce()
  expect(ipc.ptyClose).toHaveBeenCalledWith('old-hook')
})

test('reactivating a retained terminal resumes output from its last checkpoint', async () => {
  vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'returning', shellName: 'zsh' })
  await spawnTerminal('t-1', 24, 80)
  registerXterm('returning', fakeXterm() as any, { fit: vi.fn() } as any)
  markSeqWritten('returning', 42)
  vi.mocked(ipc.ptyListen).mockClear()
  refitActiveTerminal('t-1')
  expect(ipc.ptyListen).toHaveBeenCalledWith('returning', 42)
})
