import { createStore, produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'
import type { AutoSafePolicy, AutoSafeProjectOverride } from '../types'

interface AutoSafeState {
  hydrated: boolean
  global: AutoSafePolicy
  defaults: AutoSafePolicy
  overrides: Record<string, AutoSafeProjectOverride>
}

const EMPTY_POLICY: AutoSafePolicy = {
  version: 1,
  read: { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch: { mode: 'ask', domains: [] },
  mcp: { mode: 'ask', servers: [] },
  bash: { patterns: [] },
}

const [autoSafe, setAutoSafe] = createStore<AutoSafeState>({
  hydrated: false,
  global: EMPTY_POLICY,
  defaults: EMPTY_POLICY,
  overrides: {},
})

export { autoSafe }

export async function hydrateAutoSafe() {
  const r = await ipc.getAutoSafePolicy()
  setAutoSafe(produce((s) => {
    s.global = r.global
    s.defaults = r.defaults
    s.hydrated = true
  }))
}

export async function updateGlobal(next: AutoSafePolicy) {
  // Snapshot via JSON so Solid's reactive proxy doesn't track our rollback
  // copy (otherwise `previous` would mirror the optimistic update).
  const previous = JSON.parse(JSON.stringify(autoSafe.global)) as AutoSafePolicy
  setAutoSafe('global', next)
  try {
    await ipc.setAutoSafePolicy(next)
  } catch (e) {
    setAutoSafe('global', previous)
    throw e
  }
}

export async function loadProjectOverride(projectId: string) {
  const v = await ipc.getProjectAutoSafeOverride(projectId)
  setAutoSafe('overrides', produce((o) => {
    if (v) o[projectId] = v
    else delete o[projectId]
  }))
}

export async function updateProjectOverride(
  projectId: string,
  next: AutoSafeProjectOverride | null,
) {
  const previous = autoSafe.overrides[projectId]
    ? (JSON.parse(JSON.stringify(autoSafe.overrides[projectId])) as AutoSafeProjectOverride)
    : undefined
  setAutoSafe('overrides', produce((o) => {
    if (next) o[projectId] = next
    else delete o[projectId]
  }))
  try {
    await ipc.setProjectAutoSafeOverride(projectId, next)
  } catch (e) {
    setAutoSafe('overrides', produce((o) => {
      if (previous) o[projectId] = previous
      else delete o[projectId]
    }))
    throw e
  }
}
