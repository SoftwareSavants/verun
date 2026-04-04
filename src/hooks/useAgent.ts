import { listen } from '@tauri-apps/api/event'
import { onCleanup } from 'solid-js'
import { setAgents } from '../store/agents'
import { setSessions } from '../store/sessions'
import * as ipc from '../lib/ipc'
import type { AgentOutputEvent, AgentStatusEvent } from '../types'

export function useAgent() {
  const spawn = async (repoPath: string, branch: string, prompt: string) => {
    const agent = await ipc.spawnAgent(repoPath, branch, prompt)
    setAgents(prev => [...prev, agent])
    return agent
  }

  const kill = async (agentId: string) => {
    await ipc.killAgent(agentId)
    setAgents(
      a => a.id === agentId,
      'status',
      'idle'
    )
  }

  const restart = async (agentId: string) => {
    await ipc.restartAgent(agentId)
    setAgents(
      a => a.id === agentId,
      'status',
      'running'
    )
  }

  // Listen for agent output events
  const unlistenOutput = listen<AgentOutputEvent>('agent-output', (event) => {
    const { agentId, lines } = event.payload
    setSessions(agentId, 'outputLines', prev => [...(prev || []), ...lines])
  })

  // Listen for agent status changes
  const unlistenStatus = listen<AgentStatusEvent>('agent-status', (event) => {
    const { agentId, status } = event.payload
    setAgents(
      a => a.id === agentId,
      'status',
      status
    )
  })

  onCleanup(async () => {
    (await unlistenOutput)()
    ;(await unlistenStatus)()
  })

  return { spawn, kill, restart }
}
