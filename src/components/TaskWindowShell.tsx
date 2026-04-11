import { Component, createSignal, onMount, onCleanup } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowContext } from '../lib/windowContext'
import { initTheme } from '../lib/theme'
import { loadProjects, initProjectListeners } from '../store/projects'
import { initSessionListeners, syncSessionStatuses } from '../store/sessions'
import { initTerminalListeners } from '../store/terminals'
import { initGitListeners, initWindowFocusRefresh, refreshTaskGit } from '../store/git'
import { initSetupListeners } from '../store/setup'
import { loadTasks, taskById } from '../store/tasks'
import {
  selectedTaskId,
  setSelectedTaskId,
  setSelectedProjectId,
  addToast,
} from '../store/ui'
import { TaskPanel } from './TaskPanel'
import { NewTaskDialog } from './NewTaskDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ToastContainer } from './ToastContainer'
import { SelectionMenu } from './SelectionMenu'
import { UpdateBanner } from './UpdateBanner'
import { modPressed } from '../lib/platform'
import { toggleTerminal, showTerminal, setShowTerminal } from '../store/ui'
import { spawnTerminal, focusActiveTerminal, terminalsForTask, activeTerminalId, setActiveTerminalForTask, isStartCommandRunning, spawnStartCommand, stopStartCommand } from '../store/terminals'
import { projectById } from '../store/projects'
import { requestCloseTab, reopenClosedTab, nextTab, prevTab, activeTabPath, mainView, rightPanelTab, setRightPanelTab, setShowQuickOpen } from '../store/files'
import * as ipc from '../lib/ipc'

const QUIT_DISMISS_MS = 8000

export const TaskWindowShell: Component = () => {
  const ctx = useWindowContext()
  const [showNewTask, setShowNewTask] = createSignal(!ctx.taskId && !!ctx.projectId)
  const [selMenu, setSelMenu] = createSignal<{ x: number; y: number; text: string } | null>(null)
  const [showQuitConfirm, setShowQuitConfirm] = createSignal(false)
  let quitDismissTimer: ReturnType<typeof setTimeout> | undefined

  const openQuitDialog = () => {
    setShowQuitConfirm(true)
    clearTimeout(quitDismissTimer)
    quitDismissTimer = setTimeout(() => setShowQuitConfirm(false), QUIT_DISMISS_MS)
  }
  const closeQuitDialog = () => {
    setShowQuitConfirm(false)
    clearTimeout(quitDismissTimer)
  }

  onMount(async () => {
    initTheme()

    // Show quit dialog only if this window is focused
    listen('confirm-quit', () => {
      if (document.hasFocus()) openQuitDialog()
    })

    // Context menu
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
    initWindowFocusRefresh() // Fix #8: refresh git state on window focus
    await loadProjects()
    await syncSessionStatuses()

    // If we have a taskId, select it and load its data
    if (ctx.taskId) {
      const task = taskById(ctx.taskId)
      if (task) {
        setSelectedProjectId(task.projectId)
      }
      setSelectedTaskId(ctx.taskId)
      // Fix #7: load git state for this task
      refreshTaskGit(ctx.taskId)
    } else if (ctx.projectId) {
      setSelectedProjectId(ctx.projectId)
      await loadTasks(ctx.projectId)
    }

    // Dismiss splash, reveal app
    const splash = document.getElementById('splash')
    const root = document.getElementById('root')
    if (root) root.style.opacity = '1'
    if (splash) {
      splash.style.opacity = '0'
      splash.addEventListener('transitionend', () => splash.remove())
    }

    // Check CLI
    try {
      await ipc.checkClaude()
    } catch {
      addToast('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code', 'error')
    }
  })

  // Fix #1: Listen for task deletion/archival — close this window
  onMount(() => {
    const unlistenRemoved = listen<{ taskId: string; reason: string }>('task-removed', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId) {
        const label = event.payload.reason === 'archived' ? 'Task was archived' : 'Task was deleted'
        addToast(label, 'info')
        setTimeout(() => getCurrentWindow().close(), 1500)
      }
    })
    onCleanup(() => { unlistenRemoved.then(fn => fn()) })
  })

  // Fix #4: Update window title when task is auto-named or renamed
  onMount(() => {
    const unlistenName = listen<{ taskId: string; name: string }>('task-name', (event) => {
      const myTaskId = ctx.taskId || selectedTaskId()
      if (event.payload.taskId === myTaskId && event.payload.name) {
        getCurrentWindow().setTitle(event.payload.name)
      }
    })
    onCleanup(() => { unlistenName.then(fn => fn()) })
  })

  // When new task is created via dialog, update the selected task
  const handleNewTaskClose = () => {
    setShowNewTask(false)
    // If no task was selected (dialog was cancelled), close the window
    if (!selectedTaskId()) {
      getCurrentWindow().close()
    }
  }

  // Keyboard shortcuts (subset of Layout shortcuts relevant to task windows)
  onMount(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Cmd+P — quick file open
      if (modPressed(e) && e.key === 'p' && selectedTaskId()) {
        e.preventDefault()
        setShowQuickOpen(true)
      }
      // Cmd+E — toggle Files panel
      if (modPressed(e) && e.key === 'e') {
        e.preventDefault()
        setRightPanelTab(rightPanelTab() === 'files' ? 'changes' : 'files')
      }
      // Fix #10: Cmd+W — close editor tab, or close the window if no tab is open
      if (modPressed(e) && e.key === 'w' && !e.shiftKey) {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid) {
          const path = activeTabPath(tid)
          if (path && mainView(tid) !== 'session') {
            requestCloseTab(tid, path)
            return
          }
        }
        // No editor tab to close — close the window
        getCurrentWindow().close()
      }
      // Cmd+Shift+T — reopen closed tab
      if (modPressed(e) && e.shiftKey && e.key === 't') {
        const tid = selectedTaskId()
        if (tid) { e.preventDefault(); reopenClosedTab(tid) }
      }
      // Cmd+Alt+Right / Left — switch editor tabs
      if (modPressed(e) && e.altKey && e.key === 'ArrowRight') {
        const tid = selectedTaskId()
        if (tid) { e.preventDefault(); nextTab(tid) }
      }
      if (modPressed(e) && e.altKey && e.key === 'ArrowLeft') {
        const tid = selectedTaskId()
        if (tid) { e.preventDefault(); prevTab(tid) }
      }
      // Ctrl+` — toggle terminal
      if (e.ctrlKey && !e.shiftKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          requestAnimationFrame(() => requestAnimationFrame(() => focusActiveTerminal(tid)))
        }
      }
      // Ctrl+Shift+` — new terminal
      if (e.ctrlKey && e.shiftKey && (e.key === '`' || e.key === '~')) {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid) {
          if (!showTerminal()) setShowTerminal(true)
          spawnTerminal(tid, 24, 80)
        }
      }
      // Cmd+Shift+B or F5 — start/stop dev server
      const isStartStopKey = (modPressed(e) && e.shiftKey && e.key === 'b') || e.key === 'F5'
      if (isStartStopKey) {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid) {
          if (isStartCommandRunning(tid)) {
            stopStartCommand(tid)
          } else {
            const task = taskById(tid)
            const project = task ? projectById(task.projectId) : undefined
            if (project?.startCommand) {
              setShowTerminal(true)
              spawnStartCommand(tid, project.startCommand)
            }
          }
        }
      }
      // Mod+\ — focus terminal
      if (modPressed(e) && e.key === '\\') {
        e.preventDefault()
        const tid = selectedTaskId()
        if (tid && showTerminal()) focusActiveTerminal(tid)
      }
      // Ctrl+Tab — switch tabs
      if (e.ctrlKey && e.key === 'Tab') {
        const tid = selectedTaskId()
        const inFileView = tid && mainView(tid) !== 'session'
        if (inFileView) {
          e.preventDefault()
          if (e.shiftKey) prevTab(tid)
          else nextTab(tid)
        } else if (tid && showTerminal()) {
          e.preventDefault()
          const terms = terminalsForTask(tid)
          if (terms.length > 1) {
            const currentId = activeTerminalId(tid)
            const idx = terms.findIndex(t => t.id === currentId)
            const next = e.shiftKey
              ? (idx - 1 + terms.length) % terms.length
              : (idx + 1) % terms.length
            setActiveTerminalForTask(tid, terms[next].id)
            requestAnimationFrame(() => focusActiveTerminal(tid))
          }
        }
      }
      // Ctrl+Number — switch terminal tabs
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const tid = selectedTaskId()
        if (tid && showTerminal()) {
          e.preventDefault()
          const terms = terminalsForTask(tid)
          const idx = parseInt(e.key) - 1
          if (idx < terms.length) {
            setActiveTerminalForTask(tid, terms[idx].id)
            requestAnimationFrame(() => focusActiveTerminal(tid))
          }
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    onCleanup(() => window.removeEventListener('keydown', handleKey))

    const unlisten = listen('quick-open', () => {
      if (selectedTaskId()) setShowQuickOpen(true)
    })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  return (
    <>
      <div class="flex flex-col h-screen w-screen bg-surface-0 text-text-primary select-none overflow-hidden">
        <UpdateBanner />
        <TaskPanel />
      </div>
      <ToastContainer />
      <SelectionMenu
        pos={selMenu()}
        onClose={() => setSelMenu(null)}
      />
      <NewTaskDialog
        open={showNewTask()}
        projectId={ctx.projectId}
        onClose={handleNewTaskClose}
      />
      <ConfirmDialog
        open={showQuitConfirm()}
        title="Quit Verun?"
        message="Any running sessions will be stopped."
        confirmLabel="Quit"
        danger
        onConfirm={() => ipc.quitApp()}
        onCancel={closeQuitDialog}
      />
    </>
  )
}
