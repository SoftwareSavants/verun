import { listen } from '@tauri-apps/api/event'
import { createStore, produce } from 'solid-js/store'
import type { GitHubDebugEvent } from '../types'

const MAX_DEBUG_ENTRIES = 200

export const [githubDebugState, setGitHubDebugState] = createStore<Record<string, GitHubDebugEvent[]>>({})

function appendEntry(taskId: string, entry: GitHubDebugEvent) {
  setGitHubDebugState(produce((state) => {
    if (!state[taskId]) state[taskId] = []
    state[taskId].push(entry)
    if (state[taskId].length > MAX_DEBUG_ENTRIES) {
      state[taskId].splice(0, state[taskId].length - MAX_DEBUG_ENTRIES)
    }
  }))
}

export function pushGitHubDebugEntry(entry: GitHubDebugEvent): void {
  appendEntry(entry.taskId, entry)
}

export function githubDebugEntriesForTask(taskId: string): GitHubDebugEvent[] {
  return githubDebugState[taskId] ?? []
}

export function clearGitHubDebug(taskId: string): void {
  setGitHubDebugState(produce((state) => {
    delete state[taskId]
  }))
}

let listenersInitialized = false

export async function initGitHubDebugListeners(): Promise<void> {
  if (!import.meta.env.DEV || listenersInitialized) return
  listenersInitialized = true

  await listen<GitHubDebugEvent>('github-remote-debug', (event) => {
    pushGitHubDebugEntry(event.payload)
  })

  await listen<{ taskId: string, remoteLikelyChanged?: boolean }>('git-local-changed', (event) => {
    pushGitHubDebugEntry({
      taskId: event.payload.taskId,
      scope: 'overview',
      stage: 'git-local-changed',
      mode: 'event',
      detail: event.payload.remoteLikelyChanged ? 'remoteLikelyChanged=true' : 'remoteLikelyChanged=false',
      emittedAt: Date.now(),
    })
  })

  await listen<{ taskId: string, scopes: string[] }>('github-remote-invalidated', (event) => {
    pushGitHubDebugEntry({
      taskId: event.payload.taskId,
      scope: event.payload.scopes.join(','),
      stage: 'github-remote-invalidated',
      mode: 'event',
      detail: event.payload.scopes.join(','),
      emittedAt: Date.now(),
    })
  })
}
