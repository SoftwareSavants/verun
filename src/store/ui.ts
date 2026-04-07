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
export const [sessionModelOverrides, setSessionModelOverrides] = createSignal<Record<string, ModelId>>({})

export function setGlobalModelAndPersist(model: ModelId) {
  setGlobalModel(model)
  localStorage.setItem('verun:model', model)
}

export function setSessionModel(sessionId: string, model: ModelId) {
  setSessionModelOverrides(prev => ({ ...prev, [sessionId]: model }))
}

export function effectiveModel(sessionId: string | null): ModelId {
  if (sessionId) {
    const override = sessionModelOverrides()[sessionId]
    if (override) return override
  }
  return globalModel()
}
export const [showAddProjectDialog, setShowAddProjectDialog] = createSignal(false)
export const [showSettings, setShowSettings] = createSignal(false)

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
