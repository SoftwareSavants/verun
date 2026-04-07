import { Component, Show, onMount, onCleanup, createSignal } from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'
import { SettingsPage } from './SettingsPage'
import { sidebarWidth, setSidebarWidth, addToast, showSettings, setShowSettings } from '../store/ui'
import { tasks, quickCreateTask } from '../store/tasks'
import { addProject } from '../store/projects'
import { selectedProjectId, setSelectedProjectId, setSelectedTaskId } from '../store/ui'

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
      if (e.metaKey && e.key === 'o') {
        e.preventDefault()
        pickAndAddProject()
      }
      if (e.metaKey && e.key === 'n') {
        e.preventDefault()
        const pid = selectedProjectId()
        if (pid) quickCreateTask(pid)
        else pickAndAddProject()
      }
      if (e.metaKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        if (idx < tasks.length) {
          setSelectedTaskId(tasks[idx].id)
          setShowSettings(false)
        }
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(!showSettings())
      }
      if (e.key === 'Escape' && showSettings()) {
        e.preventDefault()
        setShowSettings(false)
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
    </div>
  )
}
