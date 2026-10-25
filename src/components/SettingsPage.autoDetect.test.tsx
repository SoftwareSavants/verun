import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library'

// A project's "Auto-detect" button creates a task and sends it the auto-detect
// prompt. Its success toast must not appear when the send was blocked by an
// account problem (sendMessage resolves false after showing its own toast), and
// an account problem creating the task gets the account toast, not the raw error.
const mocks = vi.hoisted(() => ({ createTask: vi.fn(), sendMessage: vi.fn() }))
// Settings reads the accounts when it opens.
vi.mock('../lib/ipc', () => ({ listAccounts: vi.fn(() => Promise.resolve({ accounts: [], defaults: [], projectAccounts: [] })) }))
vi.mock('../store/tasks', () => ({ createTask: mocks.createTask, activeTasksForProject: () => [] }))
vi.mock('../store/sessions', () => ({ sendMessage: mocks.sendMessage, setSessions: vi.fn(), setOutputItems: vi.fn() }))
vi.mock('../lib/notifications', () => ({ notificationsEnabled: () => false, setNotificationsEnabledAndPersist: vi.fn() }))
vi.mock('./CodeTextarea', () => ({ CodeTextarea: () => null }))
vi.mock('./StorageSettings', () => ({ StorageSettings: () => null }))
vi.mock('./ClaudeDefaultViewPicker', () => ({ ClaudeDefaultViewPicker: () => null }))

import { SettingsPage, selectSettingsSection } from './SettingsPage'
import { setProjects } from '../store/projects'
import { toasts, setToasts, setShowSettings } from '../store/ui'
import type { Project } from '../types'

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

const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'

/** What the toasts say, as `type: message`. */
const shown = () => toasts().map(t => `${t.type}: ${t.message}`)

function autoDetect() {
  selectSettingsSection('p-001')
  render(() => <SettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: /Auto-detect/ }))
}

beforeEach(() => {
  setProjects([project])
  setToasts([])
  setShowSettings(true)
  mocks.createTask.mockReset()
  mocks.sendMessage.mockReset()
  mocks.createTask.mockResolvedValue({ task: { id: 't-001' }, session: { id: 's-001' } })
})

afterEach(() => cleanup())

describe('SettingsPage auto-detect', () => {
  test('says the task was created once the analysis prompt was sent', async () => {
    mocks.sendMessage.mockResolvedValue(true)

    autoDetect()

    await waitFor(() => expect(shown()).toEqual(['success: Created auto-detect task for my-app']))
    expect(mocks.sendMessage).toHaveBeenCalledWith('s-001', expect.stringContaining('/tmp/my-app'))
  })

  test('does not say so when the send was blocked by an account problem', async () => {
    mocks.sendMessage.mockResolvedValue(false)

    autoDetect()

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce())
    await Promise.resolve()
    // sendMessage has shown the account toast; this page adds neither a success nor an error.
    expect(shown()).toEqual([])
  })

  test('an account problem creating the task gets the account toast, not the raw error', async () => {
    mocks.createTask.mockRejectedValue(removed)

    autoDetect()

    await waitFor(() => expect(shown()).toEqual(['error: Acme was removed. Start a new session on another account.']))
    expect(toasts()[0].title).toBe('Account removed')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  test('other failures show their own text', async () => {
    mocks.createTask.mockRejectedValue('Project p-001 not found')

    autoDetect()

    await waitFor(() => expect(shown()).toEqual(['error: Project p-001 not found']))
  })
})
