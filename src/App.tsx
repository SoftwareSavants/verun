import { Component, onMount, createSignal } from 'solid-js'
import { Layout } from './components/Layout'
import { SelectionMenu } from './components/SelectionMenu'
import { AddProjectDialog } from './components/AddProjectDialog'
import { NewTaskDialog } from './components/NewTaskDialog'
import { ToastContainer } from './components/ToastContainer'
import { loadProjects } from './store/projects'
import { initSessionListeners } from './store/sessions'
import * as ipc from './lib/ipc'
import {
  selectedProjectId,
  showAddProjectDialog, setShowAddProjectDialog,
  showNewTaskDialog, setShowNewTaskDialog,
  addToast,
} from './store/ui'
import 'virtual:uno.css'

const App: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)

  onMount(async () => {
    // Replace default context menu with custom selection menu
    document.addEventListener('contextmenu', (e) => {
      // Allow our Sidebar's custom context menu
      if ((e.target as HTMLElement).closest('[data-context-menu]')) return

      e.preventDefault()

      const selection = window.getSelection()?.toString().trim()
      if (selection) {
        setSelMenu({ x: e.clientX, y: e.clientY, text: selection })
      } else {
        setSelMenu(null)
      }
    })

    // Dismiss on click anywhere
    document.addEventListener('click', () => setSelMenu(null))

    await initSessionListeners()
    await loadProjects()

    // Check Claude CLI availability
    try {
      await ipc.checkClaude()
    } catch {
      addToast('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code', 'error')
    }
  })

  return (
    <>
      <Layout />
      <AddProjectDialog
        open={showAddProjectDialog()}
        onClose={() => setShowAddProjectDialog(false)}
      />
      <NewTaskDialog
        open={showNewTaskDialog()}
        projectId={selectedProjectId()}
        onClose={() => setShowNewTaskDialog(false)}
      />
      <ToastContainer />
      <SelectionMenu
        pos={selMenu()}
        onClose={() => setSelMenu(null)}
      />
    </>
  )
}

export default App
