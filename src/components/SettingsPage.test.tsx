import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'

// The Accounts section sits between Appearance and the projects: in the nav,
// and on Cmd+3 (Cmd+1 General, Cmd+2 Appearance, Cmd+4 and up the projects).
// Opening Settings re-reads the accounts, and a project's page lists the accounts
// its new sessions can use between the repository and the hooks.
const mocks = vi.hoisted(() => ({ listAccounts: vi.fn() }))
vi.mock('../lib/ipc', () => ({ listAccounts: mocks.listAccounts }))
vi.mock('../store/tasks', () => ({ createTask: vi.fn(), activeTasksForProject: () => [] }))
vi.mock('../store/sessions', () => ({ sendMessage: vi.fn(), setSessions: vi.fn(), setOutputItems: vi.fn() }))
vi.mock('../lib/notifications', () => ({ notificationsEnabled: () => false, setNotificationsEnabledAndPersist: vi.fn() }))
vi.mock('./CodeTextarea', () => ({ CodeTextarea: () => null }))
vi.mock('./StorageSettings', () => ({ StorageSettings: () => null }))
vi.mock('./ClaudeDefaultViewPicker', () => ({ ClaudeDefaultViewPicker: () => null }))
vi.mock('./AccountsSettings', () => ({
  AccountsSettings: () => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'accounts-settings')
    return el
  },
}))
vi.mock('./DictationSettings', () => ({
  DictationSettings: () => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'dictation-settings')
    return el
  },
}))
// Dictation shows only where it is supported (Apple Silicon); off unless a test turns it on.
vi.mock('../store/voice', async () => {
  const { createSignal } = await import('solid-js')
  const [available, setAvailable] = createSignal(false)
  return { dictationAvailable: available, __setAvailable: setAvailable }
})
vi.mock('./ProjectAccountsSettings', async () => {
  const { createEffect } = await import('solid-js')
  return {
    ProjectAccountsSettings: (props: { projectId: string }) => {
      const el = document.createElement('div')
      el.setAttribute('data-testid', 'project-accounts')
      createEffect(() => el.setAttribute('data-project-id', props.projectId))
      return el
    },
  }
})

import { SettingsPage, selectSettingsSection, settingsSectionForShortcut } from './SettingsPage'
import { setProjects } from '../store/projects'
import { openSettings, setShowSettings, setSettingsSectionRequest } from '../store/ui'
import type { Project } from '../types'
import * as voiceStore from '../store/voice'

const setDictationAvailable = (voiceStore as unknown as { __setAvailable: (v: boolean) => void }).__setAvailable

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

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mocks.listAccounts.mockReset()
  mocks.listAccounts.mockResolvedValue({ accounts: [], defaults: [], projectAccounts: [] })
  setProjects([project])
  setShowSettings(false)
  setSettingsSectionRequest(null)
  selectSettingsSection('general')
  setDictationAvailable(false)
})

afterEach(() => cleanup())

describe('settingsSectionForShortcut', () => {
  test('maps settings shortcuts with Accounts third', () => {
    expect(settingsSectionForShortcut(1, ['p1'])).toBe('general')
    expect(settingsSectionForShortcut(2, ['p1'])).toBe('appearance')
    expect(settingsSectionForShortcut(3, ['p1'])).toBe('accounts')
    expect(settingsSectionForShortcut(4, ['p1'])).toBe('p1')
    expect(settingsSectionForShortcut(5, ['p1'])).toBeNull()
  })

  test('the projects follow in the order of the nav', () => {
    const ids = ['p1', 'p2', 'p3']

    expect([4, 5, 6].map((digit) => settingsSectionForShortcut(digit, ids))).toEqual(['p1', 'p2', 'p3'])
    expect(settingsSectionForShortcut(7, ids)).toBeNull()
  })

  test('the built-in sections are there without projects', () => {
    expect(settingsSectionForShortcut(3, [])).toBe('accounts')
    expect(settingsSectionForShortcut(4, [])).toBeNull()
  })

  test('Dictation has no Cmd+digit, so the numbers never shift when it is supported', () => {
    const digits = [1, 2, 3, 4, 5, 6]
    const before = digits.map((digit) => settingsSectionForShortcut(digit, ['p1', 'p2']))
    setDictationAvailable(true)
    const after = digits.map((digit) => settingsSectionForShortcut(digit, ['p1', 'p2']))

    expect(after).toEqual(['general', 'appearance', 'accounts', 'p1', 'p2', null])
    expect(after).toEqual(before)
  })

  test('a digit that is no key maps to nothing', () => {
    expect(settingsSectionForShortcut(0, ['p1'])).toBeNull()
    expect(settingsSectionForShortcut(-1, ['p1'])).toBeNull()
    expect(settingsSectionForShortcut(Number.NaN, ['p1'])).toBeNull()
  })
})

describe('SettingsPage Dictation section', () => {
  const navLabels = () => screen
    .getAllByRole('button')
    .map((b) => b.textContent)
    .filter((text) => ['General', 'Appearance', 'Accounts', 'Dictation', 'my-app'].includes(text ?? ''))

  test('is hidden where dictation is not supported', () => {
    render(() => <SettingsPage />)
    expect(navLabels()).toEqual(['General', 'Appearance', 'Accounts', 'my-app'])
    expect(settingsSectionForShortcut(4, [project.id])).toBe(project.id)
  })

  test('sits after Accounts and opens the dictation settings, titled Dictation', () => {
    setDictationAvailable(true)
    render(() => <SettingsPage />)
    expect(navLabels()).toEqual(['General', 'Appearance', 'Accounts', 'Dictation', 'my-app'])

    fireEvent.click(screen.getByRole('button', { name: 'Dictation' }))

    expect(title()).toBe('Dictation')
    expect(screen.getByTestId('dictation-settings')).toBeTruthy()
    expect(screen.queryByText('Lifecycle Hooks')).toBeNull()
  })

  test('it has no shortcut: Cmd+4 still opens the first project; the nav opens Dictation', () => {
    setDictationAvailable(true)
    render(() => <SettingsPage />)

    expect(settingsSectionForShortcut(4, [project.id])).toBe(project.id)
    fireEvent.click(screen.getByRole('button', { name: 'Dictation' }))

    expect(title()).toBe('Dictation')
  })
})

describe('SettingsPage Accounts section', () => {
  test('the nav lists Accounts between Appearance and the projects', () => {
    render(() => <SettingsPage />)

    const nav = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((text) => ['General', 'Appearance', 'Accounts', 'my-app'].includes(text ?? ''))
    expect(nav).toEqual(['General', 'Appearance', 'Accounts', 'my-app'])
  })

  test('opens the accounts, titled Accounts', () => {
    render(() => <SettingsPage />)
    expect(screen.queryByTestId('accounts-settings')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }))

    expect(title()).toBe('Accounts')
    expect(screen.getByTestId('accounts-settings')).toBeTruthy()
  })

  test('shows no project settings, even with projects', () => {
    render(() => <SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }))

    expect(screen.queryByText('Lifecycle Hooks')).toBeNull()
    expect(screen.queryByText('Repository')).toBeNull()
  })

  test('leaving Accounts takes the accounts away again', () => {
    render(() => <SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }))

    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    expect(title()).toBe('General')
    expect(screen.queryByTestId('accounts-settings')).toBeNull()
  })

  test('the section shortcut opens it', () => {
    render(() => <SettingsPage />)

    selectSettingsSection(settingsSectionForShortcut(3, [project.id])!)

    expect(title()).toBe('Accounts')
    expect(screen.getByTestId('accounts-settings')).toBeTruthy()
  })

  test('an account toast sends the user here', () => {
    render(() => <SettingsPage />)

    // What the "Log in" and "Choose account" buttons of an account toast do.
    openSettings('accounts')

    expect(title()).toBe('Accounts')
    expect(screen.getByTestId('accounts-settings')).toBeTruthy()
  })

  test('a request made before the page was open shows it too', () => {
    openSettings('accounts')

    render(() => <SettingsPage />)

    expect(title()).toBe('Accounts')
  })

  test('a project is still a section of its own', () => {
    render(() => <SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'my-app' }))

    expect(title()).toBe('my-app')
    expect(screen.queryByTestId('accounts-settings')).toBeNull()
    expect(screen.getByText('Lifecycle Hooks')).toBeTruthy()
  })
})

describe('SettingsPage reads the accounts', () => {
  test('when Settings opens, so every identity is fresh', async () => {
    render(() => <SettingsPage />)
    await flush()

    expect(mocks.listAccounts).toHaveBeenCalledOnce()
  })

  test('once for the opening, not again for each section', async () => {
    render(() => <SettingsPage />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }))
    fireEvent.click(screen.getByRole('button', { name: 'my-app' }))
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    await flush()

    expect(mocks.listAccounts).toHaveBeenCalledOnce()
  })
})

describe('SettingsPage project Accounts', () => {
  const projectAccounts = () => screen.queryByTestId('project-accounts')

  test('a project lists its accounts after the repository and before the hooks', () => {
    render(() => <SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'my-app' }))

    const section = screen.getByTestId('project-accounts')
    expect(section.getAttribute('data-project-id')).toBe('p-001')
    expect(screen.getByText('Repository').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(section.compareDocumentPosition(screen.getByText('Lifecycle Hooks')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('hands over the project that is shown', () => {
    setProjects([project, { ...project, id: 'p-002', name: 'other-app' }])
    render(() => <SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'my-app' }))
    expect(projectAccounts()?.getAttribute('data-project-id')).toBe('p-001')
    fireEvent.click(screen.getByRole('button', { name: 'other-app' }))

    expect(projectAccounts()?.getAttribute('data-project-id')).toBe('p-002')
  })

  test('is a part of a project, not of the other sections', () => {
    render(() => <SettingsPage />)

    for (const name of ['General', 'Appearance', 'Accounts']) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(projectAccounts(), name).toBeNull()
    }
  })
})
