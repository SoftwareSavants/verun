import { createSignal } from 'solid-js'
import {
  activeTabForTask,
  expandedDirsForTask,
  mainViewForTask,
  mruStackForTask,
  openTabsForTask,
  pendingCloseForTask,
  pendingGoToLineForTask,
  recentlyClosedForTask,
  setActiveTabForTaskContext,
  setExpandedDirsForTask,
  setMainViewForTask,
  setMruStackForTask,
  setOpenTabsForTask,
  setPendingCloseForTask,
  setPendingGoToLineForTask,
  setRecentlyClosedForTask,
  taskContexts,
} from './taskContext'
import { clearTaskEditorState, loadTaskEditorState, persistTaskEditorState } from './taskContextStorage'
import type { DiffSource, EditorTab, PendingGoToLineRequest } from './editorTypes'
import { clearCachedContent, diffTabKey, getDirContents, isDiffKey, loadDirectory } from './files'
import { setRightPanelTab } from './ui'

export type { DiffSource, EditorTab } from './editorTypes'

const MAX_CLOSED = 20

function pushMru(taskId: string, relativePath: string) {
  const stack = mruStackForTask(taskId).filter(p => p !== relativePath)
  setMruStackForTask(taskId, [relativePath, ...stack])
}

function removeMru(taskId: string, relativePath: string) {
  setMruStackForTask(taskId, mruStackForTask(taskId).filter(p => p !== relativePath))
}

function persistTabState(taskId: string) {
  persistTaskEditorState(taskId, {
    tabs: openTabsForTask(taskId).map(t => ({ ...t, dirty: false })),
    activeTab: activeTabForTask(taskId),
    mainView: mainView(taskId),
    mruStack: mruStackForTask(taskId),
  })
}

export function mainView(taskId: string | null): string {
  if (!taskId) return 'session'
  return mainViewForTask(taskId)
}

export function setMainView(taskId: string, view: string) {
  if (mainViewForTask(taskId) === view) return
  setMainViewForTask(taskId, view)
}

export function pendingGoToLine(taskId: string | null): PendingGoToLineRequest | null {
  if (!taskId) return null
  return pendingGoToLineForTask(taskId)
}

export function setPendingGoToLine(request: PendingGoToLineRequest) {
  setPendingGoToLineForTask(request.taskId, request)
}

export function consumeGoToLine(taskId: string | null): PendingGoToLineRequest | null {
  if (!taskId) return null
  const request = pendingGoToLineForTask(taskId)
  setPendingGoToLineForTask(taskId, null)
  return request
}

export function pendingClose(taskId: string | null): string | null {
  if (!taskId) return null
  return pendingCloseForTask(taskId)
}

export function isExpanded(taskId: string, path: string): boolean {
  return expandedDirsForTask(taskId).includes(path)
}

export function toggleExpanded(taskId: string, path: string) {
  const taskDirs = new Set(expandedDirsForTask(taskId))
  if (taskDirs.has(path)) taskDirs.delete(path)
  else taskDirs.add(path)
  setExpandedDirsForTask(taskId, [...taskDirs])
}

export function expandDir(taskId: string, path: string) {
  const taskDirs = new Set(expandedDirsForTask(taskId))
  taskDirs.add(path)
  setExpandedDirsForTask(taskId, [...taskDirs])
}

export function collapseDir(taskId: string, path: string) {
  const taskDirs = new Set(expandedDirsForTask(taskId))
  taskDirs.delete(path)
  setExpandedDirsForTask(taskId, [...taskDirs])
}

export function restoreTabState(taskId: string): boolean {
  if (openTabsForTask(taskId).length > 0) return false

  try {
    const state = loadTaskEditorState(taskId)
    if (!state?.tabs?.length) return false

    setOpenTabsForTask(taskId, state.tabs as EditorTab[])
    setActiveTabForTaskContext(taskId, state.activeTab)
    setMainView(taskId, state.mainView ?? 'session')
    setMruStackForTask(taskId, state.mruStack ?? [])
    return true
  } catch {
    return false
  }
}

export function openTabs(taskId: string | null): EditorTab[] {
  if (!taskId) return []
  return openTabsForTask(taskId)
}

export function allOpenTabs(): Record<string, EditorTab[]> {
  const out: Record<string, EditorTab[]> = {}
  for (const [taskId, ctx] of Object.entries(taskContexts)) {
    out[taskId] = ctx.editor.openTabs
  }
  return out
}

export function activeTabPath(taskId: string | null): string | null {
  if (!taskId) return null
  return activeTabForTask(taskId)
}

export function recentlyClosed(taskId: string | null): EditorTab[] {
  if (!taskId) return []
  return recentlyClosedForTask(taskId)
}

export function openFile(taskId: string, relativePath: string, name: string) {
  const tabs = openTabs(taskId)
  const already = tabs.some(t => t.relativePath === relativePath)

  if (already) {
    setActiveTabForTaskContext(taskId, relativePath)
    setMainView(taskId, relativePath)
    pushMru(taskId, relativePath)
    persistTabState(taskId)
    return
  }

  const withoutPreview = tabs.filter(t => !t.preview)
  setOpenTabsForTask(taskId, [...withoutPreview, { relativePath, name, dirty: false, preview: true }])
  setActiveTabForTaskContext(taskId, relativePath)
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

export function openFilePinned(taskId: string, relativePath: string, name: string) {
  const tabs = openTabs(taskId)
  const existing = tabs.find(t => t.relativePath === relativePath)

  if (existing) {
    if (existing.preview) {
      setOpenTabsForTask(taskId, tabs.map(t => t.relativePath === relativePath ? { ...t, preview: false } : t))
    }
    if (activeTabPath(taskId) !== relativePath) {
      setActiveTabForTaskContext(taskId, relativePath)
    }
    setMainView(taskId, relativePath)
    pushMru(taskId, relativePath)
    persistTabState(taskId)
    return
  }

  const withoutPreview = tabs.filter(t => !t.preview)
  setOpenTabsForTask(taskId, [...withoutPreview, { relativePath, name, dirty: false, preview: false }])
  setActiveTabForTaskContext(taskId, relativePath)
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

export function openDiffTab(taskId: string, relativePath: string, source: DiffSource, opts?: { pinned?: boolean }) {
  const key = diffTabKey(source, relativePath)
  const name = relativePath.split('/').pop() ?? relativePath
  const tabs = openTabs(taskId)
  const existing = tabs.find(t => t.relativePath === key)

  if (existing) {
    const alreadyActive = activeTabPath(taskId) === key && mainView(taskId) === key
    const needsPin = opts?.pinned && existing.preview
    if (alreadyActive && !needsPin) return
    if (needsPin) {
      setOpenTabsForTask(taskId, tabs.map(t => t.relativePath === key ? { ...t, preview: false } : t))
    }
    if (!alreadyActive) {
      setActiveTabForTaskContext(taskId, key)
      setMainView(taskId, key)
      pushMru(taskId, key)
    }
    persistTabState(taskId)
    return
  }

  const withoutPreview = tabs.filter(t => !t.preview)
  const newTab: EditorTab = {
    relativePath: key,
    name,
    dirty: false,
    preview: !opts?.pinned,
    kind: 'diff',
    diffPath: relativePath,
    diffSource: source,
  }
  setOpenTabsForTask(taskId, [...withoutPreview, newTab])
  setActiveTabForTaskContext(taskId, key)
  setMainView(taskId, key)
  pushMru(taskId, key)
  persistTabState(taskId)
}

export function pinTab(taskId: string, relativePath: string) {
  setOpenTabsForTask(taskId, openTabs(taskId).map(t => t.relativePath === relativePath ? { ...t, preview: false } : t))
  persistTabState(taskId)
}

export function requestCloseTab(taskId: string, relativePath: string) {
  const tab = openTabs(taskId).find(t => t.relativePath === relativePath)
  if (tab?.dirty) {
    setPendingCloseForTask(taskId, relativePath)
    return
  }
  forceCloseTab(taskId, relativePath)
}

export function forceCloseTab(taskId: string, relativePath: string) {
  const tabs = openTabs(taskId)
  const tab = tabs.find(t => t.relativePath === relativePath)
  if (tab) {
    if (tab.dirty) clearCachedContent(taskId, relativePath)
    setRecentlyClosedForTask(taskId, [{ ...tab, dirty: false }, ...recentlyClosedForTask(taskId)].slice(0, MAX_CLOSED))
  }

  const filtered = tabs.filter(t => t.relativePath !== relativePath)
  setOpenTabsForTask(taskId, filtered)
  removeMru(taskId, relativePath)

  for (const fn of tabCloseListeners) fn(taskId, relativePath)

  if (activeTabPath(taskId) === relativePath) {
    const mru = mruStackForTask(taskId).find(p => p !== relativePath && filtered.some(t => t.relativePath === p))
    const newActive = mru ?? (filtered.length > 0 ? filtered[filtered.length - 1].relativePath : null)
    setActiveTabForTaskContext(taskId, newActive)
    if (!newActive) setMainView(taskId, 'session')
    else setMainView(taskId, newActive)
  }

  setPendingCloseForTask(taskId, null)
  persistTabState(taskId)
}

export function cancelCloseTab(taskId: string) {
  setPendingCloseForTask(taskId, null)
}

export function reopenClosedTab(taskId: string) {
  const stack = recentlyClosed(taskId)
  if (stack.length === 0) return
  const tab = stack[0]
  setRecentlyClosedForTask(taskId, stack.slice(1))
  if (tab.kind === 'diff' && tab.diffPath && tab.diffSource) {
    openDiffTab(taskId, tab.diffPath, tab.diffSource)
  } else {
    openFile(taskId, tab.relativePath, tab.name)
  }
}

export function setTabDirty(taskId: string, relativePath: string, dirty: boolean) {
  setOpenTabsForTask(taskId, openTabs(taskId).map(t => (
    t.relativePath === relativePath ? { ...t, dirty, preview: dirty ? false : t.preview } : t
  )))
}

export function setActiveTab(taskId: string, relativePath: string) {
  setActiveTabForTaskContext(taskId, relativePath)
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

type TabCloseListener = (taskId: string, relativePath: string) => void
const tabCloseListeners: TabCloseListener[] = []

export function onTabClose(listener: TabCloseListener): () => void {
  tabCloseListeners.push(listener)
  return () => {
    const idx = tabCloseListeners.indexOf(listener)
    if (idx >= 0) tabCloseListeners.splice(idx, 1)
  }
}

type TaskCleanupListener = (taskId: string) => void
const taskCleanupListeners: TaskCleanupListener[] = []

export function onTaskCleanup(listener: TaskCleanupListener): () => void {
  taskCleanupListeners.push(listener)
  return () => {
    const idx = taskCleanupListeners.indexOf(listener)
    if (idx >= 0) taskCleanupListeners.splice(idx, 1)
  }
}

export function fireTaskCleanup(taskId: string) {
  clearTaskEditorState(taskId)
  for (const fn of taskCleanupListeners) fn(taskId)
}

let revealCounter = 0
const [_revealRequest, _setRevealRequest] = createSignal<{ taskId: string; relativePath: string; seq: number } | null>(null)
export const revealRequest = _revealRequest

export async function revealFileInTree(taskId: string, relativePath: string) {
  if (isDiffKey(relativePath)) return

  const parts = relativePath.split('/')
  const ancestors: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'))
  }

  for (const dir of ancestors) {
    if (!getDirContents(taskId, dir)) {
      await loadDirectory(taskId, dir)
    }
    expandDir(taskId, dir)
  }

  setRightPanelTab('files')
  _setRevealRequest({ taskId, relativePath, seq: ++revealCounter })
}

export function nextTab(taskId: string) {
  const tabs = openTabs(taskId)
  if (tabs.length < 2) return
  const mru = mruStackForTask(taskId)
  const active = activeTabPath(taskId)
  const next = mru.find(p => p !== active && tabs.some(t => t.relativePath === p))
  if (next) {
    setActiveTabForTaskContext(taskId, next)
    setMainView(taskId, next)
    pushMru(taskId, next)
    persistTabState(taskId)
    revealFileInTree(taskId, next)
  }
}

export function prevTab(taskId: string) {
  const tabs = openTabs(taskId)
  if (tabs.length < 2) return
  const mru = mruStackForTask(taskId)
  const active = activeTabPath(taskId)
  const candidates = mru.filter(p => p !== active && tabs.some(t => t.relativePath === p))
  const prev = candidates.length > 0 ? candidates[candidates.length - 1] : null
  if (prev) {
    setActiveTabForTaskContext(taskId, prev)
    setMainView(taskId, prev)
    pushMru(taskId, prev)
    persistTabState(taskId)
    revealFileInTree(taskId, prev)
  }
}

export function closeAllTabs(taskId: string) {
  const tabs = openTabs(taskId)
  const dirty = tabs.filter(t => t.dirty)
  if (dirty.length > 0) {
    for (const t of tabs.filter(t => !t.dirty)) {
      forceCloseTab(taskId, t.relativePath)
    }
    const remaining = openTabs(taskId)
    if (remaining.length > 0) setPendingCloseForTask(taskId, remaining[0].relativePath)
    return
  }
  for (const t of tabs) forceCloseTab(taskId, t.relativePath)
}

export function closeOtherTabs(taskId: string, keepPath: string) {
  for (const t of openTabs(taskId).filter(t => t.relativePath !== keepPath)) {
    if (t.dirty) continue
    forceCloseTab(taskId, t.relativePath)
  }
  setActiveTab(taskId, keepPath)
}
