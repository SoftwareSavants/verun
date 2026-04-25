import { Component, Show, onMount, createSignal } from 'solid-js'
import { parseWindowContext, WindowContextProvider } from './lib/windowContext'
import { initListeners, loadInitialData, dismissSplash, checkCli, installContextMenu, initQuitListener, showQuitConfirm, closeQuitDialog } from './lib/appInit'
import { Layout } from './components/Layout'
import { TaskWindowShell } from './components/TaskWindowShell'
import { SelectionMenu } from './components/SelectionMenu'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FileConflictDialog } from './components/FileConflictDialog'
import { ToastContainer } from './components/ToastContainer'
import { initTheme } from './lib/theme'
import { projects } from './store/projects'
import { loadTasks, taskById } from './store/tasks'
import { initProblemsListener } from './store/problems'
import * as ipc from './lib/ipc'
import { selectedTaskId, setSelectedTaskId, setSelectedProjectId, setSelectedSessionIdForTask, markTaskUnread } from './store/ui'
import { initNotifications } from './lib/notifications'
import { initUpdateListener } from './lib/updater'
import { runConfiguredGc } from './store/storage'

const ctx = parseWindowContext()

const MainApp: Component = () => {
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)

  onMount(async () => {
    initTheme()
    initQuitListener()
    installContextMenu(setSelMenu)
    await initListeners()
    initProblemsListener()
    await loadInitialData()

    // Restore last selected task — validate it still exists and isn't archived
    const savedTid = selectedTaskId()
    if (savedTid) {
      await Promise.all(projects.map(p => loadTasks(p.id)))
      const task = taskById(savedTid)
      if (task && !task.archived) {
        setSelectedProjectId(task.projectId)
      } else {
        setSelectedTaskId(null)
      }
    }

    // Demo mode: override selection to show a rich screenshot
    if (import.meta.env.VITE_DEMO_MODE === 'true') {
      const [
        { DEMO_SELECTED, DEMO_UNREAD_TASK_IDS, DEMO_PROBLEMS, DEMO_START_COMMAND_TASK_IDS },
        { seedDemoProblems },
        { seedDemoStartCommands },
      ] = await Promise.all([
        import('./lib/seedData'),
        import('./store/problems'),
        import('./store/terminals'),
      ])
      setSelectedProjectId(DEMO_SELECTED.projectId)
      setSelectedTaskId(DEMO_SELECTED.taskId)
      setSelectedSessionIdForTask(DEMO_SELECTED.taskId, DEMO_SELECTED.sessionId)
      for (const id of DEMO_UNREAD_TASK_IDS) markTaskUnread(id)
      seedDemoProblems(DEMO_PROBLEMS)
      seedDemoStartCommands(DEMO_START_COMMAND_TASK_IDS)
    }

    dismissSplash()

    await checkCli()

    initNotifications()
    initUpdateListener()
    // Fire-and-forget: rewrite any legacy base64 attachments into blob refs,
    // then sweep unreferenced / over-cap blobs. Migration is idempotent via
    // an app_meta sentinel so this is cheap on every startup after the first.
    void (async () => {
      try { await ipc.migrateLegacyAttachments() } catch (e) { console.error('migrateLegacyAttachments failed', e) }
      void runConfiguredGc()
    })()
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
      <FileConflictDialog />
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
