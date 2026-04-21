import { createStore, produce } from 'solid-js/store'
import { loadInitialTaskContext, persistTaskContext } from './taskContextStorage'
import type { EditorTab, PendingGoToLineRequest } from './editorTypes'

interface TaskEditorState {
  openTabs: EditorTab[]
  activeTab: string | null
  mruStack: string[]
  recentlyClosed: EditorTab[]
  expandedDirs: string[]
  pendingClosePath: string | null
  pendingGoToLine: PendingGoToLineRequest | null
}

export interface TaskContextState {
  selectedSessionId: string | null
  pendingSessionNav: string | null
  mainView: string
  terminalOpen: boolean
  activeTerminalId: string | null
  editor: TaskEditorState
}

function createEmptyTaskEditorState(): TaskEditorState {
  return {
    openTabs: [],
    activeTab: null,
    mruStack: [],
    recentlyClosed: [],
    expandedDirs: [],
    pendingClosePath: null,
    pendingGoToLine: null,
  }
}

function createEmptyTaskContext(): TaskContextState {
  return {
    selectedSessionId: null,
    pendingSessionNav: null,
    mainView: 'session',
    terminalOpen: false,
    activeTerminalId: null,
    editor: createEmptyTaskEditorState(),
  }
}

const EMPTY_CONTEXT = createEmptyTaskContext()

export const [taskContexts, setTaskContexts] = createStore<Record<string, TaskContextState>>({})

function ensureTaskContext(taskId: string) {
  if (taskContexts[taskId]) return
  setTaskContexts(taskId, { ...createEmptyTaskContext(), ...loadInitialTaskContext(taskId) })
}

export function initTaskContext(taskId: string) {
  ensureTaskContext(taskId)
}

export function taskContext(taskId: string): TaskContextState {
  return taskContexts[taskId] ?? EMPTY_CONTEXT
}

export function selectedSessionForTask(taskId: string): string | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).selectedSessionId
}

export function setSelectedSessionForTask(taskId: string, sessionId: string | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'selectedSessionId', sessionId)
  persistTaskContext(taskId, taskContexts[taskId]!)
}

export function pendingSessionNavForTask(taskId: string): string | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).pendingSessionNav
}

export function setPendingSessionNavForTask(taskId: string, sessionId: string | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'pendingSessionNav', sessionId)
}

export function mainViewForTask(taskId: string): string {
  ensureTaskContext(taskId)
  return taskContext(taskId).mainView
}

export function setMainViewForTask(taskId: string, view: string) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'mainView', view)
  persistTaskContext(taskId, taskContexts[taskId]!)
}

export function terminalOpenForTask(taskId: string): boolean {
  ensureTaskContext(taskId)
  return taskContext(taskId).terminalOpen
}

export function setTerminalOpenForTask(taskId: string, open: boolean) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'terminalOpen', open)
  persistTaskContext(taskId, taskContexts[taskId]!)
}

export function activeTerminalForTask(taskId: string): string | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).activeTerminalId
}

export function setActiveTerminalForTaskContext(taskId: string, terminalId: string | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'activeTerminalId', terminalId)
}

export function clearTaskContext(taskId: string) {
  setTaskContexts(produce(store => {
    delete store[taskId]
  }))
}

export function openTabsForTask(taskId: string): EditorTab[] {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.openTabs
}

export function setOpenTabsForTask(taskId: string, tabs: EditorTab[]) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'openTabs', tabs)
}

export function activeTabForTask(taskId: string): string | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.activeTab
}

export function setActiveTabForTaskContext(taskId: string, activeTab: string | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'activeTab', activeTab)
}

export function mruStackForTask(taskId: string): string[] {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.mruStack
}

export function setMruStackForTask(taskId: string, mruStack: string[]) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'mruStack', mruStack)
}

export function recentlyClosedForTask(taskId: string): EditorTab[] {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.recentlyClosed
}

export function setRecentlyClosedForTask(taskId: string, tabs: EditorTab[]) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'recentlyClosed', tabs)
}

export function expandedDirsForTask(taskId: string): string[] {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.expandedDirs
}

export function setExpandedDirsForTask(taskId: string, paths: string[]) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'expandedDirs', paths)
}

export function pendingCloseForTask(taskId: string): string | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.pendingClosePath
}

export function setPendingCloseForTask(taskId: string, path: string | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'pendingClosePath', path)
}

export function pendingGoToLineForTask(taskId: string): PendingGoToLineRequest | null {
  ensureTaskContext(taskId)
  return taskContext(taskId).editor.pendingGoToLine
}

export function setPendingGoToLineForTask(taskId: string, request: PendingGoToLineRequest | null) {
  ensureTaskContext(taskId)
  setTaskContexts(taskId, 'editor', 'pendingGoToLine', request)
}
