import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
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
  closeTerminal,
  getXtermEntry,
  resumeTerminalOutput,
  keepTerminalAfterExit,
  releaseKeptTerminal,
} from './terminals'
import { toasts, setToasts } from './ui'
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

// A terminal that is not a task's (the account login dialog's is one) is
// disposed when its process exits: nothing shows it any more. A host that shows
// what the command printed after it ended opts its terminal out of that, and
// disposes it itself when it is done.
describe('terminals kept after their process exits', () => {
  const exited = (terminalId: string, exitCode = 0) =>
    listenCallbacks.get('pty-exited')!({ payload: { terminalId, exitCode } })
  const fit = () => ({ fit: vi.fn() }) as any
  const used = ['kept', 'kept-too', 'plain', 'late', 'checkpoint', 'never-kept', 'tracked']

  afterEach(() => {
    for (const id of used) {
      releaseKeptTerminal(id)
      exited(id)
    }
  })

  beforeEach(async () => {
    await initTerminalListeners()
  })

  test('the exit leaves the xterm of a kept terminal alone', () => {
    const term = fakeXterm()
    keepTerminalAfterExit('kept')
    registerXterm('kept', term as any, fit())

    exited('kept', 127)

    expect(term.dispose).not.toHaveBeenCalled()
    expect(getXtermEntry('kept')?.term).toBe(term)
  })

  test('any other terminal is still disposed by its exit, whoever else is kept', () => {
    const kept = fakeXterm()
    const plain = fakeXterm()
    keepTerminalAfterExit('kept')
    registerXterm('kept', kept as any, fit())
    registerXterm('plain', plain as any, fit())

    exited('plain')

    expect(plain.dispose).toHaveBeenCalledOnce()
    expect(getXtermEntry('plain')).toBeUndefined()
    expect(kept.dispose).not.toHaveBeenCalled()
    expect(getXtermEntry('kept')).toBeDefined()
  })

  test('releasing a kept terminal disposes its xterm, once, and forgets it', () => {
    const term = fakeXterm()
    keepTerminalAfterExit('kept')
    registerXterm('kept', term as any, fit())
    exited('kept')
    expect(term.dispose).not.toHaveBeenCalled()

    releaseKeptTerminal('kept')
    releaseKeptTerminal('kept')

    expect(term.dispose).toHaveBeenCalledOnce()
    expect(getXtermEntry('kept')).toBeUndefined()
  })

  test('a released terminal is an ordinary one again: its exit, when it comes later, disposes nothing twice', () => {
    const term = fakeXterm()
    keepTerminalAfterExit('kept')
    registerXterm('kept', term as any, fit())
    // Dismissed while the command still runs: the PTY is closed, and its exit arrives after.
    releaseKeptTerminal('kept')

    exited('kept')

    expect(term.dispose).toHaveBeenCalledOnce()
  })

  test('releasing never closes the PTY: that is the host\'s to do', async () => {
    // Even for a terminal the store tracks, which is the one case where it could.
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'tracked', shellName: 'zsh' })
    await spawnTerminal('t-1', 24, 80)
    registerXterm('tracked', fakeXterm() as any, fit())
    keepTerminalAfterExit('tracked')

    releaseKeptTerminal('tracked')

    expect(ipc.ptyClose).not.toHaveBeenCalled()
    expect(getXtermEntry('tracked')).toBeUndefined()
  })

  test('a released id is an ordinary terminal again, whatever takes it next', () => {
    keepTerminalAfterExit('kept')
    registerXterm('kept', fakeXterm() as any, fit())
    releaseKeptTerminal('kept')

    const next = fakeXterm()
    registerXterm('kept', next as any, fit())
    exited('kept')

    expect(next.dispose).toHaveBeenCalledOnce()
  })

  test('two kept terminals are independent', () => {
    const first = fakeXterm()
    const second = fakeXterm()
    keepTerminalAfterExit('kept')
    keepTerminalAfterExit('kept-too')
    registerXterm('kept', first as any, fit())
    registerXterm('kept-too', second as any, fit())

    releaseKeptTerminal('kept')
    exited('kept-too')

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).not.toHaveBeenCalled()
  })

  test('a terminal that ended before it was kept loses nothing: its xterm is only made afterwards', () => {
    // A command that fails at once ends before the host knows its id. There is
    // no xterm to dispose then, and the one made later is kept like any other.
    exited('late')
    const term = fakeXterm()
    keepTerminalAfterExit('late')
    registerXterm('late', term as any, fit())

    expect(term.dispose).not.toHaveBeenCalled()
    releaseKeptTerminal('late')
    expect(term.dispose).toHaveBeenCalledOnce()
  })

  test('the replay checkpoint of a kept terminal survives the exit', () => {
    const term = fakeXterm()
    keepTerminalAfterExit('checkpoint')
    markSeqWritten('checkpoint', 42)
    registerXterm('checkpoint', term as any, fit())
    exited('checkpoint')
    vi.mocked(ipc.ptyListen).mockClear()

    // The terminal shown again resumes after what its xterm has, not from the start.
    resumeTerminalOutput('checkpoint')

    expect(ipc.ptyListen).toHaveBeenCalledWith('checkpoint', 42)
  })

  test('releasing a terminal that was never kept disposes nothing', () => {
    const term = fakeXterm()
    registerXterm('never-kept', term as any, fit())

    releaseKeptTerminal('never-kept')

    expect(term.dispose).not.toHaveBeenCalled()
    expect(getXtermEntry('never-kept')?.term).toBe(term)
  })

  test('the exit of a task terminal is unchanged: a shell is removed, a hook is kept as a log', () => {
    registerHookTerminal('t-1', 'hook-log', 'setup')
    const hook = fakeXterm()
    registerXterm('hook-log', hook as any, fit())
    keepTerminalAfterExit('kept')
    registerXterm('kept', fakeXterm() as any, fit())

    exited('hook-log', 0)

    expect(hook.dispose).not.toHaveBeenCalled()
    expect(terminalsForTask('t-1').map(t => t.id)).toContain('hook-log')
  })
})

// A project whose accounts can't be read (a secret the keychain won't give, an
// account that is gone) fails every terminal spawn with an account error. It is
// shown as its toast with the way to fix it, wherever the spawn came from: the
// new-terminal button, the shortcut, the start command, or the shell that
// replaces the last one closed. No terminal is made, and nothing is left
// rejecting with a raw error string that nobody catches.
describe('spawning on a project whose accounts cannot be read', () => {
  const secret = 'ACCOUNT_ERROR:{"kind":"secret","accountId":"a1","label":"Acme","projects":[],"message":"ANTHROPIC_API_KEY has no stored value"}'
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const titles = () => toasts().map(t => t.title)

  beforeEach(() => {
    setToasts([])
    vi.mocked(ipc.ptySpawn).mockReset()
  })

  test('spawnTerminal shows the account toast and makes no terminal', async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(secret)
    const activeBefore = activeTerminalId('t-1')

    // null: nothing was spawned, and the user has been told why.
    await expect(spawnTerminal('t-1', 24, 80)).resolves.toBeNull()

    expect(terminalsForTask('t-1')).toHaveLength(0)
    expect(activeTerminalId('t-1')).toBe(activeBefore)
    expect(titles()).toEqual(['Keychain error'])
  })

  test('spawnTerminal still returns the terminal it made, with no toast', async () => {
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'p-ok', shellName: 'zsh' })

    await expect(spawnTerminal('t-1', 24, 80)).resolves.toMatchObject({ id: 'p-ok', taskId: 't-1', name: 'zsh' })

    expect(terminalsForTask('t-1').map(t => t.id)).toEqual(['p-ok'])
    expect(toasts()).toEqual([])
  })

  test('spawnTerminal still rejects with any other failure, and shows no toast', async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce('Task t-1 not found')

    await expect(spawnTerminal('t-1', 24, 80)).rejects.toBe('Task t-1 not found')

    expect(terminalsForTask('t-1')).toHaveLength(0)
    expect(toasts()).toEqual([])
  })

  test('the start command is stopped the same way', async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(secret)

    await expect(spawnStartCommand('t-1', 'pnpm dev')).resolves.toBeNull()

    expect(terminalsForTask('t-1')).toHaveLength(0)
    expect(titles()).toEqual(['Keychain error'])
  })

  test('the shell that replaces the last one closed is stopped the same way, with nothing left unhandled', async () => {
    // Not t-1: the harness marks it as being deleted, which suppresses the replacement.
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce({ terminalId: 'last', shellName: 'zsh' })
    await spawnTerminal('t-auto', 24, 80)
    vi.mocked(ipc.ptySpawn).mockRejectedValueOnce(secret)

    // Closing the last shell opens a fresh one, which the account then refuses.
    await closeTerminal('last')
    await settle()

    expect(ipc.ptySpawn).toHaveBeenCalledTimes(2)
    expect(titles()).toEqual(['Keychain error'])
    expect(terminalsForTask('t-auto')).toHaveLength(0)
  })

  test('trying again raises the same toast once, not a second one', async () => {
    vi.mocked(ipc.ptySpawn).mockRejectedValue(secret)

    await spawnTerminal('t-1', 24, 80)
    await spawnTerminal('t-1', 24, 80)
    await spawnStartCommand('t-1', 'pnpm dev')

    expect(titles()).toEqual(['Keychain error'])
  })
})
