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
  getOutputLines: vi.fn().mockResolvedValue([]),
  getSessionTokenTotals: vi.fn().mockResolvedValue({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  clearSession: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  reopenSession: vi.fn(),
}))

vi.mock('../lib/notifications', () => ({
  notify: vi.fn(),
}))

import { sessions, setSessions, outputItems, setOutputItems, sessionsForTask, sessionById, initSessionListeners, initSessionWindowFocusRefresh, loadSessions, loadOutputLines, loadOlderOutputLines, hasMoreOutputLines, clearOutputItems, closeSession, createSession, reopenSession, clearSessionContextsForTask, sessionCosts, setSessionCosts, sessionTokens, setSessionTokens, INITIAL_OUTPUT_LINES_LIMIT, OLDER_OUTPUT_PAGE_SIZE } from './sessions'
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
  closedAt: null,
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

// Task-switch perf: replaying all output_lines through JSON.parse on every
// session selection is the dominant cost when switching between tasks. Once
// we've loaded a session from DB, the live session-output listener keeps the
// store fresh — re-fetching is pure waste.
describe('loadOutputLines caching', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
    vi.mocked(ipc.getOutputLines).mockReset()
    vi.mocked(ipc.getOutputLines).mockResolvedValue([])
  })

  test('does not re-query the DB for an already-loaded session', async () => {
    await loadOutputLines('s-cache-hit')
    await loadOutputLines('s-cache-hit')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(1)
  })

  test('still re-queries after clearOutputItems invalidates the cache', async () => {
    await loadOutputLines('s-clear')
    await clearOutputItems('s-clear')
    await loadOutputLines('s-clear')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(2)
  })

  test('session-removed invalidates the cache so a re-created session reloads', async () => {
    setSessions([makeSession({ id: 's-gone' })])
    await loadOutputLines('s-gone')
    const fire = listenCallbacks.get('session-removed')!
    fire({ payload: { sessionId: 's-gone', taskId: 't-001' } })
    await loadOutputLines('s-gone')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(2)
  })

  test('closeSession invalidates the cache', async () => {
    setSessions([makeSession({ id: 's-close' })])
    await loadOutputLines('s-close')
    await closeSession('s-close')
    await loadOutputLines('s-close')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(2)
  })

  test('caps initial fetch with a limit so long-running sessions hydrate fast', async () => {
    await loadOutputLines('s-capped')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledWith('s-capped', INITIAL_OUTPUT_LINES_LIMIT)
  })
})

describe('loadOlderOutputLines pagination', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
    vi.mocked(ipc.getOutputLines).mockReset()
  })

  const makeUserItemsLine = (id: number, text: string) => ({
    id,
    sessionId: 's-page',
    line: JSON.stringify({ type: 'verun_user_message', text }),
    emittedAt: id * 100,
  })

  test('fetches the next page using the oldest known line.id as the cursor', async () => {
    const firstPage = Array.from({ length: INITIAL_OUTPUT_LINES_LIMIT }, (_, i) =>
      makeUserItemsLine(1000 + i, `init-${i}`),
    )
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-page')
    expect(hasMoreOutputLines('s-page')).toBe(true)

    const olderPage = [makeUserItemsLine(900, 'older-A'), makeUserItemsLine(901, 'older-B')]
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(olderPage)
    const added = await loadOlderOutputLines('s-page')
    expect(added).toBe(2)
    // Cursor matches the oldest id from the first page (1000), not the live tail
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenLastCalledWith('s-page', OLDER_OUTPUT_PAGE_SIZE, 1000)
    // Older items prepended in DB order
    const items = outputItems['s-page']
    expect(items[0]).toMatchObject({ kind: 'userMessage', text: 'older-A' })
    expect(items[1]).toMatchObject({ kind: 'userMessage', text: 'older-B' })
    // hasMore flips off when the page comes back short
    expect(hasMoreOutputLines('s-page')).toBe(false)
  })

  test('is a no-op when the initial fetch returned fewer than the limit (no older pages)', async () => {
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce([makeUserItemsLine(1, 'only')])
    await loadOutputLines('s-short')
    expect(hasMoreOutputLines('s-short')).toBe(false)

    const added = await loadOlderOutputLines('s-short')
    expect(added).toBe(0)
    // Only the initial call — pagination didn't fire
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(1)
  })

  test('keeps fetching while each page returns a full window, walking the cursor backward', async () => {
    const fullPage = (startId: number) =>
      Array.from({ length: OLDER_OUTPUT_PAGE_SIZE }, (_, i) =>
        makeUserItemsLine(startId + i, `m-${startId + i}`),
      )

    // Initial page (ids 1000..1000+limit-1)
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(fullPage(1000))
    await loadOutputLines('s-walk')
    expect(hasMoreOutputLines('s-walk')).toBe(true)

    // First older page (ids 750..999) — full → still more
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(fullPage(1000 - OLDER_OUTPUT_PAGE_SIZE))
    await loadOlderOutputLines('s-walk')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenLastCalledWith(
      's-walk',
      OLDER_OUTPUT_PAGE_SIZE,
      1000,
    )
    expect(hasMoreOutputLines('s-walk')).toBe(true)

    // Second older page — cursor is now the new oldest id (1000 - limit)
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(fullPage(1000 - 2 * OLDER_OUTPUT_PAGE_SIZE))
    await loadOlderOutputLines('s-walk')
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenLastCalledWith(
      's-walk',
      OLDER_OUTPUT_PAGE_SIZE,
      1000 - OLDER_OUTPUT_PAGE_SIZE,
    )
  })

  test('an empty older page flips hasMore off without mutating items', async () => {
    const firstPage = Array.from({ length: INITIAL_OUTPUT_LINES_LIMIT }, (_, i) =>
      makeUserItemsLine(1000 + i, `m-${i}`),
    )
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-empty')
    const before = outputItems['s-empty'].length

    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce([])
    const added = await loadOlderOutputLines('s-empty')
    expect(added).toBe(0)
    expect(hasMoreOutputLines('s-empty')).toBe(false)
    expect(outputItems['s-empty'].length).toBe(before)
  })

  test('concurrent loadOlderOutputLines calls dedupe via the in-flight guard', async () => {
    const firstPage = Array.from({ length: INITIAL_OUTPUT_LINES_LIMIT }, (_, i) =>
      makeUserItemsLine(1000 + i, `m-${i}`),
    )
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-dedup')

    let resolveOlder: (lines: typeof firstPage) => void = () => {}
    const olderPromise = new Promise<typeof firstPage>(r => { resolveOlder = r })
    vi.mocked(ipc.getOutputLines).mockReturnValueOnce(olderPromise as Promise<typeof firstPage>)

    // Fire two concurrent calls — only the first should issue an IPC fetch
    const a = loadOlderOutputLines('s-dedup')
    const b = loadOlderOutputLines('s-dedup')

    // The second call short-circuits via the loading flag and returns 0
    expect(await b).toBe(0)
    // Only one ipc call queued so far (initial + this one)
    expect(vi.mocked(ipc.getOutputLines)).toHaveBeenCalledTimes(2)

    resolveOlder([makeUserItemsLine(900, 'older')])
    await a
  })

  test('clearOutputItems resets pagination so the next load refetches from the tail', async () => {
    const firstPage = Array.from({ length: INITIAL_OUTPUT_LINES_LIMIT }, (_, i) =>
      makeUserItemsLine(1000 + i, `m-${i}`),
    )
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-clear-pg')
    expect(hasMoreOutputLines('s-clear-pg')).toBe(true)

    await clearOutputItems('s-clear-pg')
    expect(hasMoreOutputLines('s-clear-pg')).toBe(false)

    // Re-load resets the cursor — older fetch shouldn't keep using the stale id
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-clear-pg')
    expect(hasMoreOutputLines('s-clear-pg')).toBe(true)
  })

  test('session-removed event drops pagination state', async () => {
    setSessions([makeSession({ id: 's-rm' })])
    const firstPage = Array.from({ length: INITIAL_OUTPUT_LINES_LIMIT }, (_, i) =>
      makeUserItemsLine(1000 + i, `m-${i}`),
    )
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce(firstPage)
    await loadOutputLines('s-rm')
    expect(hasMoreOutputLines('s-rm')).toBe(true)

    const fire = listenCallbacks.get('session-removed')!
    fire({ payload: { sessionId: 's-rm', taskId: 't-001' } })
    expect(hasMoreOutputLines('s-rm')).toBe(false)
  })
})

// Regression — pre-PR `loadOutputLines` summed every replayed turnEnd item's
// cost/tokens and overwrote the live store. After capping the initial replay
// at 250 lines, that overwrite would clobber the DB-seeded `totalCost` (set
// by `loadSessions`) with a partial sum, and seed `sessionTokens` with a
// partial sum. The fix: trust the DB seed for cost, and call the new
// `getSessionTokenTotals` IPC for full-session token totals.
describe('loadOutputLines preserves session aggregates after 250-line cap', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
    setSessionCosts({})
    setSessionTokens({})
    vi.mocked(ipc.getOutputLines).mockReset()
    vi.mocked(ipc.getOutputLines).mockResolvedValue([])
    vi.mocked(ipc.getSessionTokenTotals).mockReset()
    vi.mocked(ipc.getSessionTokenTotals).mockResolvedValue({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('does not overwrite the DB-seeded session cost with a partial replay sum', async () => {
    setSessionCosts('s-cost', 12.5) // simulating loadSessions seed from totalCost
    // Replay returns ONE turnEnd worth $0.10 — pre-fix this would overwrite the seed.
    vi.mocked(ipc.getOutputLines).mockResolvedValueOnce([
      {
        id: 1,
        sessionId: 's-cost',
        line: JSON.stringify({
          type: 'verun_items',
          items: [{ kind: 'turnEnd', status: 'completed', cost: 0.1, inputTokens: 1, outputTokens: 1 }],
        }),
        emittedAt: 1,
      },
    ])
    await loadOutputLines('s-cost')
    expect(sessionCosts['s-cost']).toBe(12.5)
  })

  test('seeds sessionTokens from getSessionTokenTotals (full-session aggregate)', async () => {
    vi.mocked(ipc.getSessionTokenTotals).mockResolvedValueOnce({
      input: 1000,
      output: 500,
      cacheRead: 100,
      cacheWrite: 50,
    })
    await loadOutputLines('s-tokens')
    expect(ipc.getSessionTokenTotals).toHaveBeenCalledWith('s-tokens')
    expect(sessionTokens['s-tokens']).toEqual({ input: 1000, output: 500, cacheRead: 100, cacheWrite: 50 })
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

describe('reopenSession', () => {
  beforeAll(async () => {
    await initSessionListeners()
  })

  beforeEach(() => {
    setSessions([])
    setOutputItems({})
    vi.mocked(ipc.reopenSession).mockReset()
  })

  test('adds the restored session back into the store', async () => {
    const s = makeSession({ id: 's-reopen', taskId: 't-001', status: 'idle' })
    vi.mocked(ipc.reopenSession).mockResolvedValue(s)
    await reopenSession('s-reopen')
    expect(sessions.filter(x => x.id === 's-reopen').length).toBe(1)
  })

  test('does not double-insert when session-created broadcast races the IPC', async () => {
    const s = makeSession({ id: 's-race-reopen', taskId: 't-001', status: 'idle' })
    vi.mocked(ipc.reopenSession).mockImplementation(async () => {
      listenCallbacks.get('session-created')!({ payload: s })
      return s
    })
    await reopenSession('s-race-reopen')
    expect(sessions.filter(x => x.id === 's-race-reopen').length).toBe(1)
  })
})
