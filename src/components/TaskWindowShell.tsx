import { Component, createSignal, createEffect, on, onMount, onCleanup } from 'solid-js'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowContext } from '../lib/windowContext'
import { initStores, dismissSplash, checkCli, installContextMenu, initQuitListener, showQuitConfirm, closeQuitDialog } from '../lib/appInit'
import { initTheme } from '../lib/theme'
import { refreshTaskGit } from '../store/git'
import { loadTasks, taskById } from '../store/tasks'
import { isSetupRunning } from '../store/setup'
import { selectedTaskId, setSelectedTaskId, setSelectedProjectId, addToast } from '../store/ui'
import { modPressed } from '../lib/platform'
import { toggleTerminal, showTerminal, setShowTerminal } from '../store/ui'
import { spawnTerminal, focusActiveTerminal, terminalsForTask, activeTerminalId, setActiveTerminalForTask, isStartCommandRunning, spawnStartCommand, stopStartCommand } from '../store/terminals'
import { projectById } from '../store/projects'
import { requestCloseTab, reopenClosedTab, nextTab, prevTab, activeTabPath, mainView, rightPanelTab, setRightPanelTab, setShowQuickOpen } from '../store/files'
import { TaskPanel } from './TaskPanel'
import { NewTaskDialog } from './NewTaskDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ToastContainer } from './ToastContainer'
import { SelectionMenu } from './SelectionMenu'
import { UpdateBanner } from './UpdateBanner'
import * as ipc from '../lib/ipc'

export const TaskWindowShell: Component = () => {
  const ctx = useWindowContext()
  const [showNewTask, setShowNewTask] = createSignal(!ctx.taskId && !!ctx.projectId)
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)
  const [showSetupCloseConfirm, setShowSetupCloseConfirm] = createSignal(false)

  // Intercept close when setup hook is running
  getCurrentWindow().onCloseRequested((event) => {
    const tid = selectedTaskId()
    if (tid && isSetupRunning(tid)) {
      event.preventDefault()
      setShowSetupCloseConfirm(true)
    }
  })

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


  // --- Initialization ---

  onMount(async () => {
    initTheme()
    initQuitListener()
    installContextMenu(setSelMenu)
    await initStores()

    if (ctx.taskId) {
      const task = await ipc.getTask(ctx.taskId)
      if (task) {
        setSelectedProjectId(task.projectId)
        await loadTasks(task.projectId)
      }
      refreshTaskGit(ctx.taskId)
    } else if (ctx.projectId) {
      await loadTasks(ctx.projectId)
    }

    dismissSplash()
    await checkCli()
  })

  // --- Task lifecycle listeners ---

  onMount(() => {
    // Close window when task is deleted or archived
    const unlistenRemoved = listen<{ taskId: string; reason: string }>('task-removed', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId) {
        addToast(event.payload.reason === 'archived' ? 'Task was archived' : 'Task was deleted', 'info')
        setTimeout(() => getCurrentWindow().close(), 1500)
      }
    })

    // Update window title when task is auto-named or renamed
    const unlistenName = listen<{ taskId: string; name: string }>('task-name', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId && event.payload.name) {
        getCurrentWindow().setTitle(event.payload.name)
      }
    })

    onCleanup(() => {
      unlistenRemoved.then(fn => fn())
      unlistenName.then(fn => fn())
    })
  })

  const handleNewTaskClose = () => {
    setShowNewTask(false)
    if (!selectedTaskId()) getCurrentWindow().close()
  }

  // --- Keyboard shortcuts ---

  onMount(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tid = selectedTaskId()

      if (modPressed(e) && e.key === 'p' && tid) {
        e.preventDefault(); setShowQuickOpen(true)
      }
      if (modPressed(e) && e.key === 'e') {
        e.preventDefault(); setRightPanelTab(rightPanelTab() === 'files' ? 'changes' : 'files')
      }
      // Cmd+W: close editor tab, or close window
      if (modPressed(e) && e.key === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (tid) {
          const path = activeTabPath(tid)
          if (path && mainView(tid) !== 'session') { requestCloseTab(tid, path); return }
        }
        getCurrentWindow().close()
      }
      if (modPressed(e) && e.shiftKey && e.key === 't' && tid) {
        e.preventDefault(); reopenClosedTab(tid)
      }
      if (modPressed(e) && e.altKey && e.key === 'ArrowRight' && tid) { e.preventDefault(); nextTab(tid) }
      if (modPressed(e) && e.altKey && e.key === 'ArrowLeft' && tid) { e.preventDefault(); prevTab(tid) }

      // Terminal shortcuts
      if (e.ctrlKey && !e.shiftKey && e.key === '`') {
        e.preventDefault(); toggleTerminal()
        if (tid && showTerminal()) requestAnimationFrame(() => requestAnimationFrame(() => focusActiveTerminal(tid)))
      }
      if (e.ctrlKey && e.shiftKey && (e.key === '`' || e.key === '~') && tid) {
        e.preventDefault()
        if (!showTerminal()) setShowTerminal(true)
        spawnTerminal(tid, 24, 80)
      }
      if ((modPressed(e) && e.shiftKey && e.key === 'b') || e.key === 'F5') {
        e.preventDefault()
        if (tid) {
          if (isStartCommandRunning(tid)) { stopStartCommand(tid) }
          else {
            const task = taskById(tid)
            const project = task ? projectById(task.projectId) : undefined
            if (project?.startCommand) { setShowTerminal(true); spawnStartCommand(tid, project.startCommand) }
          }
        }
      }
      if (modPressed(e) && e.key === '\\' && tid && showTerminal()) {
        e.preventDefault(); focusActiveTerminal(tid)
      }
      if (e.ctrlKey && e.key === 'Tab' && tid) {
        const inFileView = mainView(tid) !== 'session'
        if (inFileView) { e.preventDefault(); e.shiftKey ? prevTab(tid) : nextTab(tid) }
        else if (showTerminal()) {
          e.preventDefault()
          const terms = terminalsForTask(tid)
          if (terms.length > 1) {
            const idx = terms.findIndex(t => t.id === activeTerminalId(tid))
            const next = e.shiftKey ? (idx - 1 + terms.length) % terms.length : (idx + 1) % terms.length
            setActiveTerminalForTask(tid, terms[next].id)
            requestAnimationFrame(() => focusActiveTerminal(tid))
          }
        }
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9' && tid && showTerminal()) {
        e.preventDefault()
        const terms = terminalsForTask(tid)
        const idx = parseInt(e.key) - 1
        if (idx < terms.length) {
          setActiveTerminalForTask(tid, terms[idx].id)
          requestAnimationFrame(() => focusActiveTerminal(tid))
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    onCleanup(() => window.removeEventListener('keydown', handleKey))

    const unlisten = listen('quick-open', () => { if (selectedTaskId()) setShowQuickOpen(true) })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  // --- Render ---

  return (
    <>
      <div class="flex flex-col h-screen w-screen bg-surface-0 text-text-primary select-none overflow-hidden">
        <UpdateBanner />
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
        onConfirm={() => { setShowSetupCloseConfirm(false); getCurrentWindow().destroy() }}
        onCancel={() => setShowSetupCloseConfirm(false)}
      />
    </>
  )
}
