import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'

// "Retry in new session" on a failed turn starts a session like the failed one -
// the same harness and the same account, explicitly, so a project that moves to
// another account later does not move it - and sends the turn's message to it.
// When the session cannot be started the user is told, and nothing is sent.
const ipc = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
}))
vi.mock('../lib/ipc', () => ipc)

import { ErrorBlockView } from './ChatView'
import { setSessions } from '../store/sessions'
import { selectedSessionForTask } from '../store/taskContext'
import { setToasts, toasts } from '../store/ui'
import type { OutputItem, Session } from '../types'

const failed: Session = {
  id: 's-001',
  taskId: 't-001',
  name: null,
  resumeSessionId: null,
  status: 'idle',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  parentSessionId: null,
  forkedAtMessageUuid: null,
  agentType: 'claude',
  model: 'opus',
  closedAt: null,
  accountId: 'a1',
}

const output: OutputItem[] = [
  { kind: 'userMessage', text: 'Fix the bug' },
  { kind: 'errorMessage', message: 'Rate limited' },
]

const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'

/** Shows the failed turn of `s-001` and presses "Retry in new session". */
async function retryInNewSession() {
  render(() => (
    <ErrorBlockView message="Rate limited" turnIndex={1} output={output} sessionId="s-001" taskId="t-001" agentType="claude" model="opus" />
  ))
  fireEvent.click(screen.getByRole('button', { name: /Retry in new session/ }))
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  ipc.createSession.mockReset()
  ipc.sendMessage.mockReset()
  ipc.createSession.mockResolvedValue({ ...failed, id: 's-002', accountId: null })
  ipc.sendMessage.mockResolvedValue(undefined)
  setSessions([failed])
  setToasts([])
})

afterEach(() => cleanup())

describe('Retry in new session', () => {
  test('starts the new session on the account of the failed one', async () => {
    await retryInNewSession()

    expect(ipc.createSession).toHaveBeenCalledOnce()
    expect(ipc.createSession).toHaveBeenCalledWith('t-001', 'claude', 'opus', { kind: 'account', id: 'a1' })
  })

  test('a failed session on Default starts the new one on Default, whatever the project uses', async () => {
    setSessions([{ ...failed, accountId: null }])

    await retryInNewSession()

    expect(ipc.createSession).toHaveBeenCalledWith('t-001', 'claude', 'opus', { kind: 'default' })
  })

  test('a failed session the store no longer has leaves the account to the project', async () => {
    setSessions([])

    await retryInNewSession()

    expect(ipc.createSession).toHaveBeenCalledWith('t-001', 'claude', 'opus', undefined)
  })

  test('shows the new session and sends it the message of the turn', async () => {
    await retryInNewSession()

    expect(selectedSessionForTask('t-001')).toBe('s-002')
    expect(ipc.sendMessage).toHaveBeenCalledOnce()
    expect(ipc.sendMessage.mock.calls[0].slice(0, 2)).toEqual(['s-002', 'Fix the bug'])
    expect(toasts()).toEqual([])
  })

  test('an account that cannot be used is shown as its toast, with nothing sent', async () => {
    ipc.createSession.mockRejectedValue(removed)

    await retryInNewSession()

    expect(toasts().map((t) => ({ title: t.title, message: t.message }))).toEqual([
      { title: 'Account removed', message: 'Acme was removed. Start a new session on another account.' },
    ])
    expect(ipc.sendMessage).not.toHaveBeenCalled()
    // The button is back for another try.
    expect((screen.getByRole('button', { name: /Retry in new session/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
