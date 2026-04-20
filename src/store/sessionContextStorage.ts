import type { SessionContextState } from './sessionContext'

function storageKey(sessionId: string) {
  return `verun:sessionContext:${sessionId}`
}

export function loadInitialSessionContext(sessionId: string): Partial<SessionContextState> | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    return raw ? JSON.parse(raw) as Partial<SessionContextState> : null
  } catch {
    return null
  }
}

export function persistSessionContext(sessionId: string, ctx: SessionContextState) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(ctx))
  } catch {
    // Ignore storage quota failures.
  }
}

export function clearSessionContextStorage(sessionId: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(storageKey(sessionId))
}
