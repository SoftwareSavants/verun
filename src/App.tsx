import { Component, onMount, createSignal } from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { Layout } from './components/Layout'
import { SelectionMenu } from './components/SelectionMenu'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastContainer } from './components/ToastContainer'
import { initTheme } from './lib/theme'
import { loadProjects } from './store/projects'
import { initSessionListeners, syncSessionStatuses } from './store/sessions'
import { initTerminalListeners } from './store/terminals'
import { initGitListeners, initWindowFocusRefresh } from './store/git'
import { loadClaudeSkills } from './store/commands'
import * as ipc from './lib/ipc'
import { addToast } from './store/ui'

const App: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)
  const [showQuitConfirm, setShowQuitConfirm] = createSignal(false)

  onMount(async () => {
    // Listen for quit confirmation request from backend (CMD+Q)
    listen('confirm-quit', () => setShowQuitConfirm(true))
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

    // Double-click on drag regions toggles window maximize (standard macOS behavior)
    document.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.drag-region') && !target.closest('.no-drag')) {
        getCurrentWindow().toggleMaximize()
      }
    })

    await initSessionListeners()
    await initTerminalListeners()
    await initGitListeners()
    initWindowFocusRefresh()
    await loadProjects()
    await syncSessionStatuses()

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
      <ConfirmDialog
        open={showQuitConfirm()}
        title="Quit Verun?"
        message="Any running sessions will be stopped."
        confirmLabel="Quit"
        danger
        onConfirm={() => ipc.quitApp()}
        onCancel={() => setShowQuitConfirm(false)}
      />
    </>
  )
}

export default App
