import { createStore } from 'solid-js/store'
import { createSignal, createMemo } from 'solid-js'
import type { Agent } from '../types'

export const [agents, setAgents] = createStore<Agent[]>([])
export const [activeAgentId, setActiveAgentId] = createSignal<string | null>(null)

export const runningAgents = createMemo(() =>
  agents.filter(a => a.status === 'running')
)

export const activeAgent = createMemo(() =>
  agents.find(a => a.id === activeAgentId())
)

export const agentById = (id: string) =>
  agents.find(a => a.id === id)
