import { produce } from 'solid-js/store'
import { setGitStates, gitStates, refreshTaskGit, type TaskGitState } from './git'
import * as ipc from '../lib/ipc'
import { addToast } from './ui'
import type { FileStatus } from '../types'

function patchFile(taskId: string, path: string, fn: (f: FileStatus) => void) {
  setGitStates(produce((s: Record<string, TaskGitState>) => {
    const st = s[taskId]?.status
    if (!st) return
    const f = st.files.find(f => f.path === path)
    if (f) fn(f)
  }))
}

function removeFile(taskId: string, path: string) {
  setGitStates(produce((s: Record<string, TaskGitState>) => {
    const st = s[taskId]?.status
    if (!st) return
    st.files = st.files.filter(f => f.path !== path)
    st.stats = st.stats.filter(stat => stat.path !== path)
  }))
}

export function optimisticStage(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    if (f.indexStatus === '?' && f.worktreeStatus === '?') {
      f.indexStatus = 'A'
    } else if (f.indexStatus === ' ' || f.indexStatus === '?') {
      f.indexStatus = f.worktreeStatus === '?' ? 'A' : f.worktreeStatus
    }
    f.worktreeStatus = ' '
  })
}

export function optimisticUnstage(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    if (f.indexStatus === 'A' && f.worktreeStatus === ' ') {
      f.indexStatus = '?'
      f.worktreeStatus = '?'
      return
    }
    f.worktreeStatus = f.indexStatus
    f.indexStatus = ' '
  })
}

export function optimisticDiscard(taskId: string, path: string) {
  removeFile(taskId, path)
}

export function optimisticResolve(taskId: string, path: string) {
  patchFile(taskId, path, f => {
    f.conflict = null
    f.indexStatus = 'M'
    f.worktreeStatus = ' '
  })
}

export async function stageOne(taskId: string, path: string): Promise<void> {
  optimisticStage(taskId, path)
  try {
    await ipc.gitStage(taskId, [path])
  } catch (e: unknown) {
    addToast(`Failed to stage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function unstageOne(taskId: string, path: string): Promise<void> {
  optimisticUnstage(taskId, path)
  try {
    await ipc.gitUnstage(taskId, [path])
  } catch (e: unknown) {
    addToast(`Failed to unstage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function discardOne(taskId: string, path: string): Promise<void> {
  optimisticDiscard(taskId, path)
  try {
    await ipc.gitDiscard(taskId, [path])
  } catch (e: unknown) {
    addToast(`Failed to discard: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function resolveConflict(
  taskId: string,
  path: string,
  choice: 'ours' | 'theirs',
): Promise<void> {
  optimisticResolve(taskId, path)
  try {
    await ipc.gitResolveConflict(taskId, path, choice)
  } catch (e: unknown) {
    addToast(`Failed to resolve: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function stageConflictAsIs(taskId: string, path: string): Promise<void> {
  optimisticResolve(taskId, path)
  try {
    await ipc.gitStage(taskId, [path])
  } catch (e: unknown) {
    addToast(`Failed to stage: ${e}`, 'error')
    await refreshTaskGit(taskId, { force: true })
  }
}

export async function stageAll(taskId: string): Promise<void> {
  const status = gitStates[taskId]?.status
  if (status?.files.some(f => !!f.conflict)) {
    addToast('Resolve conflicts before staging all', 'error')
    return
  }
  try {
    await ipc.gitStage(taskId, [])  // empty paths → stage all
  } catch (e: unknown) {
    addToast(`Failed to stage all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function unstageAll(taskId: string): Promise<void> {
  try {
    await ipc.gitUnstageAll(taskId)
  } catch (e: unknown) {
    addToast(`Failed to unstage all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function discardAllUnstaged(taskId: string): Promise<void> {
  try {
    await ipc.gitDiscardAllUnstaged(taskId)
  } catch (e: unknown) {
    addToast(`Failed to discard all: ${e}`, 'error')
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function commitWithFallback(
  taskId: string,
  message: string,
  hasStaged: boolean,
): Promise<void> {
  try {
    if (!hasStaged) {
      const status = gitStates[taskId]?.status
      if (status?.files.some(f => !!f.conflict)) {
        addToast('Resolve conflicts before committing', 'error')
        throw new Error('conflicts')
      }
      await ipc.gitStage(taskId, [])
    }
    await ipc.gitCommit(taskId, message)
  } catch (e: unknown) {
    if ((e as Error)?.message !== 'conflicts') {
      addToast(`Commit failed: ${e}`, 'error')
    }
    throw e
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function commitAndPush(taskId: string, message: string): Promise<void> {
  try {
    await ipc.gitCommitAndPush(taskId, message)
  } catch (e: unknown) {
    addToast(`Commit & push failed: ${e}`, 'error')
    throw e
  }
  await refreshTaskGit(taskId, { local: true, remote: true, force: true })
}

export async function commitAmend(taskId: string, message: string): Promise<void> {
  try {
    await ipc.gitCommitAmend(taskId, message)
  } catch (e: unknown) {
    addToast(`Amend failed: ${e}`, 'error')
    throw e
  }
  await refreshTaskGit(taskId, { force: true })
}

export async function undoLastCommit(taskId: string): Promise<boolean> {
  try {
    await ipc.gitUndoLastCommit(taskId)
  } catch (e: unknown) {
    addToast(`Undo failed: ${e}`, 'error')
    return false
  }
  addToast('Last commit undone', 'success')
  await refreshTaskGit(taskId, { force: true })
  return true
}

export async function revertCommit(taskId: string, hash: string): Promise<void> {
  try {
    await ipc.gitRevertCommit(taskId, hash)
  } catch (e: unknown) {
    addToast(`Revert failed: ${e}. Conflicts may need to be resolved manually.`, 'error')
    await refreshTaskGit(taskId, { force: true })
    return
  }
  addToast(`Reverted ${hash.slice(0, 7)}`, 'success')
  await refreshTaskGit(taskId, { force: true })
}
