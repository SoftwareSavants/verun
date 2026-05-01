import { describe, test, expect, vi } from 'vitest'

// The task context menu (#61) branches on pinned vs unpinned tasks and on
// whether the pinned task is the auto-created "main" workspace. Exercise the
// pure builder so the rules survive future sidebar refactors.
//
// Heavy mocks: Sidebar pulls in tauri plugins, stores, and IPC wrappers that
// can't run in jsdom. We only need the exported helper, so stub every import
// the module touches.

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('../lib/ipc', () => ({
  watchWorktree: vi.fn(),
  openTaskWindow: vi.fn(),
  openInFinder: vi.fn(),
  unpinTask: vi.fn(),
}))
vi.mock('../store/git', () => ({
  taskGit: vi.fn(() => ({
    status: null,
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null,
    checks: [],
    branchUrl: null,
    github: null,
    lastLocalRefresh: 0,
    lastRemoteRefresh: 0,
  })),
  refreshTaskGit: vi.fn(),
}))
vi.mock('../store/projects', () => ({
  projects: [],
  projectById: vi.fn(),
  deleteProject: vi.fn(),
}))
vi.mock('../store/tasks', () => ({
  tasks: [],
  pinnedTasksForProject: vi.fn(() => []),
  unpinnedActiveTasksForProject: vi.fn(() => []),
  loadTasks: vi.fn(),
  archiveTask: vi.fn(),
  isTaskCreating: vi.fn(() => false),
  isTaskArchiving: vi.fn(() => false),
  getTaskError: vi.fn(() => null),
  updateTaskName: vi.fn(),
}))
vi.mock('../store/ui', () => ({
  setSelectedProjectId: vi.fn(),
  selectedTaskId: vi.fn(() => null),
  setSelectedTaskId: vi.fn(),
  showSettings: vi.fn(() => false),
  setShowSettings: vi.fn(),
  showArchived: vi.fn(() => false),
  setShowArchived: vi.fn(),
  isTaskUnread: vi.fn(() => false),
  isTaskAttention: vi.fn(() => false),
  clearTaskIndicators: vi.fn(),
  addProjectPath: vi.fn(() => null),
  setAddProjectPath: vi.fn(),
  isTaskWindowed: vi.fn(() => false),
  markTaskWindowed: vi.fn(),
  requestNewTaskForProject: vi.fn(),
  requestPinBranchForProject: vi.fn(),
  focusOrSelectTask: vi.fn(),
}))
vi.mock('../store/sessions', () => ({
  sessions: [],
  loadSessions: vi.fn(),
}))
vi.mock('../store/terminals', () => ({
  isStartCommandRunning: vi.fn(() => false),
}))
vi.mock('./SettingsPage', () => ({ selectSettingsSection: vi.fn() }))
vi.mock('./AddProjectDialog', () => ({ AddProjectDialog: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))

import { buildTaskMenuItems } from './Sidebar'

function labelsOf(items: ReturnType<typeof buildTaskMenuItems>): string[] {
  return items
    .filter((i) => !('separator' in i))
    .map((i) => ('label' in i ? i.label : ''))
}

const noopActions = {
  openWindow: vi.fn(),
  startRename: vi.fn(),
  openInFinder: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
}

describe('buildTaskMenuItems (#61)', () => {
  test('regular task gets Archive Task, not Unpin', () => {
    const items = buildTaskMenuItems(
      { isPinned: false, worktreePath: '/tmp/p1/.verun/worktrees/feat' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const labels = labelsOf(items)
    expect(labels).toContain('Archive Task')
    expect(labels).not.toContain('Unpin')
  })

  test('pinned branch task gets Unpin, not Archive Task', () => {
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1/.verun/worktrees/trunk' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const labels = labelsOf(items)
    expect(labels).toContain('Unpin')
    expect(labels).not.toContain('Archive Task')
  })

  test('main pinned task gets neither Archive nor Unpin', () => {
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const labels = labelsOf(items)
    expect(labels).not.toContain('Unpin')
    expect(labels).not.toContain('Archive Task')
    // Still gets the navigation affordances.
    expect(labels).toContain('Open in New Window')
    expect(labels).toContain('Rename')
    expect(labels).toContain('Open in Finder')
  })

  test('Unpin action fires the unpin callback', () => {
    const unpin = vi.fn()
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1/.verun/worktrees/trunk' },
      { repoPath: '/tmp/p1' },
      { ...noopActions, unpin },
    )
    const unpinItem = items.find(
      (i) => 'label' in i && i.label === 'Unpin',
    ) as { action: () => void }
    unpinItem.action()
    expect(unpin).toHaveBeenCalledOnce()
  })

  test('project lookup miss falls back to unpin-capable (not main)', () => {
    // If projectById returns undefined the builder should treat the task as a
    // regular pinned branch — main detection requires a known repoPath.
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1' },
      undefined,
      noopActions,
    )
    expect(labelsOf(items)).toContain('Unpin')
  })

  test('navigation actions (Open in New Window, Rename, Open in Finder) appear for every task type', () => {
    const variants: Array<[string, { isPinned: boolean; worktreePath: string }, { repoPath: string } | undefined]> = [
      ['regular', { isPinned: false, worktreePath: '/tmp/p1/.verun/worktrees/feat' }, { repoPath: '/tmp/p1' }],
      ['pinned branch', { isPinned: true, worktreePath: '/tmp/p1/.verun/worktrees/trunk' }, { repoPath: '/tmp/p1' }],
      ['main pinned', { isPinned: true, worktreePath: '/tmp/p1' }, { repoPath: '/tmp/p1' }],
    ]
    for (const [name, task, project] of variants) {
      const items = buildTaskMenuItems(task, project, noopActions)
      const labels = labelsOf(items)
      expect(labels, name).toContain('Open in New Window')
      expect(labels, name).toContain('Rename')
      expect(labels, name).toContain('Open in Finder')
    }
  })

  test('regular task has a separator before Archive Task', () => {
    const items = buildTaskMenuItems(
      { isPinned: false, worktreePath: '/tmp/p1/.verun/worktrees/feat' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const archiveIdx = items.findIndex(
      (i) => 'label' in i && i.label === 'Archive Task',
    )
    expect(archiveIdx).toBeGreaterThan(0)
    expect('separator' in items[archiveIdx - 1]).toBe(true)
  })

  test('pinned branch task has a separator before Unpin', () => {
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1/.verun/worktrees/trunk' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const unpinIdx = items.findIndex(
      (i) => 'label' in i && i.label === 'Unpin',
    )
    expect(unpinIdx).toBeGreaterThan(0)
    expect('separator' in items[unpinIdx - 1]).toBe(true)
  })

  test('main pinned task has no trailing separator (would dangle below nav items)', () => {
    const items = buildTaskMenuItems(
      { isPinned: true, worktreePath: '/tmp/p1' },
      { repoPath: '/tmp/p1' },
      noopActions,
    )
    const last = items[items.length - 1]
    expect('separator' in last).toBe(false)
  })
})
