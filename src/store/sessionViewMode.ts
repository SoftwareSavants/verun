import { createSignal } from 'solid-js'

export type SessionViewMode = 'ui' | 'terminal'

const DEFAULT_KEY = 'verun:claudeDefaultViewMode'
const sessionKey = (sessionId: string) => `verun:claudeViewMode:${sessionId}`

const hasLocalStorage = typeof localStorage !== 'undefined'

function loadDefault(): SessionViewMode {
  if (!hasLocalStorage) return 'ui'
  const raw = localStorage.getItem(DEFAULT_KEY)
  return raw === 'terminal' ? 'terminal' : 'ui'
}

function loadOverride(sessionId: string): SessionViewMode | null {
  if (!hasLocalStorage) return null
  const raw = localStorage.getItem(sessionKey(sessionId))
  if (raw === 'ui' || raw === 'terminal') return raw
  return null
}

const [defaultMode, setDefaultModeSignal] = createSignal<SessionViewMode>(loadDefault())

// In-memory cache of per-session overrides. Populated lazily on first read
// from localStorage so that a toggle immediately re-renders dependent views.
const [overrides, setOverrides] = createSignal<Record<string, SessionViewMode | null>>({})

export function claudeDefaultViewMode(): SessionViewMode {
  return defaultMode()
}

export function setClaudeDefaultViewMode(mode: SessionViewMode) {
  setDefaultModeSignal(mode)
  if (hasLocalStorage) localStorage.setItem(DEFAULT_KEY, mode)
}

export function sessionViewMode(sessionId: string | null | undefined): SessionViewMode {
  if (!sessionId) return defaultMode()
  const cached = overrides()[sessionId]
  if (cached !== undefined) {
    return cached ?? defaultMode()
  }
  const loaded = loadOverride(sessionId)
  setOverrides(prev => ({ ...prev, [sessionId]: loaded }))
  return loaded ?? defaultMode()
}

/**
 * Set a per-session override. Pass `null` to clear the override and fall back
 * to the app default.
 */
export function setSessionViewMode(sessionId: string, mode: SessionViewMode | null) {
  setOverrides(prev => ({ ...prev, [sessionId]: mode }))
  if (!hasLocalStorage) return
  if (mode === null) localStorage.removeItem(sessionKey(sessionId))
  else localStorage.setItem(sessionKey(sessionId), mode)
}

/** True when the session has an explicit override set (not just the default). */
export function hasSessionViewModeOverride(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const cached = overrides()[sessionId]
  if (cached !== undefined) return cached !== null
  return loadOverride(sessionId) !== null
}
