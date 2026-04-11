import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { loadProjects, initProjectListeners } from '../store/projects'
import { initSessionListeners, syncSessionStatuses } from '../store/sessions'
import { initTerminalListeners } from '../store/terminals'
import { initGitListeners, initWindowFocusRefresh } from '../store/git'
import { initSetupListeners } from '../store/setup'
import { loadTasks } from '../store/tasks'
import { loadSessions } from '../store/sessions'
import { refreshTaskGit } from '../store/git'
import { addToast } from '../store/ui'
import * as ipc from './ipc'

/** Shared store + listener initialization for all window types */
export async function initStores() {
  await initSessionListeners()
  await initTerminalListeners()
  await initGitListeners()
  await initProjectListeners()
  await initSetupListeners()
  initWindowFocusRefresh()
  await loadProjects()
  await syncSessionStatuses()

  // Reload tasks when a task is created or removed in another window
  listen<{ taskId: string; projectId: string }>('task-created', (event) => {
    loadTasks(event.payload.projectId)
    loadSessions(event.payload.taskId)
    refreshTaskGit(event.payload.taskId)
  })
  listen('task-removed', () => {
    ipc.listProjects().then(projects => {
      for (const p of projects) loadTasks(p.id)
    })
  })
}

/** Dismiss the splash screen and reveal the app */
export function dismissSplash() {
  const splash = document.getElementById('splash')
  const root = document.getElementById('root')
  if (root) root.style.opacity = '1'
  if (splash) {
    splash.style.opacity = '0'
    splash.addEventListener('transitionend', () => splash.remove())
  }
}

/** Check Claude CLI availability */
export async function checkCli() {
  try {
    await ipc.checkClaude()
  } catch {
    addToast('Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code', 'error')
  }
}

/** Install custom context menu (replaces default right-click with selection menu) */
export function installContextMenu(
  setPos: (v: { x: number; y: number; text: string } | null) => void,
) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-context-menu]') || target.closest('.cm-editor') || target.closest('.code-editor-wrapper')) return
    e.preventDefault()
    const selection = window.getSelection()?.toString().trim()
    setPos(selection ? { x: e.clientX, y: e.clientY, text: selection } : null)
  })
  document.addEventListener('click', () => setPos(null))
}

// ---------------------------------------------------------------------------
// Quit confirmation — shared across all window types
// ---------------------------------------------------------------------------

const QUIT_DISMISS_MS = 8000

const [_showQuit, _setShowQuit] = createSignal(false)
let _quitTimer: ReturnType<typeof setTimeout> | undefined

export const showQuitConfirm = _showQuit

export function openQuitDialog() {
  _setShowQuit(true)
  clearTimeout(_quitTimer)
  _quitTimer = setTimeout(() => _setShowQuit(false), QUIT_DISMISS_MS)
}

export function closeQuitDialog() {
  _setShowQuit(false)
  clearTimeout(_quitTimer)
}

/** Listen for quit events — only shows the dialog if this window is focused */
export function initQuitListener() {
  listen('confirm-quit', () => {
    if (document.hasFocus()) openQuitDialog()
  })
}
