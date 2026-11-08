import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { refreshTaskGit } from './git'
import { sessionById } from './sessions'
import type { SessionStatusEvent } from '../types'

// Each watched worktree is a recursive FS watch whose every change runs a git
// refresh for that task. The main window watches only what is on screen (the
// selected task + tasks open in their own window) and unwatches the rest.
const watched = new Set<string>()

export const isWorktreeWatched = (taskId: string) => watched.has(taskId)

/** Reconcile the set of watched worktrees with `taskIds`. */
export function syncWatchedWorktrees(taskIds: Iterable<string>) {
  ensureTurnEndRefresh()
  const next = new Set(taskIds)
  for (const id of watched) {
    if (next.has(id)) continue
    watched.delete(id)
    ipc.unwatchWorktree(id).catch(() => {})
  }
  for (const id of next) {
    if (watched.has(id)) continue
    watched.add(id)
    ipc.watchWorktree(id).catch(() => {})
  }
}

// Unwatched tasks still change while their agent works. Refresh their git
// state when a session turn ends instead of watching every file they touch.
let turnEndListening = false
function ensureTurnEndRefresh() {
  if (turnEndListening) return
  turnEndListening = true
  listen<SessionStatusEvent>('session-status', (event) => {
    if (event.payload.status === 'running') return
    const taskId = sessionById(event.payload.sessionId)?.taskId
    if (!taskId || watched.has(taskId)) return
    refreshTaskGit(taskId)
  }).catch(() => { turnEndListening = false })
}
