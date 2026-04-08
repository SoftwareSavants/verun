import { createSignal } from 'solid-js'
import type { ModelId } from '../types'

export const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
export const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null)
export const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)

export const [sidebarWidth, setSidebarWidth] = createSignal(280)
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
export const [showAddProjectDialog, setShowAddProjectDialog] = createSignal(false)
export const [showSettings, setShowSettings] = createSignal(false)

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

export interface Toast {
  id: string
  message: string
  type: 'info' | 'error' | 'success'
}

export const [toasts, setToasts] = createSignal<Toast[]>([])

export function addToast(message: string, type: Toast['type'] = 'info') {
  const id = crypto.randomUUID()
  setToasts(prev => [...prev, { id, message, type }])
  setTimeout(() => dismissToast(id), 5000)
}

export function dismissToast(id: string) {
  setToasts(prev => prev.filter(t => t.id !== id))
}
