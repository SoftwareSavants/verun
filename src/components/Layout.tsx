import { Component, Show, onMount, onCleanup, createSignal } from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'
import { SettingsPage, selectSettingsSection, setSettingsSaveRequested } from './SettingsPage'
import { NewTaskDialog } from './NewTaskDialog'
import { sidebarWidth, setSidebarWidth, addToast, showSettings, setShowSettings, toggleTerminal, showTerminal, setShowTerminal } from '../store/ui'
import { spawnTerminal, focusActiveTerminal, terminalsForTask, activeTerminalId, setActiveTerminalForTask } from '../store/terminals'
import { tasks } from '../store/tasks'
import { addProject, projects } from '../store/projects'
import { selectedProjectId, setSelectedProjectId, setSelectedTaskId, selectedTaskId } from '../store/ui'
import { modPressed } from '../lib/platform'
import { requestCloseTab, reopenClosedTab, nextTab, prevTab, activeTabPath, rightPanelTab, setRightPanelTab } from '../store/files'

async function pickAndAddProject() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (!selected) return
  try {
    const project = await addProject(selected as string)
    setSelectedProjectId(project.id)
    addToast(`Added ${project.name}`, 'success')
  } catch (e) {
    addToast(String(e), 'error')
  }
}

export const Layout: Component = () => {
  const [dragging, setDragging] = createSignal(false)
  const [newTaskProjectId, setNewTaskProjectId] = createSignal<string | null>(null)

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
      if (modPressed(e) && e.key === 'n') {
        e.preventDefault()
        const pid = selectedProjectId()
        if (pid) setNewTaskProjectId(pid)
        else if (projects.length > 0) setNewTaskProjectId(projects[projects.length - 1].id)
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
          if (idx < tasks.length) {
            setSelectedTaskId(tasks[idx].id)
            setSelectedProjectId(tasks[idx].projectId)
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
      // Cmd+E — toggle Files panel
      if (modPressed(e) && e.key === 'e') {
        e.preventDefault()
        setRightPanelTab(rightPanelTab() === 'files' ? 'changes' : 'files')
      }
      // Cmd+W — close active editor tab (only when Files panel is active and a tab is open)
      if (modPressed(e) && e.key === 'w' && !e.shiftKey) {
        const active = document.activeElement
        const inEditor = active && ((active as HTMLElement).isContentEditable || active.closest('.cm-editor'))
        if (inEditor || rightPanelTab() === 'files') {
          const path = activeTabPath()
          if (path) {
            e.preventDefault()
            requestCloseTab(path)
          }
        }
      }
      // Cmd+Shift+T — reopen closed tab
      if (modPressed(e) && e.shiftKey && e.key === 't') {
        e.preventDefault()
        reopenClosedTab()
      }
      // Cmd+Alt+Right / Cmd+Alt+Left — switch editor tabs
      if (modPressed(e) && e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        nextTab()
      }
      if (modPressed(e) && e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        prevTab()
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
      // Mod+\ — focus terminal (when open)
      if (modPressed(e) && e.key === '\\') {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          focusActiveTerminal(tid)
        }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab — switch editor tabs (when in editor/files), else terminal tabs
      if (e.ctrlKey && e.key === 'Tab') {
        const active = document.activeElement
        const inEditor = active && ((active as HTMLElement).isContentEditable || active.closest('.cm-editor'))
        if (inEditor || rightPanelTab() === 'files') {
          e.preventDefault()
          if (e.shiftKey) prevTab()
          else nextTab()
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

      <Show when={showSettings()} fallback={<TaskPanel />}>
        <SettingsPage />
      </Show>

      <NewTaskDialog
        open={!!newTaskProjectId()}
        projectId={newTaskProjectId()}
        onClose={() => setNewTaskProjectId(null)}
      />
    </div>
  )
}
