import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
const m = vi.hoisted(() => ({ git: false, tab: 'changes' }))
vi.mock('../store/tasks', () => ({ taskById: () => ({ isGit: m.git }) }))
vi.mock('../store/git', () => ({ taskGit: () => ({ github: null }) }))
vi.mock('../store/ui', () => ({ rightPanelTab: () => m.tab, setRightPanelTab: vi.fn(), problemsHeight: () => 100, setProblemsHeightAndPersist: vi.fn() }))
vi.mock('../store/problems', () => ({ problemCountForTask: () => ({ errors: 0, warnings: 0 }), isProblemsLoading: () => false }))
vi.mock('./FilesPanel', () => ({ FilesPanel: () => <span>Workspace files</span> }))
vi.mock('./GlobalSearchPanel', () => ({ GlobalSearchPanel: () => null }))
vi.mock('./ProblemsPanel', () => ({ ProblemsPanel: () => null }))
vi.mock('./ActionsPanel', () => ({ ActionsPanel: () => null }))
vi.mock('./CodeChanges', () => ({ CodeChanges: () => <span>Git changes</span> }))
import { RightPanel } from './RightPanel'
afterEach(cleanup)
test('non-Git workspace falls back to files even when source control was previously selected', () => {
  m.git = false
  render(() => <RightPanel taskId="task" />)
  expect(screen.queryByTitle('Source Control')).toBeNull()
  expect(screen.queryByText('Git changes')).toBeNull()
  expect(screen.getByText('Workspace files')).toBeTruthy()
})
test('Git workspaces retain their source-control view', () => {
  m.git = true
  render(() => <RightPanel taskId="task" />)
  expect(screen.getByTitle('Source Control')).toBeTruthy()
  expect(screen.getByText('Git changes')).toBeTruthy()
})
