import { createSignal } from 'solid-js'

export const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
export const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null)
export const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)

export const [sidebarWidth, setSidebarWidth] = createSignal(280)
export const [showNewTaskDialog, setShowNewTaskDialog] = createSignal(false)
export const [showAddProjectDialog, setShowAddProjectDialog] = createSignal(false)

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
