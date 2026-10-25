import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@solidjs/testing-library'

// Other parts of the app send the user to a section of Settings with
// `openSettings(section)` (an account toast's "Log in" goes to Accounts). The
// page takes the request, selects the section and clears the request so the same
// section can be asked for again. A project's id stands in for the section here:
// it is a real section today, and the page names it in its header.
// Settings reads the accounts when it opens.
vi.mock('../lib/ipc', () => ({ listAccounts: vi.fn(() => Promise.resolve({ accounts: [], defaults: [], projectAccounts: [] })) }))
vi.mock('../store/tasks', () => ({ createTask: vi.fn(), activeTasksForProject: () => [] }))
vi.mock('../store/sessions', () => ({ sendMessage: vi.fn(), setSessions: vi.fn(), setOutputItems: vi.fn() }))
vi.mock('../lib/notifications', () => ({ notificationsEnabled: () => false, setNotificationsEnabledAndPersist: vi.fn() }))
vi.mock('./CodeTextarea', () => ({ CodeTextarea: () => null }))
vi.mock('./StorageSettings', () => ({ StorageSettings: () => null }))
vi.mock('./ClaudeDefaultViewPicker', () => ({ ClaudeDefaultViewPicker: () => null }))

import { SettingsPage, selectSettingsSection } from './SettingsPage'
import { setProjects } from '../store/projects'
import { openSettings, setShowSettings, settingsSectionRequest, setSettingsSectionRequest } from '../store/ui'
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

/** The page's title: the section it is showing. */
const title = () => screen.getByRole('heading', { level: 1 }).textContent

beforeEach(() => {
  setProjects([project])
  setShowSettings(false)
  setSettingsSectionRequest(null)
  selectSettingsSection('general')
})

afterEach(() => cleanup())

describe('SettingsPage section requests', () => {
  test('selects the requested section and clears the request', () => {
    render(() => <SettingsPage />)
    expect(title()).toBe('General')

    openSettings('p-001')

    expect(title()).toBe('my-app')
    expect(settingsSectionRequest()).toBeNull()
  })

  test('takes a request made before the page was open', () => {
    openSettings('p-001')
    expect(settingsSectionRequest()).toBe('p-001')

    render(() => <SettingsPage />)

    expect(title()).toBe('my-app')
    expect(settingsSectionRequest()).toBeNull()
  })

  test('selects the section again when it is asked for again', () => {
    render(() => <SettingsPage />)
    openSettings('p-001')
    selectSettingsSection('general')
    expect(title()).toBe('General')

    openSettings('p-001')

    expect(title()).toBe('my-app')
  })

  test('opening Settings with no section leaves the page where it was', () => {
    render(() => <SettingsPage />)
    selectSettingsSection('p-001')

    openSettings()

    expect(title()).toBe('my-app')
  })
})
