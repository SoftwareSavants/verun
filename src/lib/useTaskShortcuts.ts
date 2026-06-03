import { onCleanup } from 'solid-js'
import { modPressed } from './platform'
import {
  selectedTaskId,
  setSelectedSessionIdForTask,
  rightPanelTab,
  setRightPanelTab,
  setShowQuickOpen,
  setFocusSearchRequest,
  showTerminal,
  setShowTerminal,
  toggleTerminal,
  nextSessionIdInTask,
} from '../store/ui'
import { taskById } from '../store/tasks'
import { projectById } from '../store/projects'
import {
  requestCloseTab,
  reopenClosedTab,
  nextTab,
  prevTab,
  activeTabPath,
  mainView,
  setMainView,
} from '../store/editorView'
import {
  spawnTerminal,
  focusActiveTerminal,
  terminalsForTask,
  activeTerminalId,
  setActiveTerminalForTask,
  isStartCommandRunning,
  spawnStartCommand,
  stopStartCommand,
} from '../store/terminals'
import { seedSearchQuery } from '../store/workspaceSearch'
import { openModelPicker } from '../store/modelPicker'
import { createSession, sessionsForTask } from '../store/sessions'
import { selectedSessionForTask } from '../store/taskContext'

export interface TaskShortcutsOptions {
  /**
   * Called when Cmd+W is pressed but no editor tab is open to close.
   * Main window: undefined (no-op). Detached window: close the window.
   */
  onCloseWhenNoTab?: () => void
}

// Registers every per-task keyboard shortcut on `window`. Both the main
// Layout and the detached TaskWindowShell call this so shortcuts can't
// drift between shells (issue #243).
export function useTaskShortcuts(opts: TaskShortcutsOptions = {}) {
  const handleKey = (e: KeyboardEvent) => {
    const tid = selectedTaskId()

    // Cmd+P — quick file open
    if (modPressed(e) && !e.shiftKey && e.key === 'p' && tid) {
      e.preventDefault()
      setShowQuickOpen(true)
    }
    // Cmd+Shift+F — workspace search, seeded with current text selection
    if (modPressed(e) && e.shiftKey && (e.key === 'f' || e.key === 'F') && tid) {
      e.preventDefault()
      const sel = (window.getSelection()?.toString() ?? '').split('\n')[0].trim()
      if (sel.length >= 2 && sel.length <= 200) seedSearchQuery(tid, sel)
      setRightPanelTab('search')
      setFocusSearchRequest(t => t + 1)
    }
    // Cmd+E — toggle Files/Changes panel
    if (modPressed(e) && e.key === 'e') {
      e.preventDefault()
      setRightPanelTab(rightPanelTab() === 'files' ? 'changes' : 'files')
    }
    // Cmd+W — close active editor tab; if none, delegate to onCloseWhenNoTab
    if (modPressed(e) && e.key === 'w' && !e.shiftKey) {
      let closed = false
      if (tid) {
        const path = activeTabPath(tid)
        if (path && mainView(tid) !== 'session') {
          e.preventDefault()
          requestCloseTab(tid, path)
          closed = true
        }
      }
      if (!closed && opts.onCloseWhenNoTab) {
        e.preventDefault()
        opts.onCloseWhenNoTab()
      }
    }
    // Cmd+Shift+T — reopen closed tab
    if (modPressed(e) && e.shiftKey && e.key === 't' && tid) {
      e.preventDefault()
      reopenClosedTab(tid)
    }
    // Cmd+T — open model picker to start a new session on the current task.
    // Defaults to the *selected session*'s agent (falling back to the first
    // session, then the task's original agentType) so switching sessions
    // re-anchors the picker.
    if (modPressed(e) && !e.shiftKey && !e.altKey && e.key === 't' && tid) {
      e.preventDefault()
      const task = taskById(tid)
      const list = sessionsForTask(tid)
      const pickedId = selectedSessionForTask(tid)
      const current = list.find(s => s.id === pickedId) ?? list[0]
      openModelPicker({
        title: 'New session',
        placeholder: 'Select agent and model for new session...',
        defaultAgent: current?.agentType ?? task?.agentType,
        defaultModel: current?.model ?? undefined,
        onPick: async (agentType, model) => {
          const session = await createSession(tid, agentType, model)
          setSelectedSessionIdForTask(tid, session.id)
          setMainView(tid, 'session')
        },
      })
    }
    // Cmd+Alt+Right / Cmd+Alt+Left — cycle sessions in session view, cycle
    // editor tabs in file view (mirrors Ctrl+Tab below).
    if (modPressed(e) && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && tid) {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 'next' : 'prev'
      if (mainView(tid) !== 'session') {
        if (dir === 'next') nextTab(tid); else prevTab(tid)
      } else {
        const list = sessionsForTask(tid)
        const next = nextSessionIdInTask(tid, dir, list)
        if (next) setSelectedSessionIdForTask(tid, next)
      }
    }
    // Ctrl+` — toggle terminal panel (focus terminal when opening)
    if (e.ctrlKey && !e.shiftKey && e.key === '`') {
      e.preventDefault()
      toggleTerminal()
      if (tid && showTerminal()) {
        // Double-rAF: first lets display:block apply, second lets xterm measure
        requestAnimationFrame(() => requestAnimationFrame(() => focusActiveTerminal(tid)))
      }
    }
    // Ctrl+Shift+` — spawn new terminal (Shift+` produces ~ on macOS)
    if (e.ctrlKey && e.shiftKey && (e.key === '`' || e.key === '~') && tid) {
      e.preventDefault()
      if (!showTerminal()) setShowTerminal(true)
      spawnTerminal(tid, 24, 80)
    }
    // Cmd+Shift+B / F5 — toggle the project's start command
    const isStartStopKey = (modPressed(e) && e.shiftKey && e.key === 'b') || e.key === 'F5'
    if (isStartStopKey && tid) {
      e.preventDefault()
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
    // Cmd+\ — focus terminal when open
    if (modPressed(e) && e.key === '\\' && tid && showTerminal()) {
      e.preventDefault()
      focusActiveTerminal(tid)
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — switch editor tabs in file view, else
    // terminal tabs when terminal is open
    if (e.ctrlKey && e.key === 'Tab' && tid) {
      const inFileView = mainView(tid) !== 'session'
      if (inFileView) {
        e.preventDefault()
        if (e.shiftKey) prevTab(tid); else nextTab(tid)
      } else if (showTerminal()) {
        e.preventDefault()
        const terms = terminalsForTask(tid)
        if (terms.length > 1) {
          const idx = terms.findIndex(t => t.id === activeTerminalId(tid))
          const next = e.shiftKey
            ? (idx - 1 + terms.length) % terms.length
            : (idx + 1) % terms.length
          setActiveTerminalForTask(tid, terms[next].id)
          requestAnimationFrame(() => focusActiveTerminal(tid))
        }
      }
    }
    // Ctrl+1..9 — switch to terminal tab by index (terminal must be visible)
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
}
