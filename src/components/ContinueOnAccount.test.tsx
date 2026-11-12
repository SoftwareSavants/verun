import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'

const fork = vi.hoisted(() => ({ continueOnAccount: vi.fn() }))
vi.mock('../store/fork', () => fork)

import { ContinueOnAccount } from './ContinueOnAccount'
import { setSessions } from '../store/sessions'
import { setTasks } from '../store/tasks'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeSnapshot } from '../test/accountFixtures'
import type { Session, Task } from '../types'

const task = { id: 't1', projectId: 'p1', agentType: 'claude' } as Task
const session = { id: 's1', taskId: 't1', agentType: 'claude', accountId: 'a1', model: null } as Session

beforeEach(() => {
  fork.continueOnAccount.mockReset().mockResolvedValue({ id: 's2' })
  setTasks([task])
  setSessions([session])
})
afterEach(() => cleanup())

describe('ContinueOnAccount', () => {
  test('offers every other account and carries the session over to the one picked', async () => {
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'a1', label: 'Acme' }), makeAccount({ id: 'a2', label: 'Beta' })] }))
    render(() => <ContinueOnAccount sessionId="s1" message="continue" />)
    expect(screen.queryByRole('button', { name: 'Continue on Acme' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Beta' }))
    await waitFor(() => expect(fork.continueOnAccount).toHaveBeenCalledWith('s1', { accountId: 'a2' }, 'continue', null))
    expect(screen.getByRole('button', { name: 'Continue on Default' })).toBeTruthy()
  })

  test('shows nothing without another account to go to', () => {
    applySnapshot(makeSnapshot())
    const { container } = render(() => <ContinueOnAccount sessionId="s1" message="continue" />)
    expect(container.textContent).toBe('')
  })
})

describe('the usage-limit error in chat', () => {
  test('offers to continue on another account; other errors do not', async () => {
    const { ErrorBlockView } = await import('./ChatView')
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'a1', label: 'Acme' }), makeAccount({ id: 'a2', label: 'Beta' })] }))
    const raw = JSON.stringify({ type: 'assistant', error: 'rate_limit' })
    render(() => <ErrorBlockView message="You've hit your limit · resets 5pm" raw={raw} retryText="fix it" sessionId="s1" taskId="t1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Beta' }))
    await waitFor(() => expect(fork.continueOnAccount).toHaveBeenCalledWith('s1', { accountId: 'a2' }, 'fix it', null))
    cleanup()
    render(() => <ErrorBlockView message="Prompt is too long" retryText="fix it" sessionId="s1" taskId="t1" />)
    expect(screen.queryByRole('button', { name: /Continue on/ })).toBeNull()
  })
})
