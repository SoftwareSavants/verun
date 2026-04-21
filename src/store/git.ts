import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { GitStatus, BranchCommit, PrInfo, CiCheck, GitHubRepo } from '../types'

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
  remote?: boolean  // default true
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

const LOCAL_DEBOUNCE_MS = 150

function ensureKey(taskId: string) {
  if (!gitStates[taskId]) {
    setGitStates(produce(s => { s[taskId] = emptyState() }))
  }
}

async function refreshLocal(taskId: string): Promise<void> {
  const [status, commits, branchStatus] = await Promise.all([
    ipc.getGitStatus(taskId).catch(() => null),
    ipc.getBranchCommits(taskId).catch(() => [] as BranchCommit[]),
    ipc.getBranchStatus(taskId).catch(() => [0, 0, 0] as [number, number, number]),
  ])

  setGitStates(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.status = status
    state.commits = commits
    state.branchStatus = {
      ahead: branchStatus[0],
      behind: branchStatus[1],
      unpushed: branchStatus[2],
    }
    state.lastLocalRefresh = Date.now()
  }))
}

async function refreshRemote(taskId: string): Promise<void> {
  const [prInfo, branchUrl, github] = await Promise.all([
    ipc.getPullRequest(taskId).catch(() => null),
    ipc.getBranchUrl(taskId).catch(() => null),
    ipc.checkGithub(taskId).catch(() => null),
  ])

  const ciChecks = prInfo
    ? await ipc.getCiChecks(taskId).catch(() => [] as CiCheck[])
    : []

  setGitStates(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.pr = prInfo
    state.checks = ciChecks
    state.branchUrl = branchUrl
    state.github = github
    state.lastRemoteRefresh = Date.now()
  }))
}

export async function refreshTaskGit(
  taskId: string,
  opts: RefreshOpts = {},
): Promise<void> {
  const { local = true, remote = true, force = false } = opts

  ensureKey(taskId)

  const promises: Promise<void>[] = []

  if (local) {
    if (force) {
      const existing = inflightLocal.get(taskId)
      if (existing) {
        promises.push(existing)
      } else {
        const p = refreshLocal(taskId).finally(() => inflightLocal.delete(taskId))
        inflightLocal.set(taskId, p)
        promises.push(p)
      }
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
          const inflight = inflightLocal.get(taskId)
          if (inflight) {
            await inflight
          } else {
            const fetch = refreshLocal(taskId).finally(() => inflightLocal.delete(taskId))
            inflightLocal.set(taskId, fetch)
            await fetch
          }
          resolvers.forEach(r => r())
        }, LOCAL_DEBOUNCE_MS)
        localDebounceTimers.set(taskId, timer)
      })
      promises.push(p)
    }
  }

  if (remote) {
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
  setGitStates(produce(s => {
    const state = s[taskId]
    if (state) state.lastRemoteRefresh = 0
  }))
}

/** Remove a task's state entirely (on task deletion). */
export function clearTaskGitState(taskId: string): void {
  setGitStates(produce(s => { delete s[taskId] }))
}

// ---------------------------------------------------------------------------
// Listeners — called once from App.tsx
// ---------------------------------------------------------------------------

let listenersInitialized = false

export async function initGitListeners(): Promise<void> {
  if (listenersInitialized) return
  listenersInitialized = true

  await listen<{ taskId: string }>('git-status-changed', (event) => {
    const { taskId } = event.payload
    invalidateRemote(taskId)
    refreshTaskGit(taskId, { local: true, remote: true, force: true })
  })
}

export function initWindowFocusRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      for (const taskId of Object.keys(gitStates)) {
        refreshTaskGit(taskId, { local: false, remote: true, force: true })
      }
    }
  })
}
