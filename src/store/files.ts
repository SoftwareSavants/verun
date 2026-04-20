import { createStore } from 'solid-js/store'
import type { FileEntry } from '../types'
import * as ipc from '../lib/ipc'
import type { DiffSource } from './editorTypes'

export type { DiffSource } from './editorTypes'

// Directory contents cache: keyed by "taskId:relativePath"
const [dirContents, setDirContents] = createStore<Record<string, FileEntry[]>>({})

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

/** Like loadDirectory, but a no-op when the directory is already in the cache.
 * Use from task-switch effects where we only need to populate the tree once —
 * the file watcher keeps it fresh after that via invalidateDirectory.
 */
export async function loadDirectoryIfMissing(taskId: string, relativePath: string) {
  if (dirContents[cacheKey(taskId, relativePath)]) return
  await loadDirectory(taskId, relativePath)
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
