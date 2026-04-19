import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest'
import { produce } from 'solid-js/store'

// Capture every `listen(eventName, cb)` registration so tests can fire events
// directly. Mock factory must be self-contained — vi.mock is hoisted above
// imports, so referencing module-scope symbols is invalid.
const listenCallbacks = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    listenCallbacks.set(event, cb)
    return Promise.resolve(() => listenCallbacks.delete(event))
  }),
  emit: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  listSteps: vi.fn().mockResolvedValue([]),
  syncSessionStatuses: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn(),
}))

vi.mock('../lib/notifications', () => ({
  notify: vi.fn(),
}))

import { sessions, setSessions, outputItems, setOutputItems, sessionsForTask, sessionById, initSessionListeners, initSessionWindowFocusRefresh, loadSessions, createSession, clearSessionContextsForTask } from './sessions'
import * as ipc from '../lib/ipc'
import { setPlanFilePathForSession, planFilePathForSession, sessionContexts, setSessionContexts } from './sessionContext'
import type { Session, OutputItem } from '../types'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's-001',
  taskId: 't-001',
  name: null,
  resumeSessionId: null,
  status: 'idle',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  parentSessionId: null,
  forkedAtMessageUuid: null,
  agentType: 'claude' as const,
  model: null,
  ...overrides,
})

describe('sessions store', () => {
  beforeEach(() => {
    setSessions([])
    setOutputItems({})
  })

  test('starts empty', () => {
    expect(sessions.length).toBe(0)
  })

  test('setSessions populates the store', () => {
    setSessions([makeSession()])
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe('s-001')
  })

  test('sessionsForTask filters by task id', () => {
    setSessions([
      makeSession({ id: 's-1', taskId: 't-001' }),
      makeSession({ id: 's-2', taskId: 't-002' }),
      makeSession({ id: 's-3', taskId: 't-001' }),
    ])
    const filtered = sessionsForTask('t-001')
    expect(filtered.length).toBe(2)
    expect(filtered.map(s => s.id)).toEqual(['s-1', 's-3'])
  })

  test('sessionById finds the correct session', () => {
    setSessions([
      makeSession({ id: 's-1' }),
      makeSession({ id: 's-2' }),
    ])
    expect(sessionById('s-2')?.id).toBe('s-2')
  })

  test('sessionById returns undefined for missing id', () => {
    setSessions([makeSession()])
    expect(sessionById('nope')).toBeUndefined()
  })

  test('output items stored by session id', () => {
    const items: OutputItem[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'thinking', text: 'hmm' },
    ]
    setOutputItems('s-001', items)
    expect(outputItems['s-001']).toEqual(items)
  })

  test('setOutputItems can clear to empty', () => {
    setOutputItems('s-001', [{ kind: 'text', text: 'hello' }])
    setOutputItems('s-001', [])
    expect(outputItems['s-001']).toEqual([])
  })

  test('status update works', () => {
    setSessions([makeSession({ id: 's-1', status: 'running' })])
    setSessions(s => s.id === 's-1', 'status', 'idle')
    expect(sessions[0].status).toBe('idle')
  })

  test('clearSessionContextsForTask wipes only the target task sessions', () => {
    localStorage.clear()
    setSessionContexts(produce(store => {
      for (const k of Object.keys(store)) delete store[k]
    }))
    setSessions([
      makeSession({ id: 's-1', taskId: 't-001' }),
      makeSession({ id: 's-2', taskId: 't-002' }),
      makeSession({ id: 's-3', taskId: 't-001' }),
    ])
    setPlanFilePathForSession('s-1', '/tmp/1.md')
    setPlanFilePathForSession('s-2', '/tmp/2.md')
    setPlanFilePathForSession('s-3', '/tmp/3.md')

    clearSessionContextsForTask('t-001')

    expect(sessionContexts['s-1']).toBeUndefined()
    expect(sessionContexts['s-3']).toBeUndefined()
    expect(planFilePathForSession('s-2')).toBe('/tmp/2.md')
    expect(localStorage.getItem('verun:sessionContext:s-1')).toBeNull()
    expect(localStorage.getItem('verun:sessionContext:s-3')).toBeNull()
    expect(localStorage.getItem('verun:sessionContext:s-2')).not.toBeNull()
  })
})

// Cross-window session sync (issue #143). The Rust side broadcasts
// `session-created` and `session-removed` whenever a session is created or
// closed in any window; every other window must apply the change locally so
// the sidebar's task phase chip stays current without forcing a reload.
describe('cross-window session listeners', () => {
  beforeAll(async () => {
    // initSessionListeners is idempotent (module-scoped guard) — register once
    // and the captured callbacks survive across every test in this suite.
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
  })

  test('session-created adds the session to the store', () => {
    const fire = listenCallbacks.get('session-created')
    expect(fire).toBeDefined()
    const s = makeSession({ id: 's-new', taskId: 't-001' })
    fire!({ payload: s })
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe('s-new')
  })

  test('session-created is idempotent — duplicate events do not double-insert', () => {
    const fire = listenCallbacks.get('session-created')!
    const s = makeSession({ id: 's-dup' })
    fire({ payload: s })
    fire({ payload: s })
    expect(sessions.length).toBe(1)
  })

  test('session-removed deletes the session and its output items', () => {
    setSessions([makeSession({ id: 's-1' }), makeSession({ id: 's-2' })])
    setOutputItems('s-1', [{ kind: 'text', text: 'hi' }])
    const fire = listenCallbacks.get('session-removed')!
    fire({ payload: { sessionId: 's-1', taskId: 't-001' } })
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe('s-2')
    expect(outputItems['s-1']).toBeUndefined()
  })

  test('session-removed for an unknown id is a no-op', () => {
    setSessions([makeSession({ id: 's-1' })])
    const fire = listenCallbacks.get('session-removed')!
    fire({ payload: { sessionId: 's-unknown', taskId: 't-001' } })
    expect(sessions.length).toBe(1)
  })
})

// Backstop for #143 — when the window becomes visible, refresh sessions for
// every task currently in the store so any missed cross-window event heals.
describe('initSessionWindowFocusRefresh', () => {
  beforeEach(() => {
    setSessions([])
    vi.mocked(ipc.listSessions).mockClear()
    vi.mocked(ipc.listSessions).mockResolvedValue([])
    initSessionWindowFocusRefresh()
  })

  test('refreshes sessions for every distinct task on visibility change', async () => {
    setSessions([
      makeSession({ id: 's-1', taskId: 't-001' }),
      makeSession({ id: 's-2', taskId: 't-002' }),
      makeSession({ id: 's-3', taskId: 't-001' }),
    ])
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    const calls = vi.mocked(ipc.listSessions).mock.calls.map(c => c[0]).sort()
    expect(calls).toEqual(['t-001', 't-002'])
  })

  test('does not refresh while the window is hidden', () => {
    setSessions([makeSession()])
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.mocked(ipc.listSessions)).not.toHaveBeenCalled()
  })
})

// Sanity check that the loadSessions helper still merges correctly when
// the cross-window listeners are also applying writes.
describe('loadSessions', () => {
  beforeEach(() => {
    setSessions([])
    vi.mocked(ipc.listSessions).mockClear()
  })

  test('replaces only the target task, leaving other tasks untouched', async () => {
    setSessions([
      makeSession({ id: 's-other', taskId: 't-other' }),
      makeSession({ id: 's-stale', taskId: 't-001' }),
    ])
    vi.mocked(ipc.listSessions).mockResolvedValueOnce([
      makeSession({ id: 's-fresh', taskId: 't-001' }),
    ])
    await loadSessions('t-001')
    const ids = sessions.map(s => s.id).sort()
    expect(ids).toEqual(['s-fresh', 's-other'])
  })
})

// Regression — when the source window calls createSession, Rust both returns
// the session AND broadcasts session-created. If the broadcast lands before the
// IPC await resolves, the listener pushes first; without dedup the local push
// duplicates it, doubling the entry in the sessions store (and the tab bar).
describe('createSession dedup vs cross-window broadcast', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
    vi.mocked(ipc.createSession).mockReset()
  })

  test('does not double-insert when session-created event fires before IPC resolves', async () => {
    const s = makeSession({ id: 's-race', taskId: 't-001' })
    vi.mocked(ipc.createSession).mockImplementation(async () => {
      // Simulate the broadcast arriving while the IPC is still in-flight
      const fire = listenCallbacks.get('session-created')!
      fire({ payload: s })
      return s
    })
    await createSession('t-001', 'claude')
    expect(sessions.filter(x => x.id === 's-race').length).toBe(1)
  })

  test('does not double-insert when broadcast arrives after IPC resolves', async () => {
    const s = makeSession({ id: 's-after', taskId: 't-001' })
    vi.mocked(ipc.createSession).mockResolvedValue(s)
    await createSession('t-001', 'claude')
    // Now the broadcast lands at the source window
    listenCallbacks.get('session-created')!({ payload: s })
    expect(sessions.filter(x => x.id === 's-after').length).toBe(1)
  })
})
