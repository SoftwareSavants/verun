import { createStore, produce } from 'solid-js/store'
import {
  clearSessionContextStorage,
  loadInitialSessionContext,
  persistSessionContext,
} from './sessionContextStorage'

export interface SessionContextState {
  planMode: boolean
  thinkingMode: boolean
  fastMode: boolean
  planFilePath: string | null
}

function createEmptySessionContext(): SessionContextState {
  return {
    planMode: false,
    thinkingMode: true,
    fastMode: false,
    planFilePath: null,
  }
}

export const [sessionContexts, setSessionContexts] = createStore<Record<string, SessionContextState>>({})

function ensureSessionContext(sessionId: string): SessionContextState {
  const existing = sessionContexts[sessionId]
  if (existing) return existing
  const next: SessionContextState = { ...createEmptySessionContext(), ...loadInitialSessionContext(sessionId) }
  setSessionContexts(sessionId, next)
  return next
}

function updateSessionField<K extends keyof SessionContextState>(
  sessionId: string,
  field: K,
  value: SessionContextState[K],
) {
  ensureSessionContext(sessionId)
  setSessionContexts(sessionId, field, value)
  persistSessionContext(sessionId, sessionContexts[sessionId]!)
}

export function planModeForSession(sessionId: string): boolean {
  return ensureSessionContext(sessionId).planMode
}

export function setPlanModeForSession(sessionId: string, value: boolean) {
  updateSessionField(sessionId, 'planMode', value)
}

export function thinkingModeForSession(sessionId: string): boolean {
  return ensureSessionContext(sessionId).thinkingMode
}

export function setThinkingModeForSession(sessionId: string, value: boolean) {
  updateSessionField(sessionId, 'thinkingMode', value)
}

export function fastModeForSession(sessionId: string): boolean {
  return ensureSessionContext(sessionId).fastMode
}

export function setFastModeForSession(sessionId: string, value: boolean) {
  updateSessionField(sessionId, 'fastMode', value)
}

export function planFilePathForSession(sessionId: string): string | null {
  return ensureSessionContext(sessionId).planFilePath
}

export function setPlanFilePathForSession(sessionId: string, value: string | null) {
  updateSessionField(sessionId, 'planFilePath', value)
}

export function clearSessionContext(sessionId: string) {
  setSessionContexts(produce(store => {
    delete store[sessionId]
  }))
  clearSessionContextStorage(sessionId)
}
