import { createSignal } from 'solid-js'
import type { ModelId } from '../types'
import { registerWindowedTaskChecker } from '../lib/windowContext'

export const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)

const savedTaskId = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:selectedTaskId') : null
const [_selectedTaskId, _setSelectedTaskId] = createSignal<string | null>(savedTaskId)
export const selectedTaskId = _selectedTaskId
export function setSelectedTaskId(id: string | null) {
  _setSelectedTaskId(id)
  if (id) localStorage.setItem('verun:selectedTaskId', id)
  else localStorage.removeItem('verun:selectedTaskId')
}

export const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)

// When set, the next task-selection effect should navigate to this session
// instead of defaulting to the first one. Consumed (cleared) after use.
export const [pendingSessionNav, setPendingSessionNav] = createSignal<string | null>(null)
export function consumePendingSessionNav(): string | null {
  const id = pendingSessionNav()
  if (id) setPendingSessionNav(null)
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

export const [showNewTaskDialog, setShowNewTaskDialog] = createSignal(false)

// Model selection — per task, persisted per project as the default for new tasks
const [taskModels, setTaskModels] = createSignal<Record<string, ModelId>>({})

export function setTaskModel(taskId: string, model: ModelId) {
  setTaskModels(prev => ({ ...prev, [taskId]: model }))
  localStorage.setItem(`verun:task-model:${taskId}`, model)
  const pid = selectedProjectId()
  if (pid) localStorage.setItem(`verun:model:${pid}`, model)
}

export function effectiveModel(taskId: string | null): ModelId {
  if (taskId) {
    let m = taskModels()[taskId]
    if (m) return m
    // Restore from storage on first access
    const saved = localStorage.getItem(`verun:task-model:${taskId}`) as ModelId | null
    if (saved) {
      setTaskModels(prev => ({ ...prev, [taskId]: saved }))
      return saved
    }
  }
  const pid = selectedProjectId()
  if (pid) return (localStorage.getItem(`verun:model:${pid}`) as ModelId | null) || 'sonnet'
  return 'sonnet'
}
export const [addProjectPath, setAddProjectPath] = createSignal<string | null>(null)
export const [showSettings, setShowSettings] = createSignal(false)
export const [showArchived, setShowArchived] = createSignal(false)

// Terminal panel — per-task visibility
const [taskTerminalOpen, setTaskTerminalOpen] = createSignal<Record<string, boolean>>({})

export function showTerminal(): boolean {
  const tid = selectedTaskId()
  return tid ? (taskTerminalOpen()[tid] ?? false) : false
}

export function setShowTerminal(v: boolean) {
  const tid = selectedTaskId()
  if (tid) setTaskTerminalOpen(prev => ({ ...prev, [tid]: v }))
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
  actions?: ToastAction[]
  onDismiss?: () => void
}

export interface AddToastOptions {
  id?: string
  persistent?: boolean
  duration?: number
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
  const toast: Toast = { id, message, type, persistent: opts.persistent, actions: opts.actions, onDismiss: opts.onDismiss }
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

// Shared edit-step signal — set by StepList edit button, consumed by MessageInput
export const [editStepRequest, setEditStepRequest] = createSignal<{ sessionId: string; stepId: string; message: string; attachmentsJson?: string | null } | null>(null)

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
