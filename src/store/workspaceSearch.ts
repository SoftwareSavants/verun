import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'

export interface SearchMatch {
  path: string
  lineNumber: number
  lineText: string
  matchSpans: Array<[number, number]>
}

export interface DoneEvent {
  taskId: string
  durationMs: number
  totalMatches: number
  totalFiles: number
  truncated: boolean
}

interface ResultEventPayload {
  taskId: string
  matches: SearchMatch[]
}

export interface WorkspaceSearchState {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  includes: string
  excludes: string
  showFilters: boolean
  matches: SearchMatch[]
  busy: boolean
  done: DoneEvent | null
  error: string | null
  collapsed: string[]
  selectedIndex: number
}

const initialState = (): WorkspaceSearchState => ({
  query: '',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  includes: '',
  excludes: '',
  showFilters: false,
  matches: [],
  busy: false,
  done: null,
  error: null,
  collapsed: [],
  selectedIndex: -1,
})

// Soft UI cap; Rust has its own hard cap (MAX_TOTAL_MATCHES in file_search.rs).
export const MAX_DISPLAY_MATCHES = 1000

const [store, setStore] = createStore<Record<string, WorkspaceSearchState>>({})

function ensure(taskId: string) {
  if (!store[taskId]) setStore(taskId, initialState())
}

export function searchState(taskId: string): WorkspaceSearchState {
  ensure(taskId)
  return store[taskId]
}

export const setSearchQuery = (taskId: string, v: string) => { ensure(taskId); setStore(taskId, 'query', v) }
export const setSearchCaseSensitive = (taskId: string, v: boolean) => { ensure(taskId); setStore(taskId, 'caseSensitive', v) }
export const setSearchWholeWord = (taskId: string, v: boolean) => { ensure(taskId); setStore(taskId, 'wholeWord', v) }
export const setSearchUseRegex = (taskId: string, v: boolean) => { ensure(taskId); setStore(taskId, 'useRegex', v) }
export const setSearchIncludes = (taskId: string, v: string) => { ensure(taskId); setStore(taskId, 'includes', v) }
export const setSearchExcludes = (taskId: string, v: string) => { ensure(taskId); setStore(taskId, 'excludes', v) }
export const setSearchShowFilters = (taskId: string, v: boolean) => { ensure(taskId); setStore(taskId, 'showFilters', v) }
export const setSearchBusy = (taskId: string, v: boolean) => { ensure(taskId); setStore(taskId, 'busy', v) }
export const setSearchDone = (taskId: string, v: DoneEvent | null) => { ensure(taskId); setStore(taskId, 'done', v) }
export const setSearchError = (taskId: string, v: string | null) => { ensure(taskId); setStore(taskId, 'error', v) }
export const setSearchSelectedIndex = (taskId: string, v: number) => { ensure(taskId); setStore(taskId, 'selectedIndex', v) }
export const setSearchMatches = (taskId: string, v: SearchMatch[]) => { ensure(taskId); setStore(taskId, 'matches', v) }

export const isCollapsed = (taskId: string, path: string) => !!store[taskId]?.collapsed.includes(path)

export const toggleCollapsed = (taskId: string, path: string) => {
  ensure(taskId)
  setStore(taskId, 'collapsed', (c) => c.includes(path) ? c.filter(p => p !== path) : [...c, path])
}

export const collapseAll = (taskId: string, paths: string[]) => {
  ensure(taskId)
  setStore(taskId, 'collapsed', paths.slice())
}

export const expandAll = (taskId: string) => {
  ensure(taskId)
  setStore(taskId, 'collapsed', [])
}

export const addCollapsed = (taskId: string, path: string) => {
  ensure(taskId)
  setStore(taskId, 'collapsed', (c) => c.includes(path) ? c : [...c, path])
}

export const removeCollapsed = (taskId: string, path: string) => {
  ensure(taskId)
  setStore(taskId, 'collapsed', (c) => c.filter(p => p !== path))
}

export const clearSearchResults = (taskId: string) => {
  ensure(taskId)
  setStore(taskId, produce((s) => {
    s.matches = []
    s.done = null
    s.error = null
    s.selectedIndex = -1
  }))
}

// Seed the query from outside the panel (e.g. Cmd+Shift+F with editor selection).
// Atomically replaces the query and clears stale results so the panel re-runs.
export const seedSearchQuery = (taskId: string, query: string) => {
  ensure(taskId)
  setStore(taskId, produce((s) => {
    s.query = query
    s.matches = []
    s.done = null
    s.error = null
    s.selectedIndex = -1
  }))
}

export function appendSearchMatches(taskId: string, incoming: SearchMatch[]) {
  ensure(taskId)
  const current = store[taskId].matches
  if (current.length >= MAX_DISPLAY_MATCHES) return
  const remaining = MAX_DISPLAY_MATCHES - current.length
  const toAdd = incoming.length <= remaining ? incoming : incoming.slice(0, remaining)
  setStore(taskId, 'matches', (prev) => prev.concat(toAdd))
}

// One-time global listeners: streams workspace-search-result / -done events
// into the per-task store so matches persist across panel mount/unmount.
let listenersInit = false
export function ensureWorkspaceSearchListeners() {
  if (listenersInit) return
  listenersInit = true
  listen<ResultEventPayload>('workspace-search-result', (e) => {
    appendSearchMatches(e.payload.taskId, e.payload.matches)
  }).catch(() => { listenersInit = false })
  listen<DoneEvent>('workspace-search-done', (e) => {
    ensure(e.payload.taskId)
    setStore(e.payload.taskId, produce((s) => {
      s.busy = false
      s.done = e.payload
    }))
  }).catch(() => {})
}
