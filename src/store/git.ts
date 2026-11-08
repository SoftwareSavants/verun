import { createStore, produce, reconcile } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { GitStatus, BranchCommit, PrInfo, CiCheck, GitHubRepo } from '../types'
import { taskById } from './tasks'
import { selectedTaskId } from './ui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskGitState {
  // Fast local git ops
  status: GitStatus | null
  commits: BranchCommit[]
  branchStatus: { ahead: number; behind: number; unpushed: number }

  // Slow gh CLI calls
  pr: PrInfo | null
  checks: CiCheck[]
  branchUrl: string | null
  github: GitHubRepo | null

  // Metadata
  lastLocalRefresh: number
  lastRemoteRefresh: number
}

export interface RefreshOpts {
  local?: boolean   // default true
  remote?: boolean  // default false
  force?: boolean   // bypass remote TTL
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function emptyState(): TaskGitState {
  return {
    status: null,
    commits: [],
    branchStatus: { ahead: 0, behind: 0, unpushed: 0 },
    pr: null,
    checks: [],
    branchUrl: null,
    github: null,
    lastLocalRefresh: 0,
    lastRemoteRefresh: 0,
  }
}

export const [gitStates, setGitStates] = createStore<Record<string, TaskGitState>>({})

/** Reactive accessor — returns store proxy when key exists, static default otherwise. */
export function taskGit(taskId: string): TaskGitState {
  return gitStates[taskId] ?? emptyState()
}

// ---------------------------------------------------------------------------
// Refresh — deduplication + local/remote split
// ---------------------------------------------------------------------------

const REMOTE_TTL = 30_000

const inflightLocal = new Map<string, Promise<void>>()
const inflightRemote = new Map<string, Promise<void>>()
const localDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const localDebounceResolvers = new Map<string, Array<() => void>>()
const remoteTrackedTasks = new Set<string>()

const LOCAL_DEBOUNCE_MS = 150
// Each local refresh is ~8-10 git subprocesses. Whatever the trigger (watcher
// event, user action, force), run at most one per task per second.
const LOCAL_THROTTLE_MS = 1000
const lastLocalStart = new Map<string, number>()
const localTrailingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const localWaiters = new Map<string, Array<() => void>>()

function runLocal(taskId: string) {
  const waiters = localWaiters.get(taskId) ?? []
  localWaiters.delete(taskId)
  lastLocalStart.set(taskId, Date.now())
  const p = refreshLocal(taskId).finally(() => {
    inflightLocal.delete(taskId)
    waiters.forEach(r => r())
  })
  inflightLocal.set(taskId, p)
}

function scheduleLocal(taskId: string) {
  if (localTrailingTimers.has(taskId) || !localWaiters.get(taskId)?.length) return
  const last = lastLocalStart.get(taskId)
  const wait = last === undefined ? 0 : Math.max(0, last + LOCAL_THROTTLE_MS - Date.now())
  if (wait === 0 && !inflightLocal.has(taskId)) {
    runLocal(taskId)
    return
  }
  localTrailingTimers.set(taskId, setTimeout(() => {
    localTrailingTimers.delete(taskId)
    const inflight = inflightLocal.get(taskId)
    if (inflight) inflight.then(() => scheduleLocal(taskId))
    else scheduleLocal(taskId)
  }, wait))
}

/** Leading + trailing throttle. Resolves once a refresh that started after
 *  this call has finished, so callers still see post-mutation state. */
function throttledLocal(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const waiters = localWaiters.get(taskId) ?? []
    waiters.push(resolve)
    localWaiters.set(taskId, waiters)
    scheduleLocal(taskId)
  })
}

function ensureKey(taskId: string) {
  if (!gitStates[taskId]) {
    setGitStates(produce(s => { s[taskId] = emptyState() }))
  }
}

async function refreshLocal(taskId: string): Promise<void> {
  const [status, commits, branchStatus, github] = await Promise.all([
    ipc.getGitStatus(taskId).catch(() => null),
    ipc.getBranchCommits(taskId).catch(() => [] as BranchCommit[]),
    ipc.getBranchStatus(taskId).catch(() => [0, 0, 0] as [number, number, number]),
    ipc.checkGithub(taskId).catch(() => null),
  ])

  if (!gitStates[taskId]) return

  // Use reconcile so individual file / commit object references are preserved
  // across refreshes when their identifiers (path / hash) match. This stops
  // <For> from remounting every row on each watcher tick.
  if (status === null) {
    setGitStates(taskId, 'status', null)
  } else {
    setGitStates(taskId, 'status', reconcile(status, { key: 'path', merge: true }))
  }
  setGitStates(taskId, 'commits', reconcile(commits, { key: 'hash', merge: true }))
  setGitStates(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.branchStatus = {
      ahead: branchStatus[0],
      behind: branchStatus[1],
      unpushed: branchStatus[2],
    }
    state.github = github
    state.lastLocalRefresh = Date.now()
  }))
}

async function refreshRemote(taskId: string): Promise<void> {
  const snapshot = await ipc.getGithubOverview(taskId, 'network-only')

  setGitStates(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.pr = snapshot.pr
    state.checks = snapshot.checks
    state.branchUrl = snapshot.branchUrl
    // Repo detection is local git state; preserve that as the source of truth.
    if (!state.github) state.github = snapshot.github
    state.lastRemoteRefresh = snapshot.fetchedAt
  }))
}

export async function refreshTaskGit(
  taskId: string,
  opts: RefreshOpts = {},
): Promise<void> {
  if (taskById(taskId)?.isGit === false) return
  const { local = true, remote = false, force = false } = opts

  ensureKey(taskId)

  const promises: Promise<void>[] = []

  if (local) {
    if (force) {
      promises.push(throttledLocal(taskId))
    } else {
      const p = new Promise<void>((resolve) => {
        const existing = localDebounceTimers.get(taskId)
        if (existing) clearTimeout(existing)
        if (!localDebounceResolvers.has(taskId)) localDebounceResolvers.set(taskId, [])
        localDebounceResolvers.get(taskId)!.push(resolve)
        const timer = setTimeout(async () => {
          localDebounceTimers.delete(taskId)
          const resolvers = localDebounceResolvers.get(taskId) ?? []
          localDebounceResolvers.delete(taskId)
          await throttledLocal(taskId)
          resolvers.forEach(r => r())
        }, LOCAL_DEBOUNCE_MS)
        localDebounceTimers.set(taskId, timer)
      })
      promises.push(p)
    }
  }

  if (remote) {
    remoteTrackedTasks.add(taskId)
    const state = gitStates[taskId]
    const stale = !state || force || Date.now() - state.lastRemoteRefresh > REMOTE_TTL

    if (stale) {
      const existing = inflightRemote.get(taskId)
      if (existing) {
        promises.push(existing)
      } else {
        const p = refreshRemote(taskId).finally(() => inflightRemote.delete(taskId))
        inflightRemote.set(taskId, p)
        promises.push(p)
      }
    }
  }

  await Promise.all(promises)
}

/** Reset remote TTL so next refreshTaskGit with remote=true will fetch fresh. */
export function invalidateRemote(taskId: string): void {
  remoteTrackedTasks.add(taskId)
  setGitStates(produce(s => {
    const state = s[taskId]
    if (state) state.lastRemoteRefresh = 0
  }))
}

/** Remove a task's state entirely (on task deletion). */
export function clearTaskGitState(taskId: string): void {
  remoteTrackedTasks.delete(taskId)
  lastLocalStart.delete(taskId)
  const trailing = localTrailingTimers.get(taskId)
  if (trailing) clearTimeout(trailing)
  localTrailingTimers.delete(taskId)
  localWaiters.get(taskId)?.forEach(r => r())
  localWaiters.delete(taskId)
  setGitStates(produce(s => { delete s[taskId] }))
}

// ---------------------------------------------------------------------------
// Listeners — called once from App.tsx
// ---------------------------------------------------------------------------

let listenersInitialized = false

export async function initGitListeners(): Promise<void> {
  if (listenersInitialized) return
  listenersInitialized = true

  await listen<{ taskId: string, remoteLikelyChanged?: boolean }>('git-local-changed', (event) => {
    const { taskId, remoteLikelyChanged } = event.payload
    const shouldRefreshRemote = remoteLikelyChanged
      && (remoteTrackedTasks.has(taskId) || selectedTaskId() === taskId)
    if (shouldRefreshRemote) {
      invalidateRemote(taskId)
      refreshTaskGit(taskId, { local: true, remote: true, force: true })
      return
    }
    refreshTaskGit(taskId, { local: true, remote: false, force: true })
  })

  await listen<{ taskId: string, path: string }>('file-tree-changed', (event) => {
    refreshTaskGit(event.payload.taskId, { local: true, remote: false })
  })

  await listen<{ taskId: string, scopes: string[] }>('github-remote-invalidated', (event) => {
    const { taskId, scopes } = event.payload
    if (scopes.includes('overview')) {
      invalidateRemote(taskId)
      refreshTaskGit(taskId, { local: false, remote: true, force: true })
    }
  })
}

export function initWindowFocusRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    // Only the task on screen, and within the remote TTL a refocus is free.
    // Other tasks catch up when selected (GitActions refreshes on mount).
    const taskId = selectedTaskId()
    if (taskId && remoteTrackedTasks.has(taskId)) {
      refreshTaskGit(taskId, { local: false, remote: true })
    }
  })
}
