import { createSignal } from 'solid-js'
import type { ModelId } from '../types'

export const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
export const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null)
export const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)

export const [sidebarWidth, setSidebarWidth] = createSignal(280)
export const [showNewTaskDialog, setShowNewTaskDialog] = createSignal(false)

// Model selection
const savedModel = (typeof localStorage !== 'undefined' ? localStorage.getItem('verun:model') : null) as ModelId | null
export const [globalModel, setGlobalModel] = createSignal<ModelId>(savedModel || 'sonnet')
export const [taskModelOverrides, setTaskModelOverrides] = createSignal<Record<string, ModelId>>({})

export function setGlobalModelAndPersist(model: ModelId) {
  setGlobalModel(model)
  localStorage.setItem('verun:model', model)
}

export function setTaskModel(taskId: string, model: ModelId) {
  setTaskModelOverrides(prev => ({ ...prev, [taskId]: model }))
}

export function effectiveModel(taskId: string | null): ModelId {
  if (taskId) {
    const override = taskModelOverrides()[taskId]
    if (override) return override
  }
  return globalModel()
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
