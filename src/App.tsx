import { Component, Show, onMount, createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { parseWindowContext, WindowContextProvider } from './lib/windowContext'
import { Layout } from './components/Layout'
import { TaskWindowShell } from './components/TaskWindowShell'
import { SelectionMenu } from './components/SelectionMenu'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastContainer } from './components/ToastContainer'
import { initTheme } from './lib/theme'
import { loadProjects, initProjectListeners } from './store/projects'
import { initSessionListeners, syncSessionStatuses } from './store/sessions'
import { initTerminalListeners } from './store/terminals'
import { initGitListeners, initWindowFocusRefresh } from './store/git'
import { initSetupListeners } from './store/setup'
import { initProblemsListener } from './store/problems'
import { loadClaudeSkills } from './store/commands'
import * as ipc from './lib/ipc'
import { addToast } from './store/ui'
import { initNotifications, showNotificationDialog, onNotificationDialogConfirm, onNotificationDialogCancel } from './lib/notifications'
import { initUpdateListener } from './lib/updater'

const ctx = parseWindowContext()

const MainApp: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)
  const [showQuitConfirm, setShowQuitConfirm] = createSignal(false)

  onMount(async () => {
    listen('confirm-quit', () => setShowQuitConfirm(true))
    initTheme()
    document.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('[data-context-menu]') || (e.target as HTMLElement).closest('.cm-editor') || (e.target as HTMLElement).closest('.code-editor-wrapper')) return
      e.preventDefault()
      const selection = window.getSelection()?.toString().trim()
      if (selection) {
        setSelMenu({ x: e.clientX, y: e.clientY, text: selection })
      } else {
        setSelMenu(null)
      }
    })
    document.addEventListener('click', () => setSelMenu(null))

    await initSessionListeners()
    await initTerminalListeners()
    await initGitListeners()
    await initProjectListeners()
    await initSetupListeners()
    initProblemsListener()
    initWindowFocusRefresh()
    await loadProjects()
    await syncSessionStatuses()

    const splash = document.getElementById('splash')
    const root = document.getElementById('root')
    if (root) root.style.opacity = '1'
    if (splash) {
      splash.style.opacity = '0'
      splash.addEventListener('transitionend', () => splash.remove())
    }

    try {
      await ipc.checkClaude()
      loadClaudeSkills()
    } catch {
      addToast('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code', 'error')
    }

    initNotifications()
    initUpdateListener()
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
      <ConfirmDialog
        open={showNotificationDialog()}
        title="Enable desktop notifications?"
        message="Verun can notify you when tasks complete, fail, or need your approval. This is especially useful when you're running multiple sessions in parallel — you'll know exactly when something needs your attention, even if the app is in the background."
        confirmLabel="Enable"
        onConfirm={onNotificationDialogConfirm}
        onCancel={onNotificationDialogCancel}
      />
    </>
  )
}

const App: Component = () => {
  return (
    <WindowContextProvider value={ctx}>
      <Show when={ctx.windowType === 'main'} fallback={<TaskWindowShell />}>
        <MainApp />
      </Show>
    </WindowContextProvider>
  )
}

export default App
