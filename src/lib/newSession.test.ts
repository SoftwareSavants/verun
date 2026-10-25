import { beforeEach, describe, expect, test, vi } from 'vitest'

// Starting a session from a picker, the new-session command or a retry: the
// session is created, brought up, and when that fails the user is told.
const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  setSelectedSessionIdForTask: vi.fn(),
  setMainView: vi.fn(),
}))

vi.mock('../store/sessions', () => ({ createSession: mocks.createSession }))
vi.mock('../store/editorView', () => ({ setMainView: mocks.setMainView }))
vi.mock('../store/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/ui')>()),
  setSelectedSessionIdForTask: mocks.setSelectedSessionIdForTask,
}))

import { openNewSession } from './newSession'
import { setToasts, toasts } from '../store/ui'

const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'

/** What the toasts say, as `type: message`. */
const shown = () => toasts().map((t) => `${t.type}: ${t.message}`)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createSession.mockResolvedValue({ id: 's-new' })
  setToasts([])
})

describe('openNewSession', () => {
  test('creates the session, selects it and shows its tab', async () => {
    const session = await openNewSession('t1', 'codex', 'gpt-5', { kind: 'account', id: 'a1' })

    expect(mocks.createSession).toHaveBeenCalledWith('t1', 'codex', 'gpt-5', { kind: 'account', id: 'a1' })
    expect(mocks.setSelectedSessionIdForTask).toHaveBeenCalledWith('t1', 's-new')
    expect(mocks.setMainView).toHaveBeenCalledWith('t1', 'session')
    expect(session).toEqual({ id: 's-new' })
    expect(shown()).toEqual([])
  })

  test('leaves the model and the account out when there are none', async () => {
    await openNewSession('t1', 'claude')

    expect(mocks.createSession).toHaveBeenCalledWith('t1', 'claude', undefined, undefined)
  })

  test('an account problem is shown as its toast, with the way to fix it, and nothing is selected', async () => {
    mocks.createSession.mockRejectedValue(removed)

    expect(await openNewSession('t1', 'claude', undefined, { kind: 'account', id: 'a1' })).toBeNull()

    expect(shown()).toEqual(['error: Acme was removed. Start a new session on another account.'])
    expect(toasts()[0].title).toBe('Account removed')
    expect(toasts()[0].actions?.map((a) => a.label)).toEqual(['Choose account'])
    expect(mocks.setSelectedSessionIdForTask).not.toHaveBeenCalled()
    expect(mocks.setMainView).not.toHaveBeenCalled()
  })

  test('any other failure is shown as it is', async () => {
    mocks.createSession.mockRejectedValue('Task t1 not found')

    expect(await openNewSession('t1', 'claude')).toBeNull()

    expect(shown()).toEqual(['error: Task t1 not found'])
    expect(mocks.setSelectedSessionIdForTask).not.toHaveBeenCalled()
  })
})
