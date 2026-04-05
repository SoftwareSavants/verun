import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Session, SessionOutputEvent, SessionStatusEvent } from '../types'
import * as ipc from '../lib/ipc'

const MAX_LINES_IN_MEMORY = 50_000

export const [sessions, setSessions] = createStore<Session[]>([])
export const [outputLines, setOutputLines] = createStore<Record<string, string[]>>({})

export async function loadSessions(taskId: string) {
  const list = await ipc.listSessions(taskId)
  setSessions(list)
}

export async function startSession(taskId: string): Promise<Session> {
  const session = await ipc.startSession(taskId)
  setSessions(produce(s => s.push(session)))
  setOutputLines(session.id, [])
  return session
}

export async function resumeSession(sessionId: string): Promise<Session> {
  const session = await ipc.resumeSession(sessionId)
  setSessions(produce(list => {
    const idx = list.findIndex(s => s.id === sessionId)
    if (idx >= 0) list[idx] = session
    else list.push(session)
  }))
  setOutputLines(session.id, [])
  return session
}

export async function stopSession(sessionId: string) {
  await ipc.stopSession(sessionId)
  setSessions(s => s.id === sessionId, 'status', 'idle')
}

export async function loadOutputLines(sessionId: string) {
  const lines = await ipc.getOutputLines(sessionId)
  setOutputLines(sessionId, lines.map(l => l.line))
}

export function clearOutputLines(sessionId: string) {
  setOutputLines(sessionId, [])
}

export const sessionsForTask = (taskId: string) =>
  sessions.filter(s => s.taskId === taskId)

export const sessionById = (id: string) =>
  sessions.find(s => s.id === id)

// Event listeners — call once at app mount

let listenersInitialized = false

export async function initSessionListeners() {
  if (listenersInitialized) return
  listenersInitialized = true

  await listen<SessionOutputEvent>('session-output', (event) => {
    const { sessionId, lines } = event.payload
    setOutputLines(produce(store => {
      const existing = store[sessionId]
      if (existing) {
        existing.push(...lines)
        // Cap memory usage
        if (existing.length > MAX_LINES_IN_MEMORY) {
          store[sessionId] = existing.slice(-MAX_LINES_IN_MEMORY)
        }
      } else {
        store[sessionId] = [...lines]
      }
    }))
  })

  await listen<SessionStatusEvent>('session-status', (event) => {
    const { sessionId, status } = event.payload
    setSessions(s => s.id === sessionId, 'status', status)
  })
}
