import { createSignal } from 'solid-js'
import * as ipc from '../lib/ipc'
import {
  getCachedContent,
  getCachedOriginal,
  setCachedContent,
  setCachedOriginal,
} from './files'
import { allOpenTabs, setTabDirty } from './editorView'
import { addToast, dismissToast } from './ui'

export interface FileConflict {
  taskId: string
  relativePath: string
  diskContent: string
  verunContent: string
}

// Active conflict shown in the modal — populated only at save time, not on focus.
const [activeConflict, setActiveConflict] = createSignal<FileConflict | null>(null)
export { activeConflict }

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

function notifyExternalChange(
  taskId: string,
  relativePath: string,
  tabName: string,
  diskContent: string,
) {
  const id = toastIdFor(taskId, relativePath)
  addToast(`${tabName} changed on disk — your unsaved edits remain`, 'info', {
    id,
    persistent: true,
    actions: [
      {
        label: 'Discard my changes',
        variant: 'danger',
        onClick: () => {
          resolveConflictDiscard({ taskId, relativePath, diskContent, verunContent: getCachedContent(taskId, relativePath) ?? '' })
        },
      },
      {
        label: 'Overwrite disk',
        variant: 'primary',
        onClick: async () => {
          const verunContent = getCachedContent(taskId, relativePath) ?? ''
          await resolveConflictOverwrite({ taskId, relativePath, diskContent, verunContent })
        },
      },
    ],
  })
}

let inFlight = false

/** Re-check every open tab against disk on app focus.
 *  Silently refreshes clean tabs. For dirty tabs, shows a toast (no modal). */
export async function checkOpenFilesForExternalChanges() {
  if (inFlight) return
  inFlight = true
  try {
    const all = allOpenTabs()
    for (const [taskId, tabs] of Object.entries(all)) {
      if (!tabs.length) continue
      const task = await ipc.getTask(taskId).catch(() => null)
      if (!task) continue
      for (const tab of tabs) {
        const cachedOriginal = getCachedOriginal(taskId, tab.relativePath)
        // Never loaded into memory — nothing to compare against
        if (cachedOriginal === undefined) continue

        let diskContent: string
        try {
          diskContent = await ipc.readTextFile(`${task.worktreePath}/${tab.relativePath}`)
        } catch (e) {
          // File may have been deleted externally — out of scope for v1
          console.warn('[fileSync] read failed', tab.relativePath, e)
          continue
        }

        if (diskContent === cachedOriginal) continue

        const key = `${taskId}:${tab.relativePath}`
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
    inFlight = false
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

/** Register the visibilitychange listener. Mirrors git.ts's initWindowFocusRefresh. */
export function initOpenFilesRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkOpenFilesForExternalChanges()
    }
  })
}
