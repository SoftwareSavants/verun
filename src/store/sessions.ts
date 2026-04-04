import { createStore } from 'solid-js/store'
import type { Session } from '../types'

export const [sessions, setSessions] = createStore<Record<string, Session>>({})

export const getSessionForAgent = (agentId: string) =>
  sessions[agentId]
