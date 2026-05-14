import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createRoot } from 'solid-js'

// Resolver-controlled mock so we can observe in-flight state. `vi.hoisted`
// is required because `vi.mock` factories are hoisted above module-level
// code — using a closure variable directly would hit a TDZ error.
const mocks = vi.hoisted(() => {
  const state: {
    pendingResolve: ((v: import('../types').SideQuestionResponse | null) => void) | null
    pendingReject: ((e: unknown) => void) | null
  } = { pendingResolve: null, pendingReject: null }
  return {
    state,
    askSideQuestion: vi.fn(() =>
      new Promise<import('../types').SideQuestionResponse | null>((resolve, reject) => {
        state.pendingResolve = resolve
        state.pendingReject = reject
      }),
    ),
  }
})

vi.mock('../lib/ipc', () => ({
  askSideQuestion: mocks.askSideQuestion,
}))

// Import after the mock is registered.
import {
  closeSideQuestion,
  dismissSideQuestionUnread,
  getRememberedSideQuestion,
  openSideQuestion,
  sideQuestionState,
  submitSideQuestion,
} from './sideQuestion'

function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('sideQuestion store', () => {
  beforeEach(() => {
    mocks.state.pendingResolve = null
    mocks.state.pendingReject = null
    mocks.askSideQuestion.mockClear()
    closeSideQuestion()
  })

  test('submitSideQuestion sets loading=true synchronously and clears unread', () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'hi')
    expect(sideQuestionState(sid)?.loading).toBe(true)
    expect(sideQuestionState(sid)?.question).toBe('hi')
    expect(sideQuestionState(sid)?.unread).toBe(false)
    expect(sideQuestionState(sid)?.answer).toBeUndefined()
  })

  test('loading persists past closeSideQuestion (background request continues)', () => {
    const sid = `s-${Math.random()}`
    openSideQuestion(sid)
    submitSideQuestion(sid, 'hi')
    closeSideQuestion()
    expect(sideQuestionState(sid)?.loading).toBe(true)
  })

  test('answer while panel closed marks unread=true and loading=false', async () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'q')
    // Panel never opened for this session — answer arrives "while closed".
    mocks.state.pendingResolve!({ response: 'A', synthetic: false })
    await nextTick()
    const s = sideQuestionState(sid)
    expect(s?.loading).toBe(false)
    expect(s?.answer).toEqual({ response: 'A', synthetic: false })
    expect(s?.unread).toBe(true)
  })

  test('answer while panel open for this session does NOT mark unread', async () => {
    const sid = `s-${Math.random()}`
    openSideQuestion(sid)
    submitSideQuestion(sid, 'q')
    mocks.state.pendingResolve!({ response: 'A', synthetic: false })
    await nextTick()
    expect(sideQuestionState(sid)?.unread).toBe(false)
  })

  test('error while panel closed also marks unread=true', async () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'q')
    mocks.state.pendingReject!(new Error('boom'))
    await nextTick()
    const s = sideQuestionState(sid)
    expect(s?.loading).toBe(false)
    expect(s?.error).toBe('boom')
    expect(s?.unread).toBe(true)
  })

  test('dismissSideQuestionUnread clears unread but keeps answer', async () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'q')
    mocks.state.pendingResolve!({ response: 'A', synthetic: false })
    await nextTick()
    expect(sideQuestionState(sid)?.unread).toBe(true)
    dismissSideQuestionUnread(sid)
    expect(sideQuestionState(sid)?.unread).toBe(false)
    expect(sideQuestionState(sid)?.answer).toEqual({ response: 'A', synthetic: false })
  })

  test('opening panel for an unread session clears unread', async () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'q')
    mocks.state.pendingResolve!({ response: 'A', synthetic: false })
    await nextTick()
    expect(sideQuestionState(sid)?.unread).toBe(true)
    openSideQuestion(sid)
    expect(sideQuestionState(sid)?.unread).toBe(false)
  })

  test('sideQuestionState reads are reactive inside createRoot', async () => {
    const sid = `s-${Math.random()}`
    const seen: (boolean | undefined)[] = []
    createRoot(dispose => {
      // Touch the field; createMemo/createEffect would track this. Using a
      // bare read inside createRoot is enough to register a dependency when
      // wrapped in an effect — but we just want to confirm transitions are
      // observable without errors.
      seen.push(sideQuestionState(sid)?.loading)
      submitSideQuestion(sid, 'q')
      seen.push(sideQuestionState(sid)?.loading)
      dispose()
    })
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBe(true)
  })

  test('getRememberedSideQuestion is backward-compatible with existing callers', async () => {
    const sid = `s-${Math.random()}`
    submitSideQuestion(sid, 'hello')
    expect(getRememberedSideQuestion(sid)?.question).toBe('hello')
    mocks.state.pendingResolve!({ response: 'world', synthetic: false })
    await nextTick()
    expect(getRememberedSideQuestion(sid)?.answer).toEqual({ response: 'world', synthetic: false })
  })
})
