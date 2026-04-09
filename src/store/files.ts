import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { FileEntry } from '../types'
import * as ipc from '../lib/ipc'

// Directory contents cache: keyed by "taskId:relativePath"
const [dirContents, setDirContents] = createStore<Record<string, FileEntry[]>>({})

// Expanded directories per task
const [expandedDirs, setExpandedDirs] = createSignal<Record<string, Set<string>>>({})

// Open editor tabs
export interface EditorTab {
  relativePath: string
  name: string
  dirty: boolean
}

const [openTabs, setOpenTabs] = createSignal<EditorTab[]>([])
const [activeTabPath, setActiveTabPath] = createSignal<string | null>(null)

// Recently closed tabs (for reopen)
const MAX_CLOSED = 20
const [recentlyClosed, setRecentlyClosed] = createSignal<EditorTab[]>([])

// Pending close confirmation
const [pendingClose, setPendingClose] = createSignal<string | null>(null)

export { pendingClose, setPendingClose }

// Right panel tab
const savedRightTab = typeof localStorage !== 'undefined' ? localStorage.getItem('verun:rightPanelTab') : null
const [rightPanelTab, setRightPanelTabRaw] = createSignal<'changes' | 'files'>(
  (savedRightTab as 'changes' | 'files') || 'changes'
)

export function setRightPanelTab(tab: 'changes' | 'files') {
  setRightPanelTabRaw(tab)
  localStorage.setItem('verun:rightPanelTab', tab)
}

export { rightPanelTab }

// Directory loading

function cacheKey(taskId: string, relativePath: string) {
  return `${taskId}:${relativePath}`
}

export function getDirContents(taskId: string, relativePath: string): FileEntry[] | undefined {
  return dirContents[cacheKey(taskId, relativePath)]
}

export async function loadDirectory(taskId: string, relativePath: string) {
  const key = cacheKey(taskId, relativePath)
  const entries = await ipc.listDirectory(taskId, relativePath)
  setDirContents(key, entries)
}

export function invalidateDirectory(taskId: string, relativePath: string) {
  const key = cacheKey(taskId, relativePath)
  if (dirContents[key]) {
    loadDirectory(taskId, relativePath)
  }
}

export function clearTaskFileCache(taskId: string) {
  const keys = Object.keys(dirContents).filter(k => k.startsWith(`${taskId}:`))
  for (const key of keys) {
    setDirContents(key, undefined!)
  }
}

// Expand / collapse

export function isExpanded(taskId: string, path: string): boolean {
  return expandedDirs()[taskId]?.has(path) ?? false
}

export function toggleExpanded(taskId: string, path: string) {
  setExpandedDirs(prev => {
    const taskDirs = new Set(prev[taskId] || [])
    if (taskDirs.has(path)) {
      taskDirs.delete(path)
    } else {
      taskDirs.add(path)
    }
    return { ...prev, [taskId]: taskDirs }
  })
}

export function expandDir(taskId: string, path: string) {
  setExpandedDirs(prev => {
    const taskDirs = new Set(prev[taskId] || [])
    taskDirs.add(path)
    return { ...prev, [taskId]: taskDirs }
  })
}

export function collapseDir(taskId: string, path: string) {
  setExpandedDirs(prev => {
    const taskDirs = new Set(prev[taskId] || [])
    taskDirs.delete(path)
    return { ...prev, [taskId]: taskDirs }
  })
}

// Editor tabs

export { openTabs, activeTabPath, recentlyClosed }

export function openFile(relativePath: string, name: string) {
  setOpenTabs(prev => {
    if (prev.some(t => t.relativePath === relativePath)) return prev
    return [...prev, { relativePath, name, dirty: false }]
  })
  setActiveTabPath(relativePath)
}

/** Try to close a tab. If dirty, sets pendingClose instead. */
export function requestCloseTab(relativePath: string) {
  const tab = openTabs().find(t => t.relativePath === relativePath)
  if (tab?.dirty) {
    setPendingClose(relativePath)
    return
  }
  forceCloseTab(relativePath)
}

/** Close a tab regardless of dirty state, pushing it to recentlyClosed. */
export function forceCloseTab(relativePath: string) {
  const tab = openTabs().find(t => t.relativePath === relativePath)
  if (tab) {
    setRecentlyClosed(prev => [{ ...tab, dirty: false }, ...prev].slice(0, MAX_CLOSED))
  }
  setOpenTabs(prev => {
    const filtered = prev.filter(t => t.relativePath !== relativePath)
    if (activeTabPath() === relativePath) {
      setActiveTabPath(filtered.length > 0 ? filtered[filtered.length - 1].relativePath : null)
    }
    return filtered
  })
  setPendingClose(null)
}

/** Cancel a pending close. */
export function cancelCloseTab() {
  setPendingClose(null)
}

/** Reopen the most recently closed tab. */
export function reopenClosedTab() {
  const stack = recentlyClosed()
  if (stack.length === 0) return
  const tab = stack[0]
  setRecentlyClosed(prev => prev.slice(1))
  openFile(tab.relativePath, tab.name)
}

// Legacy alias for direct close (used internally)
export function closeTab(relativePath: string) {
  requestCloseTab(relativePath)
}

export function setTabDirty(relativePath: string, dirty: boolean) {
  setOpenTabs(prev =>
    prev.map(t => t.relativePath === relativePath ? { ...t, dirty } : t)
  )
}

export function setActiveTab(relativePath: string) {
  setActiveTabPath(relativePath)
}

// Quick open overlay
const [showQuickOpen, setShowQuickOpen] = createSignal(false)
export { showQuickOpen, setShowQuickOpen }

/** Switch to next tab. */
export function nextTab() {
  const tabs = openTabs()
  if (tabs.length < 2) return
  const idx = tabs.findIndex(t => t.relativePath === activeTabPath())
  setActiveTabPath(tabs[(idx + 1) % tabs.length].relativePath)
}

/** Switch to previous tab. */
export function prevTab() {
  const tabs = openTabs()
  if (tabs.length < 2) return
  const idx = tabs.findIndex(t => t.relativePath === activeTabPath())
  setActiveTabPath(tabs[(idx - 1 + tabs.length) % tabs.length].relativePath)
}

/** Close all tabs (with optional dirty check). */
export function closeAllTabs() {
  const dirty = openTabs().filter(t => t.dirty)
  if (dirty.length > 0) {
    // Close non-dirty, leave dirty ones
    const nonDirty = openTabs().filter(t => !t.dirty)
    for (const t of nonDirty) forceCloseTab(t.relativePath)
    if (openTabs().length > 0) setPendingClose(openTabs()[0].relativePath)
    return
  }
  for (const t of openTabs()) forceCloseTab(t.relativePath)
}

/** Close all tabs except the given one. */
export function closeOtherTabs(keepPath: string) {
  const others = openTabs().filter(t => t.relativePath !== keepPath)
  for (const t of others) {
    if (t.dirty) continue
    forceCloseTab(t.relativePath)
  }
  setActiveTabPath(keepPath)
}
