import type { TaskContextState } from './taskContext'
import type { DiffSource, EditorTab } from './editorTypes'

interface PersistedTaskContext {
  selectedSessionId?: string | null
  mainView?: string
  editor?: PersistedEditorState
}

export interface PersistedEditorTab {
  relativePath: EditorTab['relativePath']
  name: EditorTab['name']
  dirty: EditorTab['dirty']
  preview: EditorTab['preview']
  kind?: EditorTab['kind']
  diffPath?: EditorTab['diffPath']
  diffSource?: DiffSource
}

export interface PersistedEditorState {
  tabs: PersistedEditorTab[]
  activeTab: string | null
  mainView?: string
  mruStack: string[]
}

function storageKey(taskId: string) {
  return `verun:taskContext:${taskId}`
}

function legacyEditorStorageKey(taskId: string) {
  return `verun:editorTabs:${taskId}`
}

function readPersistedTaskContext(taskId: string): PersistedTaskContext | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(taskId))
    return raw ? JSON.parse(raw) as PersistedTaskContext : null
  } catch {
    return null
  }
}

export function loadInitialTaskContext(taskId: string): Partial<TaskContextState> {
  if (typeof localStorage === 'undefined') return {}

  const persisted = readPersistedTaskContext(taskId)

  let legacyMainView: string | undefined
  try {
    const raw = localStorage.getItem(legacyEditorStorageKey(taskId))
    if (raw) {
      const state = JSON.parse(raw) as PersistedEditorState
      legacyMainView = state.mainView
    }
  } catch {
    legacyMainView = undefined
  }

  return {
    selectedSessionId: persisted?.selectedSessionId ?? localStorage.getItem(`verun:lastSession:${taskId}`),
    mainView: persisted?.mainView ?? persisted?.editor?.mainView ?? legacyMainView ?? 'session',
  }
}

export function persistTaskContext(taskId: string, ctx: TaskContextState) {
  if (typeof localStorage === 'undefined') return

  const previous = readPersistedTaskContext(taskId)
  const persisted: PersistedTaskContext = {
    ...previous,
    selectedSessionId: ctx.selectedSessionId,
    mainView: ctx.mainView,
  }

  try {
    localStorage.setItem(storageKey(taskId), JSON.stringify(persisted))
  } catch {
    // Ignore storage quota failures.
  }
}

export function loadTaskEditorState(taskId: string): PersistedEditorState | null {
  if (typeof localStorage === 'undefined') return null

  const persisted = readPersistedTaskContext(taskId)
  if (persisted?.editor) return persisted.editor

  try {
    const raw = localStorage.getItem(legacyEditorStorageKey(taskId))
    return raw ? JSON.parse(raw) as PersistedEditorState : null
  } catch {
    return null
  }
}

export function persistTaskEditorState(taskId: string, state: PersistedEditorState) {
  if (typeof localStorage === 'undefined') return

  const previous = readPersistedTaskContext(taskId)
  const persisted: PersistedTaskContext = {
    ...previous,
    mainView: state.mainView,
    editor: state,
  }

  try {
    localStorage.setItem(storageKey(taskId), JSON.stringify(persisted))
  } catch {
    // Ignore storage quota failures.
  }
}

export function clearTaskEditorState(taskId: string) {
  if (typeof localStorage === 'undefined') return

  const previous = readPersistedTaskContext(taskId)
  if (previous?.editor) {
    const next = { ...previous }
    delete next.editor
    try {
      localStorage.setItem(storageKey(taskId), JSON.stringify(next))
    } catch {
      // Ignore storage quota failures.
    }
  }

  localStorage.removeItem(legacyEditorStorageKey(taskId))
}

export function clearTaskContextStorage(taskId: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(storageKey(taskId))
  localStorage.removeItem(`verun:lastSession:${taskId}`)
  localStorage.removeItem(legacyEditorStorageKey(taskId))
}
