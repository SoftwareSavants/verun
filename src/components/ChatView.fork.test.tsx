import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'

// Forking from a message starts a session (in this task) or a whole task (new
// worktree) on the parent's accounts. A project whose accounts can't be read
// fails the fork with an account error. The fork menu says so in words, with the
// account toast that leads to the fix, and never prints the raw error string.
const ipc = vi.hoisted(() => ({
  forkSessionInTask: vi.fn(),
  forkSessionToNewTask: vi.fn(),
}))
vi.mock('../lib/ipc', () => ipc)

import { ForkButton } from './ChatView'
import { setSessions } from '../store/sessions'
import { setTasks } from '../store/tasks'
import { toasts, setToasts } from '../store/ui'
import type { Session, Task } from '../types'

const secret = 'ACCOUNT_ERROR:{"kind":"secret","accountId":"a1","label":"Acme","projects":[],"message":"ANTHROPIC_API_KEY has no stored value"}'

const task: Task = {
  id: 't-001',
  projectId: 'p-001',
  name: null,
  worktreePath: '/tmp/wt',
  branch: 'feature',
  createdAt: 1000,
  mergeBaseSha: null,
  portOffset: 0,
  archived: false,
  archivedAt: null,
  lastCommitMessage: null,
  parentTaskId: null,
  agentType: 'claude',
}

const session: Session = {
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
  model: null,
  closedAt: null,
  accountId: 'a1',
}

/** Opens the fork menu of the message and picks an entry, the way a user does. */
function openMenu() {
  render(() => <ForkButton sessionId="s-001" messageUuid="m-001" />)
  fireEvent.click(screen.getByTitle('Fork from this message'))
}

function forkToNewTask(which: 'Code as of this message' | 'Current code') {
  fireEvent.click(screen.getByText('Fork in a new task'))
  fireEvent.click(screen.getByText(which))
}

beforeEach(() => {
  ipc.forkSessionInTask.mockReset()
  ipc.forkSessionToNewTask.mockReset()
  setTasks([task])
  setSessions([session])
  setToasts([])
})

afterEach(() => cleanup())

describe('ForkButton', () => {
  test('a fork to a new task that an account problem stopped says so in words, with its toast', async () => {
    ipc.forkSessionToNewTask.mockRejectedValue(secret)
    openMenu()

    forkToNewTask('Current code')

    await screen.findByText("Couldn't read a secret for Acme from the keychain.")
    expect(ipc.forkSessionToNewTask).toHaveBeenCalledWith('s-001', 'm-001', 'current')
    expect(screen.queryByText(/ACCOUNT_ERROR/)).toBeNull()
    expect(toasts().map(t => ({ title: t.title, message: t.message }))).toEqual([
      { title: 'Keychain error', message: "Couldn't read a secret for Acme from the keychain." },
    ])
  })

  test('so does a fork of the code as of the message', async () => {
    ipc.forkSessionToNewTask.mockRejectedValue(secret)
    openMenu()

    forkToNewTask('Code as of this message')

    await screen.findByText("Couldn't read a secret for Acme from the keychain.")
    expect(ipc.forkSessionToNewTask).toHaveBeenCalledWith('s-001', 'm-001', 'snapshot')
  })

  test('so does a fork in this task, whatever reaches it', async () => {
    ipc.forkSessionInTask.mockRejectedValue('ACCOUNT_ERROR:{"kind":"missing","accountId":"a1","label":null,"projects":[],"message":null}')
    openMenu()

    fireEvent.click(screen.getByText('Fork in this task'))

    await screen.findByText('Something is wrong with this account.')
    expect(screen.queryByText(/ACCOUNT_ERROR/)).toBeNull()
    expect(toasts().map(t => t.title)).toEqual(['Account error'])
  })

  test('a signed-out account offers Log in from the toast', async () => {
    ipc.forkSessionToNewTask.mockRejectedValue('ACCOUNT_ERROR:{"kind":"signedOut","accountId":"a1","label":"Acme","projects":[],"message":null}')
    openMenu()

    forkToNewTask('Current code')

    await screen.findByText('Acme is signed out.')
    expect(toasts()[0].actions?.map(a => a.label)).toEqual(['Log in'])
  })

  test('any other failure keeps its own text and raises no toast', async () => {
    ipc.forkSessionToNewTask.mockRejectedValue('Task t-001 not found')
    openMenu()

    forkToNewTask('Current code')

    await screen.findByText('Task t-001 not found')
    expect(toasts()).toEqual([])
  })

  test('the menu can be tried again after a failure', async () => {
    ipc.forkSessionToNewTask.mockRejectedValueOnce(secret)
    openMenu()
    forkToNewTask('Current code')
    await screen.findByText("Couldn't read a secret for Acme from the keychain.")

    ipc.forkSessionToNewTask.mockReturnValueOnce(new Promise(() => {}))
    fireEvent.click(screen.getByText('Current code'))

    await waitFor(() => expect(ipc.forkSessionToNewTask).toHaveBeenCalledTimes(2))
  })
})
