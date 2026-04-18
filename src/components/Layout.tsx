import { Component, Show, onMount, onCleanup, createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'
import { SettingsPage, selectSettingsSection, setSettingsSaveRequested } from './SettingsPage'
import { ArchivedPage } from './ArchivedPage'
import { NewTaskDialog } from './NewTaskDialog'
import { sidebarWidth, setSidebarWidth, showSettings, setShowSettings, showArchived, setShowArchived, toggleTerminal, showTerminal, setShowTerminal, setAddProjectPath, newTaskProjectId, setNewTaskProjectId, requestNewTaskForProject, focusOrSelectTask } from '../store/ui'
import * as ipc from '../lib/ipc'
import { spawnTerminal, focusActiveTerminal, terminalsForTask, activeTerminalId, setActiveTerminalForTask, isStartCommandRunning, spawnStartCommand, stopStartCommand } from '../store/terminals'
import { activeTasksForProject, taskById } from '../store/tasks'
import { projects, projectById } from '../store/projects'
import { selectedProjectId, selectedTaskId } from '../store/ui'
import { modPressed } from '../lib/platform'
import { requestCloseTab, reopenClosedTab, nextTab, prevTab, activeTabPath, mainView } from '../store/editorView'
import { rightPanelTab, setRightPanelTab, setShowQuickOpen } from '../store/ui'
import { GlobalCommandPalette, setShowGlobalPalette } from './GlobalCommandPalette'

async function pickAndAddProject() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (selected) setAddProjectPath(selected as string)
}

export const Layout: Component = () => {
  const [dragging, setDragging] = createSignal(false)

  // Restore sidebar width from localStorage
  onMount(() => {
    const saved = localStorage.getItem('verun:sidebarWidth')
    if (saved) setSidebarWidth(parseInt(saved, 10))
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

  // Keyboard shortcuts
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
          // 1 = General, 2+ = projects by order
          if (idx === 0) {
            selectSettingsSection('general')
          } else if (idx - 1 < projects.length) {
            selectSettingsSection(projects[idx - 1].id)
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
      // Cmd+P — quick file open (only when a task is selected)
      if (modPressed(e) && e.key === 'p' && selectedTaskId()) {
        e.preventDefault()
        setShowQuickOpen(true)
      }
      // Cmd+E — toggle Files panel
      if (modPressed(e) && e.key === 'e') {
        e.preventDefault()
        setRightPanelTab(rightPanelTab() === 'files' ? 'changes' : 'files')
      }
      // Cmd+W — close active editor tab
      if (modPressed(e) && e.key === 'w' && !e.shiftKey) {
        const tid = selectedTaskId()
        if (tid) {
          const path = activeTabPath(tid)
          if (path && mainView(tid) !== 'session') {
            e.preventDefault()
            requestCloseTab(tid, path)
          }
        }
      }
      // Cmd+Shift+T — reopen closed tab
      if (modPressed(e) && e.shiftKey && e.key === 't') {
        const tid = selectedTaskId()
        if (tid) {
          e.preventDefault()
          reopenClosedTab(tid)
        }
      }
      // Cmd+Alt+Right / Cmd+Alt+Left — switch editor tabs
      if (modPressed(e) && e.altKey && e.key === 'ArrowRight') {
        const tid = selectedTaskId()
        if (tid) { e.preventDefault(); nextTab(tid) }
      }
      if (modPressed(e) && e.altKey && e.key === 'ArrowLeft') {
        const tid = selectedTaskId()
        if (tid) { e.preventDefault(); prevTab(tid) }
      }
      // Ctrl+` — toggle terminal panel (focus terminal when opening)
      if (e.ctrlKey && !e.shiftKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          // Double-rAF: first lets display:block apply, second lets xterm measure
          requestAnimationFrame(() => {
            requestAnimationFrame(() => focusActiveTerminal(tid))
          })
        }
      }
      // Ctrl+Shift+` — new terminal in current task (Shift+` produces ~ on macOS)
      if (e.ctrlKey && e.shiftKey && (e.key === '`' || e.key === '~')) {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid) {
          if (!showTerminal()) setShowTerminal(true)
          spawnTerminal(tid, 24, 80)
        }
      }
      // Cmd+Shift+B or F5 — toggle start command (start/stop dev server)
      const isStartStopKey = (modPressed(e) && e.shiftKey && e.key === 'b') || e.key === 'F5'
      if (isStartStopKey) {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid) {
          if (isStartCommandRunning(tid)) {
            stopStartCommand(tid)
          } else {
            const task = taskById(tid)
            const project = task ? projectById(task.projectId) : undefined
            if (project?.startCommand) {
              setShowTerminal(true)
              spawnStartCommand(tid, project.startCommand)
            }
          }
        }
      }
      // Mod+\ — focus terminal (when open)
      if (modPressed(e) && e.key === '\\') {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          focusActiveTerminal(tid)
        }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab — switch editor tabs (when viewing a file), else terminal tabs
      if (e.ctrlKey && e.key === 'Tab') {
        const tid = selectedTaskId()
        const inFileView = tid && mainView(tid) !== 'session'
        if (inFileView) {
          e.preventDefault()
          if (e.shiftKey) prevTab(tid)
          else nextTab(tid)
        } else {
          const tid = selectedTaskId()
          if (tid && showTerminal()) {
            e.preventDefault()
            const terms = terminalsForTask(tid)
            if (terms.length > 1) {
              const currentId = activeTerminalId(tid)
              const idx = terms.findIndex(t => t.id === currentId)
              const next = e.shiftKey
                ? (idx - 1 + terms.length) % terms.length
                : (idx + 1) % terms.length
              setActiveTerminalForTask(tid, terms[next].id)
              requestAnimationFrame(() => focusActiveTerminal(tid))
            }
          }
        }
      }
      // Ctrl+Number — switch to terminal tab by index
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          e.preventDefault()
          const terms = terminalsForTask(tid)
          const idx = parseInt(e.key) - 1
          if (idx < terms.length) {
            setActiveTerminalForTask(tid, terms[idx].id)
            requestAnimationFrame(() => focusActiveTerminal(tid))
          }
        }
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
      <Show when={!showSettings()}>
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
      <GlobalCommandPalette />
    </div>
  )
}
