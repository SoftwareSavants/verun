import { Component, Show, onMount, onCleanup, createSignal, createEffect } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'
import { SettingsPage, selectSettingsSection, setSettingsSaveRequested } from './SettingsPage'
import { ArchivedPage } from './ArchivedPage'
import { NewTaskDialog } from './NewTaskDialog'
import { AddProjectDialog } from './AddProjectDialog'
import { CloneRepoDialog } from './CloneRepoDialog'
import { BtsBuilderDialog } from './BtsBuilderDialog'
import { sidebarWidth, setSidebarWidth, showSettings, setShowSettings, showArchived, setShowArchived, newTaskProjectId, setNewTaskProjectId, requestNewTaskForProject, focusOrSelectTask, pickAndAddProject, addProjectPath, setAddProjectPath, showBtsBuilder, setShowBtsBuilder, showCloneRepo, setShowCloneRepo, setSelectedProjectId, siblingTaskInList } from '../store/ui'
import * as ipc from '../lib/ipc'
import { hydrateTerminalsForTask } from '../store/terminals'
import { activeTasksForProject } from '../store/tasks'
import { projects } from '../store/projects'
import { selectedProjectId, selectedTaskId } from '../store/ui'
import { modPressed } from '../lib/platform'
import { setShowQuickOpen } from '../store/ui'
import { GlobalCommandPalette, setShowGlobalPalette } from './GlobalCommandPalette'
import { TaskModelPickerHost } from './TaskModelPickerHost'
import { useTaskShortcuts } from '../lib/useTaskShortcuts'

export const Layout: Component = () => {
  const [dragging, setDragging] = createSignal(false)

  // Restore sidebar width from localStorage
  onMount(() => {
    const saved = localStorage.getItem('verun:sidebarWidth')
    if (saved) setSidebarWidth(parseInt(saved, 10))
  })

  // Hydrate terminals from the Rust ring buffer whenever a task becomes
  // selected. Runs on every selection change (not just the first) so that
  // switching back to a task re-syncs against the backend — picks up PTYs
  // spawned in another window and prunes ones closed elsewhere.
  createEffect(() => {
    const tid = selectedTaskId()
    if (tid) hydrateTerminalsForTask(tid)
  })

  // When a detached task window closes, the main window's terminal store for
  // that task is potentially stale (PTYs spawned or closed while we weren't
  // looking). Re-hydrate so the content reappears when the user views the task
  // again in this window.
  onMount(() => {
    const unlisten = listen<{ taskId: string; open: boolean }>('task-window-changed', (event) => {
      if (!event.payload.open) hydrateTerminalsForTask(event.payload.taskId)
    })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  const startResize = (e: MouseEvent) => {
    e.preventDefault()
    setDragging(true)

    const onMove = (e: MouseEvent) => {
      const width = Math.max(200, Math.min(400, e.clientX))
      setSidebarWidth(width)
    }

    const onUp = () => {
      setDragging(false)
      localStorage.setItem('verun:sidebarWidth', String(sidebarWidth()))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Per-task keyboard shortcuts (Cmd+T, Cmd+P, terminal shortcuts, etc.) are
  // shared with the detached TaskWindowShell via useTaskShortcuts so the two
  // shells can't drift (issue #243). Main-window-only shortcuts stay below.
  useTaskShortcuts()

  // Main-window-only keyboard shortcuts: global navigation, settings, command
  // palette, and Cmd+1..9 for switching between tasks.
  onMount(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (modPressed(e) && e.key === 'o') {
        e.preventDefault()
        pickAndAddProject()
      }
      if (modPressed(e) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        const pid = selectedProjectId() || (projects.length > 0 ? projects[projects.length - 1].id : null)
        if (pid) ipc.openNewTaskWindow(pid)
        return
      }
      if (modPressed(e) && e.key === 'n') {
        e.preventDefault()
        const pid = selectedProjectId()
        if (pid) requestNewTaskForProject(pid)
        else if (projects.length > 0) requestNewTaskForProject(projects[projects.length - 1].id)
        else pickAndAddProject()
      }
      if (modPressed(e) && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        if (showSettings()) {
          // In settings: CMD+Number switches between sections
          // 1 = General, 2 = Appearance, 3+ = projects by order
          if (idx === 0) {
            selectSettingsSection('general')
          } else if (idx === 1) {
            selectSettingsSection('appearance')
          } else if (idx - 2 < projects.length) {
            selectSettingsSection(projects[idx - 2].id)
          }
        } else {
          // Match sidebar ordering: iterate projects, then tasks within each project
          const ordered = projects.flatMap(p => activeTasksForProject(p.id))
          if (idx < ordered.length) {
            focusOrSelectTask(ordered[idx])
          }
        }
      }
      // CMD+S — save in settings
      if (modPressed(e) && e.key === 's') {
        if (showSettings()) {
          e.preventDefault()
          setSettingsSaveRequested(prev => prev + 1)
        }
      }
      if (modPressed(e) && e.key === ',') {
        e.preventDefault()
        setShowSettings(!showSettings())
      }
      if (e.key === 'Escape' && showSettings()) {
        e.preventDefault()
        setShowSettings(false)
      }
      if (e.key === 'Escape' && showArchived()) {
        e.preventDefault()
        setShowArchived(false)
      }
      // Cmd+Shift+P — command palette
      if (modPressed(e) && e.shiftKey && e.key === 'p') {
        e.preventDefault()
        setShowGlobalPalette(true)
        return
      }
      // Cmd+Alt+Down / Cmd+Alt+Up — move to next/previous task in the sidebar
      if (modPressed(e) && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const ordered = projects.flatMap(p => activeTasksForProject(p.id))
        const next = siblingTaskInList(ordered, selectedTaskId(), e.key === 'ArrowDown' ? 'down' : 'up')
        if (next) focusOrSelectTask(next)
      }
    }
    window.addEventListener('keydown', handleKey)
    onCleanup(() => window.removeEventListener('keydown', handleKey))

    // Listen for quick-open menu event from Rust (CmdOrCtrl+P via native menu)
    const unlisten = listen('quick-open', () => {
      if (selectedTaskId()) setShowQuickOpen(true)
    })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  return (
    <div class="flex h-screen w-screen bg-surface-0 text-text-primary select-none overflow-hidden">
      <Show when={!showSettings() && projects.length > 0}>
        <div style={{ width: `${sidebarWidth()}px` }} class="shrink-0 h-full overflow-hidden">
          <Sidebar />
        </div>

        {/* Resize handle — visually 1px, grabbable area wider via negative margins */}
        <div
          class="w-px cursor-col-resize shrink-0 bg-border-subtle hover:bg-accent/20 transition-colors relative z-10"
          classList={{ '!bg-accent/40': dragging() }}
          onMouseDown={startResize}
          style={{ "margin-left": "-3px", "margin-right": "-3px", padding: "0 3px", "background-clip": "content-box" }}
        />
      </Show>

      <div class="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Show when={showSettings()}>
          <SettingsPage />
        </Show>
        <Show when={showArchived() && !showSettings()}>
          <ArchivedPage />
        </Show>
        <Show when={!showSettings() && !showArchived()}>
          <TaskPanel />
        </Show>
      </div>

      <NewTaskDialog
        open={!!newTaskProjectId()}
        projectId={newTaskProjectId()}
        onClose={() => setNewTaskProjectId(null)}
      />
      <AddProjectDialog
        open={!!addProjectPath()}
        repoPath={addProjectPath()}
        onClose={() => setAddProjectPath(null)}
        onAdded={(id) => { setSelectedProjectId(id); requestNewTaskForProject(id) }}
      />
      <BtsBuilderDialog
        open={showBtsBuilder()}
        onClose={() => setShowBtsBuilder(false)}
        onScaffoldComplete={(path) => {
          setShowBtsBuilder(false)
          setAddProjectPath(path)
        }}
      />
      <CloneRepoDialog
        open={showCloneRepo()}
        onClose={() => setShowCloneRepo(false)}
      />
      <GlobalCommandPalette />
      <TaskModelPickerHost />
    </div>
  )
}
