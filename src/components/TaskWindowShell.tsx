import { Component, createSignal, createEffect, on, onMount, onCleanup } from 'solid-js'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowContext } from '../lib/windowContext'
import { initListeners, dismissSplash, installContextMenu, initQuitListener, showQuitConfirm, closeQuitDialog } from '../lib/appInit'
import { initTheme } from '../lib/theme'
import { refreshTaskGit } from '../store/git'
import { loadTasks } from '../store/tasks'
import { loadProjects } from '../store/projects'
import { loadAgents } from '../store/agents'
import { selectedTaskId, setSelectedTaskId, setSelectedProjectId, setShowQuickOpen } from '../store/ui'
import { hydrateTerminalsForTask } from '../store/terminals'
import { useTaskShortcuts } from '../lib/useTaskShortcuts'
import { TaskPanel } from './TaskPanel'
import { NewTaskDialog } from './NewTaskDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ToastContainer } from './ToastContainer'
import { SelectionMenu } from './SelectionMenu'
import { TaskModelPickerHost } from './TaskModelPickerHost'
import { FileConflictDialog } from './FileConflictDialog'
import { RecreateFileDialog } from './RecreateFileDialog'
import * as ipc from '../lib/ipc'

export const TaskWindowShell: Component = () => {
  const ctx = useWindowContext()
  const [showNewTask, setShowNewTask] = createSignal(!ctx.taskId && !!ctx.projectId)
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)
  const [showSetupCloseConfirm, setShowSetupCloseConfirm] = createSignal(false)

  // Set selection eagerly so TaskPanel renders the right task immediately
  if (ctx.taskId) {
    setSelectedTaskId(ctx.taskId)
  } else if (ctx.projectId) {
    setSelectedProjectId(ctx.projectId)
  }

  // Notify other windows whenever this window's task changes.
  // For existing tasks: fires immediately with the fixed taskId.
  // For new-task windows: fires when the placeholder is replaced with the real ID.
  createEffect(on(selectedTaskId, (taskId) => {
    if (taskId) emit('task-window-changed', { taskId, open: true })
  }))

  // Hydrate terminals from the Rust ring buffer whenever the selected task
  // changes. Runs on every change (not just first mount) so re-syncing picks
  // up PTYs spawned in the main window since we last looked.
  createEffect(() => {
    const taskId = selectedTaskId()
    if (taskId) hydrateTerminalsForTask(taskId)
  })


  // --- Initialization ---

  onMount(async () => {
    initTheme()
    initQuitListener()
    installContextMenu(setSelMenu)

    // Register listeners and load task data in parallel for fast startup.
    // Detached windows must hydrate the projects + agents stores too, because
    // the new-session menu reads from `agents` and the start-command button
    // reads from `projects[].startCommand`.
    const taskDataPromise = ctx.taskId
      ? ipc.getTask(ctx.taskId).then(async (task) => {
          if (task) {
            setSelectedProjectId(task.projectId)
            await loadTasks(task.projectId)
          }
          refreshTaskGit(ctx.taskId!)
        })
      : ctx.projectId
        ? loadTasks(ctx.projectId)
        : Promise.resolve()
    const storeHydratePromise = Promise.all([loadProjects(), loadAgents()])

    await Promise.all([initListeners(), taskDataPromise, storeHydratePromise])

    dismissSplash()
    getCurrentWindow().show()
  })

  // --- Task lifecycle listeners ---

  onMount(() => {
    // Close window immediately when task is deleted or archived. The main
    // window shows the toast (see appInit.ts) so it survives the close.
    const unlistenRemoved = listen<{ taskId: string; reason: string }>('task-removed', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId) {
        getCurrentWindow().close()
      }
    })

    // Update window title when task is auto-named or renamed
    const unlistenName = listen<{ taskId: string; name: string }>('task-name', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId && event.payload.name) {
        getCurrentWindow().setTitle(event.payload.name)
      }
    })

    // Setup hook still running — Rust prevented close, show confirmation dialog
    const unlistenSetupClose = listen('confirm-close-setup', () => {
      setShowSetupCloseConfirm(true)
    })

    onCleanup(() => {
      unlistenRemoved.then(fn => fn())
      unlistenName.then(fn => fn())
      unlistenSetupClose.then(fn => fn())
    })
  })

  const handleNewTaskClose = () => {
    setShowNewTask(false)
    if (!selectedTaskId()) getCurrentWindow().close()
  }

  // --- Keyboard shortcuts ---

  // Shared per-task shortcuts (Cmd+T new session, Cmd+P quick open, etc.)
  // live in useTaskShortcuts so the main Layout and this detached shell stay
  // in sync. Cmd+W falls back to closing the window when no editor tab is open.
  useTaskShortcuts({ onCloseWhenNoTab: () => getCurrentWindow().close() })

  onMount(() => {
    // CmdOrCtrl+P fired from the native menu (Rust emits "quick-open" since
    // accelerator-only menus don't always reach JS focus reliably).
    const unlisten = listen('quick-open', () => { if (selectedTaskId()) setShowQuickOpen(true) })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  // --- Render ---

  return (
    <>
      <div class="flex flex-col h-screen w-screen bg-surface-0 text-text-primary select-none overflow-hidden">
        <TaskPanel />
      </div>
      <ToastContainer />
      <SelectionMenu pos={selMenu()} onClose={() => setSelMenu(null)} />
      <NewTaskDialog open={showNewTask()} projectId={ctx.projectId} onClose={handleNewTaskClose} />
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
        open={showSetupCloseConfirm()}
        title="Setup hook is running"
        message="The setup script is still running. It will continue in the background if you close this window."
        confirmLabel="Close anyway"
        onConfirm={() => { setShowSetupCloseConfirm(false); ipc.forceCloseTaskWindow() }}
        onCancel={() => setShowSetupCloseConfirm(false)}
      />
      <TaskModelPickerHost />
      <FileConflictDialog />
      <RecreateFileDialog />
    </>
  )
}
