import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import {
  getCachedContent,
  getCachedOriginal,
  setCachedContent,
  setCachedOriginal,
} from './files'
import { allOpenTabs, setTabDirty } from './editorView'
import { addToast, dismissToast } from './ui'
import type { FileTreeChangedEvent } from '../types'

export interface FileConflict {
  taskId: string
  relativePath: string
  diskContent: string
  verunContent: string
}

export interface FileRecreate {
  taskId: string
  relativePath: string
  content: string
}

// Active conflict shown in the modal — populated only at save time, not on focus.
const [activeConflict, setActiveConflict] = createSignal<FileConflict | null>(null)
export { activeConflict }

// Active recreate shown in the modal — populated when cmd+S fires on a deleted-state tab.
const [activeRecreate, setActiveRecreate] = createSignal<FileRecreate | null>(null)
export { activeRecreate }

// Per-file reload nonce — CodeEditor tracks this in its load effect so it
// reruns when disk content has been refreshed underneath it.
const [reloadNonces, setReloadNonces] = createSignal<Record<string, number>>({})

export function reloadNonce(taskId: string, relativePath: string): number {
  return reloadNonces()[`${taskId}:${relativePath}`] ?? 0
}

function bumpReloadNonce(taskId: string, relativePath: string) {
  const key = `${taskId}:${relativePath}`
  setReloadNonces(prev => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }))
}

// Tracks the disk content we last toasted about per file, so re-focusing
// without further external changes doesn't spam the user.
const lastNotifiedDisk = new Map<string, string>()

function toastIdFor(taskId: string, relativePath: string): string {
  return `fileSync:${taskId}:${relativePath}`
}

// Atomic-write trap mitigation: editors (and Claude Code) write atomically by
// renaming a tmp file over the real one, which surfaces as a transient NotFound
// between the two events when the watcher's per-path debounce window doesn't
// cover both. We delay declaring deletion by ~250ms and re-confirm against disk;
// this also gives the upstream debouncer time to coalesce the create.
const DELETE_CONFIRMATION_MS = 250
const pendingDeleteChecks = new Map<string, ReturnType<typeof setTimeout>>()

// Open tabs whose file was deleted externally. Drives the deleted-state tab
// marker and routes cmd+S to the Recreate confirmation modal.
const [deletedFiles, setDeletedFiles] = createSignal<Set<string>>(new Set())

function deletedKey(taskId: string, relativePath: string): string {
  return `${taskId}:${relativePath}`
}

export function isFileDeleted(taskId: string, relativePath: string): boolean {
  return deletedFiles().has(deletedKey(taskId, relativePath))
}

function setFileDeleted(taskId: string, relativePath: string, deleted: boolean) {
  const key = deletedKey(taskId, relativePath)
  setDeletedFiles(prev => {
    if (deleted === prev.has(key)) return prev
    const next = new Set(prev)
    if (deleted) next.add(key)
    else next.delete(key)
    return next
  })
}

function scheduleDeleteConfirmation(
  taskId: string,
  relativePath: string,
  worktreePath: string,
) {
  const key = deletedKey(taskId, relativePath)
  const existing = pendingDeleteChecks.get(key)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    pendingDeleteChecks.delete(key)
    try {
      await ipc.readTextFile(`${worktreePath}/${relativePath}`)
      // File came back — let the standard sweep refresh cache state.
      void checkOpenFilesForExternalChanges(taskId, relativePath)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('NotFound:')) {
        if (!isFileDeleted(taskId, relativePath)) {
          setFileDeleted(taskId, relativePath, true)
          dismissToast(toastIdFor(taskId, relativePath))
          lastNotifiedDisk.delete(key)
        }
      }
    }
  }, DELETE_CONFIRMATION_MS)

  pendingDeleteChecks.set(key, timer)
}

function notifyExternalChange(
  taskId: string,
  relativePath: string,
  tabName: string,
  diskContent: string,
) {
  const id = toastIdFor(taskId, relativePath)
  addToast('Conflicting changes', 'info', {
    id,
    description: `${tabName} was edited both in Verun and on disk. Choose which version to keep.`,
    persistent: true,
    actions: [
      {
        label: 'Cancel',
        variant: 'ghost',
        onClick: () => { dismissToast(id) },
      },
      {
        label: 'Take disk',
        variant: 'danger',
        onClick: () => {
          resolveConflictDiscard({ taskId, relativePath, diskContent, verunContent: getCachedContent(taskId, relativePath) ?? '' })
        },
      },
      {
        label: 'Keep mine',
        variant: 'primary',
        onClick: async () => {
          const verunContent = getCachedContent(taskId, relativePath) ?? ''
          await resolveConflictOverwrite({ taskId, relativePath, diskContent, verunContent })
        },
      },
    ],
  })
}

const inFlight = new Set<string>()
const ALL_TASKS = '*'

/** Re-check open tabs against disk. Silently refreshes clean tabs; for dirty
 *  tabs, shows a toast (no modal). Pass `filterTaskId` to limit the sweep to
 *  one task (used by the file-tree-changed listener); add `filterRelativePath`
 *  to narrow further to a single tab (used by CodeEditor on tab reopen).
 *  Omit both args to sweep every task (used by the visibilitychange catch-up). */
export async function checkOpenFilesForExternalChanges(
  filterTaskId?: string,
  filterRelativePath?: string,
) {
  const key = `${filterTaskId ?? ALL_TASKS}:${filterRelativePath ?? '*'}`
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    const all = allOpenTabs()
    for (const [taskId, tabs] of Object.entries(all)) {
      if (filterTaskId && taskId !== filterTaskId) continue
      if (!tabs.length) continue
      const task = await ipc.getTask(taskId).catch(() => null)
      if (!task) continue
      for (const tab of tabs) {
        if (filterRelativePath && tab.relativePath !== filterRelativePath) continue
        const cachedOriginal = getCachedOriginal(taskId, tab.relativePath)
        // Never loaded into memory — nothing to compare against
        if (cachedOriginal === undefined) continue

        let diskContent: string
        try {
          diskContent = await ipc.readTextFile(`${task.worktreePath}/${tab.relativePath}`)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.startsWith('NotFound:')) {
            // Don't mark deleted immediately — atomic writes (tmp→rename) can
            // briefly show NotFound. Re-confirm after a short debounce.
            if (!isFileDeleted(taskId, tab.relativePath)) {
              scheduleDeleteConfirmation(taskId, tab.relativePath, task.worktreePath)
            }
          } else {
            console.warn('[fileSync] read failed', tab.relativePath, e)
          }
          continue
        }

        // File exists — cancel any pending deletion check and clear prior deleted state
        const key = `${taskId}:${tab.relativePath}`
        const pending = pendingDeleteChecks.get(key)
        if (pending) {
          clearTimeout(pending)
          pendingDeleteChecks.delete(key)
        }
        if (isFileDeleted(taskId, tab.relativePath)) {
          setFileDeleted(taskId, tab.relativePath, false)
        }

        if (diskContent === cachedOriginal) continue

        if (tab.dirty) {
          if (lastNotifiedDisk.get(key) !== diskContent) {
            lastNotifiedDisk.set(key, diskContent)
            notifyExternalChange(taskId, tab.relativePath, tab.name, diskContent)
          }
        } else {
          setCachedContent(taskId, tab.relativePath, diskContent)
          setCachedOriginal(taskId, tab.relativePath, diskContent)
          bumpReloadNonce(taskId, tab.relativePath)
          lastNotifiedDisk.delete(key)
          dismissToast(toastIdFor(taskId, tab.relativePath))
        }
      }
    }
  } finally {
    inFlight.delete(key)
  }
}

/** Save flow guard. Compares disk to the cached original; if they diverge
 *  AND the user's edits also diverge from disk, opens the conflict dialog
 *  and returns false (caller should NOT proceed with the write).
 *  Returns true when the caller is clear to write. */
export async function checkBeforeSave(
  taskId: string,
  relativePath: string,
  worktreePath: string,
  currentContent: string,
): Promise<boolean> {
  const cachedOriginal = getCachedOriginal(taskId, relativePath)
  if (cachedOriginal === undefined) return true

  let diskContent: string
  try {
    diskContent = await ipc.readTextFile(`${worktreePath}/${relativePath}`)
  } catch {
    // Disk read failed — let the save attempt and surface the real error
    return true
  }

  if (diskContent === cachedOriginal) return true
  // User has no local edits — silently reload editor to disk, nothing to write
  if (currentContent === cachedOriginal) {
    setCachedContent(taskId, relativePath, diskContent)
    setCachedOriginal(taskId, relativePath, diskContent)
    bumpReloadNonce(taskId, relativePath)
    return false
  }
  // Disk changed externally but to the same value the user is about to write
  if (diskContent === currentContent) {
    setCachedOriginal(taskId, relativePath, diskContent)
    return true
  }

  setActiveConflict({ taskId, relativePath, diskContent, verunContent: currentContent })
  return false
}

export async function resolveConflictOverwrite(conflict: FileConflict) {
  try {
    await ipc.writeTextFile(conflict.taskId, conflict.relativePath, conflict.verunContent)
    setCachedOriginal(conflict.taskId, conflict.relativePath, conflict.verunContent)
    setCachedContent(conflict.taskId, conflict.relativePath, conflict.verunContent)
    setTabDirty(conflict.taskId, conflict.relativePath, false)
    bumpReloadNonce(conflict.taskId, conflict.relativePath)
    lastNotifiedDisk.delete(`${conflict.taskId}:${conflict.relativePath}`)
    dismissToast(toastIdFor(conflict.taskId, conflict.relativePath))
  } catch (e) {
    console.error('[fileSync] overwrite failed', e)
    addToast(`Failed to save ${conflict.relativePath}`, 'error')
    return
  }
  dismissConflict()
}

export function resolveConflictDiscard(conflict: FileConflict) {
  setCachedContent(conflict.taskId, conflict.relativePath, conflict.diskContent)
  setCachedOriginal(conflict.taskId, conflict.relativePath, conflict.diskContent)
  setTabDirty(conflict.taskId, conflict.relativePath, false)
  bumpReloadNonce(conflict.taskId, conflict.relativePath)
  lastNotifiedDisk.delete(`${conflict.taskId}:${conflict.relativePath}`)
  dismissToast(toastIdFor(conflict.taskId, conflict.relativePath))
  dismissConflict()
}

export function dismissConflict() {
  setActiveConflict(null)
}

export function requestRecreate(taskId: string, relativePath: string, content: string) {
  setActiveRecreate({ taskId, relativePath, content })
}

export function dismissRecreate() {
  setActiveRecreate(null)
}

export async function resolveRecreate(recreate: FileRecreate) {
  try {
    await ipc.writeTextFile(recreate.taskId, recreate.relativePath, recreate.content)
    setCachedOriginal(recreate.taskId, recreate.relativePath, recreate.content)
    setCachedContent(recreate.taskId, recreate.relativePath, recreate.content)
    setTabDirty(recreate.taskId, recreate.relativePath, false)
    setFileDeleted(recreate.taskId, recreate.relativePath, false)
    bumpReloadNonce(recreate.taskId, recreate.relativePath)
  } catch (e) {
    console.error('[fileSync] recreate failed', e)
    addToast(`Failed to recreate ${recreate.relativePath}`, 'error')
    return
  }
  dismissRecreate()
}

let listenersInitialized = false

/** Wire up the realtime + focus-based open-file refresh paths. Idempotent. */
export async function initOpenFilesRefresh(): Promise<void> {
  if (listenersInitialized) return
  listenersInitialized = true

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkOpenFilesForExternalChanges()
    }
  })

  await listen<FileTreeChangedEvent>('file-tree-changed', async (event) => {
    // gitignore-only changes don't affect file content
    if (event.payload.ignoreRulesChanged) return
    await checkOpenFilesForExternalChanges(event.payload.taskId)
  })
}
