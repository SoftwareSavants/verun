import { createStore } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { AgentInfo } from '../types'
import { listAvailableAgents } from '../lib/ipc'

export const [agents, setAgents] = createStore<AgentInfo[]>([])

export async function loadAgents() {
  const list = await listAvailableAgents()
  setAgents(list)
}

export async function initAgentListeners() {
  await listen<AgentInfo[]>('agents-updated', (event) => {
    setAgents(event.payload)
  })
}
