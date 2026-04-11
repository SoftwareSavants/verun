import { Component, Show, onMount, createSignal } from 'solid-js'
import { parseWindowContext, WindowContextProvider } from './lib/windowContext'
import { initStores, dismissSplash, checkCli, installContextMenu, initQuitListener, showQuitConfirm, closeQuitDialog } from './lib/appInit'
import { Layout } from './components/Layout'
import { TaskWindowShell } from './components/TaskWindowShell'
import { SelectionMenu } from './components/SelectionMenu'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastContainer } from './components/ToastContainer'
import { initTheme } from './lib/theme'
import { initProblemsListener } from './store/problems'
import { loadClaudeSkills } from './store/commands'
import * as ipc from './lib/ipc'
import { initNotifications, showNotificationDialog, onNotificationDialogConfirm, onNotificationDialogCancel } from './lib/notifications'
import { initUpdateListener } from './lib/updater'

const ctx = parseWindowContext()

const MainApp: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)

  onMount(async () => {
    initTheme()
    initQuitListener()
    installContextMenu(setSelMenu)
    await initStores()
    initProblemsListener()
    dismissSplash()

    await checkCli()
    loadClaudeSkills()

    initNotifications()
    initUpdateListener()
  })

  return (
    <>
      <Layout />
      <ToastContainer />
      <SelectionMenu pos={selMenu()} onClose={() => setSelMenu(null)} />
      <ConfirmDialog
        open={showQuitConfirm()}
        title="Quit Verun?"
        message="Any running sessions will be stopped."
        confirmLabel="Quit"
        danger
        onConfirm={() => ipc.quitApp()}
        onCancel={closeQuitDialog}
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

const App: Component = () => (
  <WindowContextProvider value={ctx}>
    <Show when={ctx.windowType === 'main'} fallback={<TaskWindowShell />}>
      <MainApp />
    </Show>
  </WindowContextProvider>
)

export default App
