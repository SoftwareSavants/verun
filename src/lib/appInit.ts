import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { loadProjects, initProjectListeners } from '../store/projects'
import { initSessionListeners, syncSessionStatuses } from '../store/sessions'
import { initTerminalListeners } from '../store/terminals'
import { initGitListeners, initWindowFocusRefresh } from '../store/git'
import { initOpenFilesRefresh } from '../store/fileSync'
import { initSetupListeners } from '../store/setup'
import { loadTasks } from '../store/tasks'
import { loadSessions } from '../store/sessions'
import { refreshTaskGit } from '../store/git'
import { addToast } from '../store/ui'
import * as ipc from './ipc'

/**
 * Re-capture the user's shell PATH on window focus, debounced to once per 30s
 * so normal alt-tab activity doesn't spawn a shell over and over. The Rust
 * side already does this on integrated-terminal idle; this covers the case
 * where the user installed something in an external terminal.
 */
function initEnvPathFocusRefresh() {
  let lastReloadAt = 0
  const DEBOUNCE_MS = 30_000
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - lastReloadAt < DEBOUNCE_MS) return
    lastReloadAt = now
    ipc.reloadEnvPath().catch(() => { /* best effort */ })
  })
}

/** Register all event listeners (parallel — these just register callbacks) */
export async function initListeners() {
  await Promise.all([
    initSessionListeners(),
    initTerminalListeners(),
    initGitListeners(),
    initProjectListeners(),
    initSetupListeners(),
  ])
  initWindowFocusRefresh()
  initEnvPathFocusRefresh()
  initOpenFilesRefresh()

  // Cross-window sync: reload when tasks change in another window
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

/** Load initial data from the database */
export async function loadInitialData() {
  await Promise.all([loadProjects(), syncSessionStatuses()])
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
