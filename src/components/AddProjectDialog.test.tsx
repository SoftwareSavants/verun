import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'
import type { Project } from '../types'

// "Detect" creates a task that analyzes the project and sends it the
// auto-detect prompt. What it tells the user depends on how that went: the
// success toast must not appear when the send was blocked by an account problem
// (sendMessage resolves false after showing its own toast), and an account
// problem creating the task gets the account toast, not the raw error string.
const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  sendMessage: vi.fn(),
  addToast: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ readTextFile: vi.fn(() => Promise.reject(new Error('no .verun.json'))) }))
vi.mock('../store/projects', () => ({ addProject: vi.fn(), updateHooks: vi.fn() }))
vi.mock('../store/tasks', () => ({ createTask: mocks.createTask }))
vi.mock('../store/sessions', () => ({ sendMessage: mocks.sendMessage, setSessions: vi.fn(), setOutputItems: vi.fn() }))
vi.mock('../store/ui', () => ({
  addToast: mocks.addToast,
  openSettings: vi.fn(),
  setSelectedProjectId: vi.fn(),
  setSelectedTaskId: vi.fn(),
  setSelectedSessionIdForTask: vi.fn(),
  setShowSettings: vi.fn(),
}))
vi.mock('./CodeTextarea', () => ({ CodeTextarea: () => null }))

import { AddProjectDialog } from './AddProjectDialog'

const project: Project = {
  id: 'p-001',
  name: 'my-app',
  repoPath: '/tmp/my-app',
  baseBranch: 'main',
  setupHook: '',
  destroyHook: '',
  startCommand: '',
  autoStart: false,
  createdAt: 1000,
  defaultAgentType: 'claude',
}

const SUCCESS = 'Hooks will be saved automatically when analysis completes'
const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'

const toastsOfType = (type: string) => mocks.addToast.mock.calls.filter(call => call[1] === type).map(call => call[0])

function detect() {
  render(() => <AddProjectDialog open repoPath={null} existingProject={project} onClose={() => {}} onAdded={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
}

beforeEach(() => {
  mocks.createTask.mockReset()
  mocks.sendMessage.mockReset()
  mocks.addToast.mockReset()
  mocks.createTask.mockResolvedValue({ task: { id: 't-001' }, session: { id: 's-001' } })
})

afterEach(() => cleanup())

describe('AddProjectDialog auto-detect', () => {
  test('says the hooks will be saved once the analysis prompt was sent', async () => {
    mocks.sendMessage.mockResolvedValue(true)

    detect()

    await waitFor(() => expect(toastsOfType('success')).toEqual([SUCCESS]))
    expect(mocks.sendMessage).toHaveBeenCalledWith('s-001', expect.stringContaining('/tmp/my-app'))
  })

  test('does not say so when the send was blocked by an account problem', async () => {
    mocks.sendMessage.mockResolvedValue(false)

    detect()

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce())
    await Promise.resolve()
    // sendMessage has shown the account toast; this adds neither a success nor an error.
    expect(mocks.addToast).not.toHaveBeenCalled()
  })

  test('an account problem creating the task gets the account toast, not the raw error', async () => {
    mocks.createTask.mockRejectedValue(removed)

    detect()

    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledOnce())
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Acme was removed. Start a new session on another account.',
      'error',
      expect.objectContaining({ title: 'Account removed' }),
    )
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    // Detect can be tried again.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement).disabled).toBe(false))
  })

  test('other failures show their own text', async () => {
    mocks.createTask.mockRejectedValue('Project p-001 not found')

    detect()

    await waitFor(() => expect(toastsOfType('error')).toEqual(['Project p-001 not found']))
  })
})
