import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

// In Settings, Cmd+1..9 switches section. Which section a digit means is
// `settingsSectionForShortcut`'s to say (tested with SettingsPage); Layout hands
// it the digit and the projects in nav order, and opens what it answers.
const mocks = vi.hoisted(() => ({
  selectSettingsSection: vi.fn(),
  settingsSectionForShortcut: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('../lib/ipc', () => ({}))
vi.mock('../lib/useTaskShortcuts', () => ({ useTaskShortcuts: vi.fn() }))
vi.mock('../store/terminals', () => ({ hydrateTerminalsForTask: vi.fn() }))
vi.mock('../store/tasks', () => ({ activeTasksForProject: () => [] }))
vi.mock('./TaskBoardPage', () => ({ TaskBoardPage: () => null }))
vi.mock('./Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./TaskPanel', () => ({ TaskPanel: () => null }))
vi.mock('./ArchivedPage', () => ({ ArchivedPage: () => null }))
vi.mock('./NewTaskView', () => ({ NewTaskView: () => null }))
vi.mock('./AddProjectDialog', () => ({ AddProjectDialog: () => null }))
vi.mock('./CloneRepoDialog', () => ({ CloneRepoDialog: () => null }))
vi.mock('./BtsBuilderDialog', () => ({ BtsBuilderDialog: () => null }))
vi.mock('./TaskModelPickerHost', () => ({ TaskModelPickerHost: () => null }))
vi.mock('./GlobalCommandPalette', () => ({ GlobalCommandPalette: () => null, setShowGlobalPalette: vi.fn() }))
vi.mock('./SettingsPage', () => ({
  SettingsPage: () => null,
  setSettingsSaveRequested: vi.fn(),
  selectSettingsSection: mocks.selectSettingsSection,
  settingsSectionForShortcut: mocks.settingsSectionForShortcut,
}))

import { Layout } from './Layout'
import { setProjects } from '../store/projects'
import { setShowSettings } from '../store/ui'
import type { Project } from '../types'

const project = (id: string): Project => ({
  id,
  name: id,
  repoPath: `/tmp/${id}`,
  baseBranch: 'main',
  setupHook: '',
  destroyHook: '',
  startCommand: '',
  autoStart: false,
  createdAt: 1000,
  defaultAgentType: 'claude',
})

/** Cmd+`digit` as the page sees it (jsdom is not a Mac, so the modifier is Ctrl). */
const press = (digit: number) => fireEvent.keyDown(window, { key: String(digit), ctrlKey: true, metaKey: true })

beforeEach(() => {
  mocks.selectSettingsSection.mockReset()
  mocks.settingsSectionForShortcut.mockReset()
  setProjects([project('p1'), project('p2')])
  setShowSettings(true)
  render(() => <Layout />)
})

afterEach(() => {
  cleanup()
  setShowSettings(false)
})

describe('Layout Cmd+digit in Settings', () => {
  test('opens the section the shortcut maps the digit to, given the projects in order', () => {
    mocks.settingsSectionForShortcut.mockReturnValue('accounts')

    press(3)

    expect(mocks.settingsSectionForShortcut).toHaveBeenCalledWith(3, ['p1', 'p2'])
    expect(mocks.selectSettingsSection).toHaveBeenCalledWith('accounts')
  })

  test('every digit is handed over as it is', () => {
    mocks.settingsSectionForShortcut.mockImplementation((digit: number) => `section-${digit}`)

    press(1)
    press(5)
    press(9)

    expect(mocks.selectSettingsSection.mock.calls).toEqual([['section-1'], ['section-5'], ['section-9']])
  })

  test('opens nothing when there is no such section', () => {
    mocks.settingsSectionForShortcut.mockReturnValue(null)

    press(9)

    expect(mocks.settingsSectionForShortcut).toHaveBeenCalledWith(9, ['p1', 'p2'])
    expect(mocks.selectSettingsSection).not.toHaveBeenCalled()
  })

  test('outside Settings the digits do not switch sections', () => {
    setShowSettings(false)
    mocks.settingsSectionForShortcut.mockReturnValue('accounts')

    press(3)

    expect(mocks.settingsSectionForShortcut).not.toHaveBeenCalled()
    expect(mocks.selectSettingsSection).not.toHaveBeenCalled()
  })
})
