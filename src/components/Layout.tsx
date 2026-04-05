import { Component, onMount, onCleanup, createSignal } from 'solid-js'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'
import { sidebarWidth, setSidebarWidth } from '../store/ui'
import { tasks } from '../store/tasks'
import { setSelectedTaskId, setShowNewTaskDialog } from '../store/ui'

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
      const width = Math.max(180, Math.min(480, e.clientX))
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
      if (e.metaKey && e.key === 'n') {
        e.preventDefault()
        setShowNewTaskDialog(true)
      }
      // Cmd+1-9 to switch tasks
      if (e.metaKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        if (idx < tasks.length) {
          setSelectedTaskId(tasks[idx].id)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    onCleanup(() => window.removeEventListener('keydown', handleKey))
  })

  return (
    <div class="flex h-screen w-screen bg-surface-0 text-gray-200 select-none">
      <div style={{ width: `${sidebarWidth()}px` }} class="shrink-0">
        <Sidebar />
      </div>

      {/* Resize handle */}
      <div
        class="w-1 cursor-col-resize hover:bg-accent/30 transition-colors shrink-0"
        classList={{ 'bg-accent/30': dragging() }}
        onMouseDown={startResize}
      />

      <TaskPanel />
    </div>
  )
}
