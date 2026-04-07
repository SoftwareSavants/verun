import { Component, onMount, createSignal } from 'solid-js'
import { Layout } from './components/Layout'
import { SelectionMenu } from './components/SelectionMenu'
import { ToastContainer } from './components/ToastContainer'
import { initTheme } from './lib/theme'
import { loadProjects } from './store/projects'
import { initSessionListeners } from './store/sessions'
import { loadClaudeSkills } from './store/commands'
import * as ipc from './lib/ipc'
import { addToast } from './store/ui'

const App: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)

  onMount(async () => {
    initTheme()
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

    // Dismiss splash screen, reveal app
    const splash = document.getElementById('splash')
    const root = document.getElementById('root')
    if (root) root.style.opacity = '1'
    if (splash) {
      splash.style.opacity = '0'
      splash.addEventListener('transitionend', () => splash.remove())
    }

    // Check Claude CLI availability and load skills
    try {
      await ipc.checkClaude()
      loadClaudeSkills() // fire and forget
    } catch {
      addToast('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code', 'error')
    }
  })

  return (
    <>
      <Layout />
      <ToastContainer />
      <SelectionMenu
        pos={selMenu()}
        onClose={() => setSelMenu(null)}
      />
    </>
  )
}

export default App
