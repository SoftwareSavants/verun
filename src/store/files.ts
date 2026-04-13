import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { FileEntry } from '../types'
import * as ipc from '../lib/ipc'

// Directory contents cache: keyed by "taskId:relativePath"
const [dirContents, setDirContents] = createStore<Record<string, FileEntry[]>>({})

// Expanded directories per task
const [expandedDirs, setExpandedDirs] = createSignal<Record<string, Set<string>>>({})

// Open editor tabs — per task
export type DiffSource = { type: 'working' } | { type: 'commit'; commitHash: string }

export interface EditorTab {
  /** Unique tab key. For files this is the relative path. For diffs it's a synthetic key (see diffTabKey). */
  relativePath: string
  name: string
  dirty: boolean
  preview: boolean // preview tabs get replaced when opening another file
  /** Tab variant. Defaults to 'file' when omitted (legacy persisted tabs). */
  kind?: 'file' | 'diff'
  /** Original on-disk relative path (only set for diff tabs — relativePath is synthetic). */
  diffPath?: string
  /** Diff source descriptor (only set for diff tabs). */
  diffSource?: DiffSource
}

/** Build the synthetic tab key used to identify a diff tab. */
export function diffTabKey(source: DiffSource, relativePath: string): string {
  if (source.type === 'commit') return `__diff__:commit:${source.commitHash}:${relativePath}`
  return `__diff__:working:${relativePath}`
}

/** True when a tab key/main-view value identifies a diff tab. */
export function isDiffKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith('__diff__:')
}

/** Extract the real relative path from a synthetic diff key. */
export function pathFromDiffKey(key: string): string | null {
  if (key.startsWith('__diff__:working:')) return key.slice('__diff__:working:'.length)
  const m = key.match(/^__diff__:commit:[^:]+:(.+)$/)
  return m ? m[1] : null
}

const [taskOpenTabs, setTaskOpenTabs] = createSignal<Record<string, EditorTab[]>>({})
const [taskActiveTab, setTaskActiveTab] = createSignal<Record<string, string | null>>({})

// MRU stack per task — most recently accessed tab paths (newest first)
const [taskMruStack, setTaskMruStack] = createSignal<Record<string, string[]>>({})

function pushMru(taskId: string, relativePath: string) {
  setTaskMruStack(prev => {
    const stack = (prev[taskId] ?? []).filter(p => p !== relativePath)
    return { ...prev, [taskId]: [relativePath, ...stack] }
  })
}

function removeMru(taskId: string, relativePath: string) {
  setTaskMruStack(prev => {
    const stack = (prev[taskId] ?? []).filter(p => p !== relativePath)
    return { ...prev, [taskId]: stack }
  })
}

// What the main area is showing per task: 'session' or a file relativePath
const [taskMainView, setTaskMainView] = createSignal<Record<string, string>>({})

/** Get what the main area shows for a task. 'session' = chat, anything else = file path */
export function mainView(taskId: string | null): string {
  if (!taskId) return 'session'
  return taskMainView()[taskId] ?? 'session'
}

export function setMainView(taskId: string, view: string) {
  setTaskMainView(prev => {
    if (prev[taskId] === view) return prev
    return { ...prev, [taskId]: view }
  })
}

// Recently closed tabs per task (for reopen)
const MAX_CLOSED = 20
const [taskRecentlyClosed, setTaskRecentlyClosed] = createSignal<Record<string, EditorTab[]>>({})

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

// Go-to-line navigation (set by ProblemsPanel, consumed by CodeEditor)
export const [pendingGoToLine, setPendingGoToLine] = createSignal<{ taskId: string; relativePath: string; line: number; column: number } | null>(null)
export function consumeGoToLine() { const v = pendingGoToLine(); setPendingGoToLine(null); return v }

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

// ── Tab persistence via localStorage ─────────────────────────────────

interface PersistedTabState {
  tabs: EditorTab[]
  activeTab: string | null
  mainView: string
  mruStack: string[]
}

function tabStorageKey(taskId: string) { return `verun:editorTabs:${taskId}` }

function persistTabState(taskId: string) {
  const state: PersistedTabState = {
    // Strip dirty flag — unsaved edits don't survive restart
    tabs: (taskOpenTabs()[taskId] ?? []).map(t => ({ ...t, dirty: false })),
    activeTab: taskActiveTab()[taskId] ?? null,
    mainView: taskMainView()[taskId] ?? 'session',
    mruStack: taskMruStack()[taskId] ?? [],
  }
  try { localStorage.setItem(tabStorageKey(taskId), JSON.stringify(state)) } catch { /* quota */ }
}

/** Restore tabs from localStorage when a task is first accessed. Returns true if restored. */
export function restoreTabState(taskId: string): boolean {
  // Already loaded in memory — don't overwrite
  if ((taskOpenTabs()[taskId] ?? []).length > 0) return false

  try {
    const raw = localStorage.getItem(tabStorageKey(taskId))
    if (!raw) return false
    const state: PersistedTabState = JSON.parse(raw)
    if (!state.tabs?.length) return false

    setTaskOpenTabs(prev => ({ ...prev, [taskId]: state.tabs }))
    setTaskActiveTab(prev => ({ ...prev, [taskId]: state.activeTab }))
    setTaskMainView(prev => ({ ...prev, [taskId]: state.mainView }))
    setTaskMruStack(prev => ({ ...prev, [taskId]: state.mruStack ?? [] }))
    return true
  } catch { return false }
}

function clearPersistedTabs(taskId: string) {
  try { localStorage.removeItem(tabStorageKey(taskId)) } catch { /* */ }
}

// ── Per-task editor tabs ──────────────────────────────────────────────

export function openTabs(taskId: string | null): EditorTab[] {
  if (!taskId) return []
  return taskOpenTabs()[taskId] ?? []
}

/** All open tabs across every task — used by the focus-based external-change check. */
export function allOpenTabs(): Record<string, EditorTab[]> {
  return taskOpenTabs()
}

export function activeTabPath(taskId: string | null): string | null {
  if (!taskId) return null
  return taskActiveTab()[taskId] ?? null
}

export function recentlyClosed(taskId: string | null): EditorTab[] {
  if (!taskId) return []
  return taskRecentlyClosed()[taskId] ?? []
}

/** Open a file as a preview tab (single-click). Replaces existing preview tab. */
export function openFile(taskId: string, relativePath: string, name: string) {
  const tabs = openTabs(taskId)
  const already = tabs.some(t => t.relativePath === relativePath)

  if (already) {
    setTaskActiveTab(prev => ({ ...prev, [taskId]: relativePath }))
    setMainView(taskId, relativePath)
    pushMru(taskId, relativePath)
    persistTabState(taskId)
    return
  }

  const withoutPreview = tabs.filter(t => !t.preview)
  setTaskOpenTabs(prev => ({
    ...prev,
    [taskId]: [...withoutPreview, { relativePath, name, dirty: false, preview: true }],
  }))
  setTaskActiveTab(prev => ({ ...prev, [taskId]: relativePath }))
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

/** Open a file as a permanent tab (double-click, or programmatic). */
export function openFilePinned(taskId: string, relativePath: string, name: string) {
  const tabs = openTabs(taskId)
  const existing = tabs.find(t => t.relativePath === relativePath)

  if (existing) {
    if (existing.preview) {
      setTaskOpenTabs(prev => ({
        ...prev,
        [taskId]: (prev[taskId] ?? []).map(t => t.relativePath === relativePath ? { ...t, preview: false } : t),
      }))
    }
    if (activeTabPath(taskId) !== relativePath) {
      setTaskActiveTab(prev => ({ ...prev, [taskId]: relativePath }))
    }
    setMainView(taskId, relativePath)
    pushMru(taskId, relativePath)
    persistTabState(taskId)
    return
  }

  // Replace preview tab, add as pinned
  const withoutPreview = tabs.filter(t => !t.preview)
  setTaskOpenTabs(prev => ({
    ...prev,
    [taskId]: [...withoutPreview, { relativePath, name, dirty: false, preview: false }],
  }))
  setTaskActiveTab(prev => ({ ...prev, [taskId]: relativePath }))
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

/** Open a diff as a tab in the main panel. Mirrors openFile preview semantics. */
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
      setTaskOpenTabs(prev => ({
        ...prev,
        [taskId]: (prev[taskId] ?? []).map(t => t.relativePath === key ? { ...t, preview: false } : t),
      }))
    }
    if (!alreadyActive) {
      setTaskActiveTab(prev => ({ ...prev, [taskId]: key }))
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
  setTaskOpenTabs(prev => ({ ...prev, [taskId]: [...withoutPreview, newTab] }))
  setTaskActiveTab(prev => ({ ...prev, [taskId]: key }))
  setMainView(taskId, key)
  pushMru(taskId, key)
  persistTabState(taskId)
}

/** Pin the current preview tab (called on edit or double-click). */
export function pinTab(taskId: string, relativePath: string) {
  setTaskOpenTabs(prev => {
    const tabs = prev[taskId] ?? []
    return { ...prev, [taskId]: tabs.map(t => t.relativePath === relativePath ? { ...t, preview: false } : t) }
  })
  persistTabState(taskId)
}

/** Try to close a tab. If dirty, sets pendingClose instead. */
export function requestCloseTab(taskId: string, relativePath: string) {
  const tabs = openTabs(taskId)
  const tab = tabs.find(t => t.relativePath === relativePath)
  if (tab?.dirty) {
    setPendingClose(relativePath)
    return
  }
  forceCloseTab(taskId, relativePath)
}

/** Close a tab regardless of dirty state, pushing it to recentlyClosed. */
export function forceCloseTab(taskId: string, relativePath: string) {
  const tabs = openTabs(taskId)
  const tab = tabs.find(t => t.relativePath === relativePath)
  if (tab) {
    // If closing a dirty tab without saving, clear the content cache
    // so reopening loads fresh from disk instead of stale edits
    if (tab.dirty) clearCachedContent(taskId, relativePath)
    setTaskRecentlyClosed(prev => ({
      ...prev,
      [taskId]: [{ ...tab, dirty: false }, ...(prev[taskId] ?? [])].slice(0, MAX_CLOSED),
    }))
  }
  const filtered = tabs.filter(t => t.relativePath !== relativePath)
  setTaskOpenTabs(prev => ({ ...prev, [taskId]: filtered }))
  removeMru(taskId, relativePath)
  for (const fn of tabCloseListeners) fn(taskId, relativePath)

  if (activeTabPath(taskId) === relativePath) {
    // Fall back to the most recently used tab
    const mru = (taskMruStack()[taskId] ?? []).find(p => p !== relativePath && filtered.some(t => t.relativePath === p))
    const newActive = mru ?? (filtered.length > 0 ? filtered[filtered.length - 1].relativePath : null)
    setTaskActiveTab(prev => ({ ...prev, [taskId]: newActive }))
    if (!newActive) setMainView(taskId, 'session')
    else setMainView(taskId, newActive)
  }
  setPendingClose(null)
  persistTabState(taskId)
}

/** Cancel a pending close. */
export function cancelCloseTab() {
  setPendingClose(null)
}

/** Reopen the most recently closed tab. */
export function reopenClosedTab(taskId: string) {
  const stack = recentlyClosed(taskId)
  if (stack.length === 0) return
  const tab = stack[0]
  setTaskRecentlyClosed(prev => ({
    ...prev,
    [taskId]: (prev[taskId] ?? []).slice(1),
  }))
  if (tab.kind === 'diff' && tab.diffPath && tab.diffSource) {
    openDiffTab(taskId, tab.diffPath, tab.diffSource)
  } else {
    openFile(taskId, tab.relativePath, tab.name)
  }
}

export function setTabDirty(taskId: string, relativePath: string, dirty: boolean) {
  setTaskOpenTabs(prev => {
    const tabs = prev[taskId] ?? []
    return {
      ...prev,
      // Editing a file also pins it (preview → permanent)
      [taskId]: tabs.map(t => t.relativePath === relativePath ? { ...t, dirty, preview: dirty ? false : t.preview } : t),
    }
  })
}

export function setActiveTab(taskId: string, relativePath: string) {
  setTaskActiveTab(prev => ({ ...prev, [taskId]: relativePath }))
  setMainView(taskId, relativePath)
  pushMru(taskId, relativePath)
  persistTabState(taskId)
}

// File content cache — avoids reload flicker when switching tabs
// Tracks both current content (with edits) and original content (from disk)
const fileContentCache = new Map<string, string>()
const fileOriginalCache = new Map<string, string>()

export function getCachedContent(taskId: string, relativePath: string): string | undefined {
  return fileContentCache.get(`${taskId}:${relativePath}`)
}

export function getCachedOriginal(taskId: string, relativePath: string): string | undefined {
  return fileOriginalCache.get(`${taskId}:${relativePath}`)
}

export function setCachedContent(taskId: string, relativePath: string, content: string) {
  fileContentCache.set(`${taskId}:${relativePath}`, content)
}

export function setCachedOriginal(taskId: string, relativePath: string, content: string) {
  fileOriginalCache.set(`${taskId}:${relativePath}`, content)
}

export function clearCachedContent(taskId: string, relativePath: string) {
  fileContentCache.delete(`${taskId}:${relativePath}`)
  fileOriginalCache.delete(`${taskId}:${relativePath}`)
}

// Tab-close listeners — lets CodeEditor clear its state cache without circular imports
type TabCloseListener = (taskId: string, relativePath: string) => void
const tabCloseListeners: TabCloseListener[] = []

export function onTabClose(listener: TabCloseListener): () => void {
  tabCloseListeners.push(listener)
  return () => {
    const idx = tabCloseListeners.indexOf(listener)
    if (idx >= 0) tabCloseListeners.splice(idx, 1)
  }
}

// Task-level cleanup listeners — fired when an entire task is deleted/archived
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
  clearPersistedTabs(taskId)
  for (const fn of taskCleanupListeners) fn(taskId)
}

// ── Reveal file in tree ──────────────────────────────────────────────

// Signal consumed by FileTree to scroll to the target. Counter ensures re-fire for same file.
let revealCounter = 0
const [revealRequest, setRevealRequest] = createSignal<{ taskId: string; relativePath: string; seq: number } | null>(null)
export { revealRequest }

/** Expand all ancestor directories and signal the tree to scroll to the file. */
export async function revealFileInTree(taskId: string, relativePath: string) {
  // Diff tabs use synthetic keys with no real path on disk — nothing to reveal.
  if (isDiffKey(relativePath)) return
  // Build list of ancestor paths: "src/components/App.tsx" → ["src", "src/components"]
  const parts = relativePath.split('/')
  const ancestors: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'))
  }

  // Expand + load each ancestor (sequentially so children are available)
  for (const dir of ancestors) {
    if (!getDirContents(taskId, dir)) {
      await loadDirectory(taskId, dir)
    }
    expandDir(taskId, dir)
  }

  // Switch right panel to files tab so the tree is visible
  setRightPanelTab('files')

  // Signal the tree to scroll (unique seq forces re-fire even for same file)
  setRevealRequest({ taskId, relativePath, seq: ++revealCounter })
}

// Quick open overlay
const [showQuickOpen, setShowQuickOpen] = createSignal(false)
export { showQuickOpen, setShowQuickOpen }

/** Switch to most recently used tab (Ctrl+Tab). */
export function nextTab(taskId: string) {
  const tabs = openTabs(taskId)
  if (tabs.length < 2) return
  const mru = taskMruStack()[taskId] ?? []
  const active = activeTabPath(taskId)
  const next = mru.find(p => p !== active && tabs.some(t => t.relativePath === p))
  if (next) {
    setTaskActiveTab(prev => ({ ...prev, [taskId]: next }))
    setMainView(taskId, next)
    pushMru(taskId, next)
    persistTabState(taskId)
    revealFileInTree(taskId, next)
  }
}

/** Switch to least recently used direction (Ctrl+Shift+Tab). */
export function prevTab(taskId: string) {
  const tabs = openTabs(taskId)
  if (tabs.length < 2) return
  const mru = taskMruStack()[taskId] ?? []
  const active = activeTabPath(taskId)
  const candidates = mru.filter(p => p !== active && tabs.some(t => t.relativePath === p))
  const prev = candidates.length > 0 ? candidates[candidates.length - 1] : null
  if (prev) {
    setTaskActiveTab(p => ({ ...p, [taskId]: prev }))
    setMainView(taskId, prev)
    pushMru(taskId, prev)
    persistTabState(taskId)
    revealFileInTree(taskId, prev)
  }
}

/** Close all tabs for a task. */
export function closeAllTabs(taskId: string) {
  const tabs = openTabs(taskId)
  const dirty = tabs.filter(t => t.dirty)
  if (dirty.length > 0) {
    const nonDirty = tabs.filter(t => !t.dirty)
    for (const t of nonDirty) forceCloseTab(taskId, t.relativePath)
    const remaining = openTabs(taskId)
    if (remaining.length > 0) setPendingClose(remaining[0].relativePath)
    return
  }
  for (const t of tabs) forceCloseTab(taskId, t.relativePath)
}

/** Close all tabs except the given one. */
export function closeOtherTabs(taskId: string, keepPath: string) {
  const others = openTabs(taskId).filter(t => t.relativePath !== keepPath)
  for (const t of others) {
    if (t.dirty) continue
    forceCloseTab(taskId, t.relativePath)
  }
  setActiveTab(taskId, keepPath)
}
