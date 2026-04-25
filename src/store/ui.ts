import { createSignal } from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { registerWindowedTaskChecker } from '../lib/windowContext'
import { pendingSessionNavForTask, selectedSessionForTask, setPendingSessionNavForTask, setSelectedSessionForTask, setTerminalOpenForTask, terminalOpenForTask } from './taskContext'
import { openTaskWindow } from '../lib/ipc'

export const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)

const savedTaskId = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:selectedTaskId') : null
const [_selectedTaskId, _setSelectedTaskId] = createSignal<string | null>(savedTaskId)
export const selectedTaskId = _selectedTaskId
export function setSelectedTaskId(id: string | null) {
  _setSelectedTaskId(id)
  if (id) localStorage.setItem('verun:selectedTaskId', id)
  else localStorage.removeItem('verun:selectedTaskId')
}

export function getLastSessionForTask(taskId: string): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(`verun:lastSession:${taskId}`) : null
}

export function setLastSessionForTask(taskId: string, sessionId: string | null) {
  if (sessionId) localStorage.setItem(`verun:lastSession:${taskId}`, sessionId)
  else localStorage.removeItem(`verun:lastSession:${taskId}`)
}

export function selectedSessionId(): string | null {
  const taskId = selectedTaskId()
  return taskId ? selectedSessionForTask(taskId) : null
}

export function setSelectedSessionId(id: string | null) {
  const taskId = selectedTaskId()
  if (!taskId) return
  setSelectedSessionForTask(taskId, id)
  setLastSessionForTask(taskId, id)
}

// When set, the next task-selection effect should navigate to this session
// instead of defaulting to the first one. Consumed (cleared) after use.
export function setPendingSessionNav(id: string | null, taskId: string | null = selectedTaskId()) {
  if (!taskId) return
  setPendingSessionNavForTask(taskId, id)
}

export function consumePendingSessionNav(taskId: string | null = selectedTaskId()): string | null {
  if (!taskId) return null
  const id = pendingSessionNavForTask(taskId)
  if (id) setPendingSessionNavForTask(taskId, null)
  return id
}

// Unread / attention-required indicators for sidebar tasks
// "unread" = new output arrived while the task wasn't selected
// "attention" = pending tool approval that needs user action
// Both are persisted to localStorage so they survive reloads.

const UNREAD_KEY = 'verun:unreadTasks'
const ATTENTION_KEY = 'verun:attentionTasks'

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch { return new Set() }
}

function persistSet(key: string, set: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...set]))
}

const [_unreadTaskIds, _setUnreadTaskIds] = createSignal<Set<string>>(loadSet(UNREAD_KEY))
const [_attentionTaskIds, _setAttentionTaskIds] = createSignal<Set<string>>(loadSet(ATTENTION_KEY))

export const isTaskUnread = (id: string) => _unreadTaskIds().has(id)
export const isTaskAttention = (id: string) => _attentionTaskIds().has(id)

export function markTaskUnread(taskId: string) {
  if (taskId === selectedTaskId()) return
  _setUnreadTaskIds(prev => { const s = new Set(prev); s.add(taskId); persistSet(UNREAD_KEY, s); return s })
}

export function markTaskAttention(taskId: string) {
  if (taskId === selectedTaskId()) return
  _setAttentionTaskIds(prev => { const s = new Set(prev); s.add(taskId); persistSet(ATTENTION_KEY, s); return s })
}

export function clearTaskAttention(taskId: string) {
  _setAttentionTaskIds(prev => { const s = new Set(prev); s.delete(taskId); persistSet(ATTENTION_KEY, s); return s })
}

export function clearTaskIndicators(taskId: string) {
  _setUnreadTaskIds(prev => { const s = new Set(prev); s.delete(taskId); persistSet(UNREAD_KEY, s); return s })
  _setAttentionTaskIds(prev => { const s = new Set(prev); s.delete(taskId); persistSet(ATTENTION_KEY, s); return s })
}

// Unread indicators for session tabs (in-memory only, no persistence needed)
const [_unreadSessionIds, _setUnreadSessionIds] = createSignal<Set<string>>(new Set())

export const isSessionUnread = (id: string) => _unreadSessionIds().has(id)

export function markSessionUnread(sessionId: string) {
  if (sessionId === selectedSessionId()) return
  _setUnreadSessionIds(prev => { const s = new Set(prev); s.add(sessionId); return s })
}

export function clearSessionUnread(sessionId: string) {
  _setUnreadSessionIds(prev => { const s = new Set(prev); s.delete(sessionId); return s })
}

export const [sidebarWidth, setSidebarWidth] = createSignal(280)

const savedRightPanelWidth = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:rightPanelWidth') : null
export const [rightPanelWidth, setRightPanelWidth] = createSignal(savedRightPanelWidth ? parseInt(savedRightPanelWidth, 10) : 280)

export type RightPanelTab = 'changes' | 'files' | 'search' | 'actions'

const savedRightTab = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:rightPanelTab') : null
const [_rightPanelTab, _setRightPanelTab] = createSignal<RightPanelTab>(
  (savedRightTab as RightPanelTab) || 'changes'
)
export const rightPanelTab = _rightPanelTab
export function setRightPanelTab(tab: RightPanelTab) {
  _setRightPanelTab(tab)
  localStorage.setItem('verun:rightPanelTab', tab)
}

// Incremented whenever the user invokes Cmd+Shift+F so the search panel knows
// to focus its input even if it's already open.
export const [focusSearchRequest, setFocusSearchRequest] = createSignal(0)

export const [showNewTaskDialog, setShowNewTaskDialog] = createSignal(false)

// Set to a project id to open the New Task dialog for that project. Shared
// across Layout, Sidebar, and post-addProject flows so every entry point that
// creates a project can open the dialog consistently.
export const [newTaskProjectId, setNewTaskProjectId] = createSignal<string | null>(null)

export function requestNewTaskForProject(projectId: string) {
  setNewTaskProjectId(projectId)
}

export const [addProjectPath, setAddProjectPath] = createSignal<string | null>(null)

// Open the native directory picker and route the selected path through the
// AddProjectDialog (by setting addProjectPath). Every "add project" entry point
// must go through this so users always see the hooks / start-command dialog
// before the New Task dialog opens on success.
export async function pickAndAddProject() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (selected) setAddProjectPath(selected as string)
}

export const [showBtsBuilder, setShowBtsBuilder] = createSignal(false)

export const [showSettings, setShowSettings] = createSignal(false)
export const [showArchived, setShowArchived] = createSignal(false)
export const [showQuickOpen, setShowQuickOpen] = createSignal(false)

export function showTerminal(): boolean {
  const tid = selectedTaskId()
  return tid ? terminalOpenForTask(tid) : false
}

export function setShowTerminal(v: boolean) {
  const tid = selectedTaskId()
  if (tid) setTerminalOpenForTask(tid, v)
}

export function toggleTerminal() {
  setShowTerminal(!showTerminal())
}

const savedTerminalHeight = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:terminalHeight') : null
export const [terminalHeight, setTerminalHeight] = createSignal(savedTerminalHeight ? parseInt(savedTerminalHeight, 10) : 250)

export function setTerminalHeightAndPersist(h: number) {
  setTerminalHeight(h)
  localStorage.setItem('verun:terminalHeight', String(h))
}

// Problems panel height (shared, persisted)
const savedProblemsHeight = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:problemsHeight') : null
export const [problemsHeight, setProblemsHeight] = createSignal(savedProblemsHeight ? parseInt(savedProblemsHeight, 10) : 200)

export function setProblemsHeightAndPersist(h: number) {
  setProblemsHeight(h)
  localStorage.setItem('verun:problemsHeight', String(h))
}

// Code changes defaults
const savedWrapDefault = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:defaultWrapLines') : null
export const [defaultWrapLines, setDefaultWrapLines] = createSignal(savedWrapDefault !== null ? savedWrapDefault === 'true' : true)

const savedHideWsDefault = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:defaultHideWhitespace') : null
export const [defaultHideWhitespace, setDefaultHideWhitespace] = createSignal(savedHideWsDefault === 'true')

export function setDefaultWrapLinesAndPersist(v: boolean) {
  setDefaultWrapLines(v)
  localStorage.setItem('verun:defaultWrapLines', String(v))
}

export function setDefaultHideWhitespaceAndPersist(v: boolean) {
  setDefaultHideWhitespace(v)
  localStorage.setItem('verun:defaultHideWhitespace', String(v))
}

export interface ToastAction {
  label: string
  variant?: 'primary' | 'danger' | 'ghost'
  onClick: () => void | Promise<void>
}

export interface Toast {
  id: string
  message: string
  type: 'info' | 'error' | 'success'
  persistent?: boolean
  loading?: boolean
  actions?: ToastAction[]
  onDismiss?: () => void
}

export interface AddToastOptions {
  id?: string
  persistent?: boolean
  duration?: number
  loading?: boolean
  actions?: ToastAction[]
  onDismiss?: () => void
}

export const [toasts, setToasts] = createSignal<Toast[]>([])
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function addToast(
  message: string,
  type: Toast['type'] = 'info',
  opts: AddToastOptions = {},
): string {
  const id = opts.id ?? crypto.randomUUID()
  const toast: Toast = { id, message, type, persistent: opts.persistent, loading: opts.loading, actions: opts.actions, onDismiss: opts.onDismiss }
  setToasts(prev => {
    const existing = prev.findIndex(t => t.id === id)
    if (existing >= 0) {
      const next = prev.slice()
      next[existing] = toast
      return next
    }
    return [...prev, toast]
  })
  const existingTimer = toastTimers.get(id)
  if (existingTimer) clearTimeout(existingTimer)
  toastTimers.delete(id)
  if (!opts.persistent) {
    const timer = setTimeout(() => dismissToast(id), opts.duration ?? 5000)
    toastTimers.set(id, timer)
  }
  return id
}

export function dismissToast(id: string) {
  const timer = toastTimers.get(id)
  if (timer) clearTimeout(timer)
  toastTimers.delete(id)
  setToasts(prev => {
    const toast = prev.find(t => t.id === id)
    toast?.onDismiss?.()
    return prev.filter(t => t.id !== id)
  })
}

// Shared chat-prefill signal — set by the editor's merged hover ("Ask agent to fix")
// button and consumed by MessageInput. Draft is set but NOT sent — the user
// reviews and sends manually.
export const [chatPrefillRequest, setChatPrefillRequest] = createSignal<{ text: string } | null>(null)

// Tracks which tasks are currently open in a separate window
const [_windowedTaskIds, _setWindowedTaskIds] = createSignal<Set<string>>(new Set())
export const isTaskWindowed = (id: string) => _windowedTaskIds().has(id)

export function markTaskWindowed(taskId: string, open: boolean) {
  _setWindowedTaskIds(prev => {
    const next = new Set(prev)
    if (open) next.add(taskId)
    else next.delete(taskId)
    return next
  })
  if (open) {
    clearTaskIndicators(taskId)
    if (selectedTaskId() === taskId) setSelectedTaskId(null)
  }
}

// Register the windowed-task checker so windowContext can use it without circular deps
registerWindowedTaskChecker(isTaskWindowed)

// Single entry point for "user wants to look at task X": if the task is open in
// its own OS window, focus that window; otherwise select it in the main view.
// Keeps Sidebar clicks and Cmd+Number shortcuts consistent.
export function focusOrSelectTask(task: { id: string; projectId: string; name: string | null }) {
  if (isTaskWindowed(task.id)) {
    openTaskWindow(task.id, task.name || undefined)
    return
  }
  setSelectedTaskId(task.id)
  setSelectedProjectId(task.projectId)
  setShowSettings(false)
  setShowArchived(false)
}
