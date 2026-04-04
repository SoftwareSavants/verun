import { Component, For } from 'solid-js'
import { agents, activeAgentId, setActiveAgentId } from '../store/agents'
import { Plus } from 'lucide-solid'
import { clsx } from 'clsx'
import type { AgentStatus } from '../types'

const statusColor: Record<AgentStatus, string> = {
  running: 'bg-status-running',
  idle: 'bg-status-idle',
  paused: 'bg-status-paused',
  done: 'bg-status-done',
  error: 'bg-status-error',
}

interface Props {
  onNewAgent: () => void
}

export const Sidebar: Component<Props> = (props) => {
  return (
    <div class="w-60 h-full bg-surface-1 border-r border-border flex flex-col">
      <div class="p-3 border-b border-border flex items-center justify-between">
        <span class="text-sm font-semibold text-gray-300">Agents</span>
        <button
          class="btn-ghost p-1 rounded"
          onClick={props.onNewAgent}
          title="New Agent"
        >
          <Plus size={16} />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <For each={agents}>
          {(agent) => (
            <button
              class={clsx(
                'w-full text-left px-3 py-2 border-b border-border transition-colors',
                'hover:bg-surface-2',
                activeAgentId() === agent.id && 'bg-surface-2'
              )}
              onClick={() => setActiveAgentId(agent.id)}
            >
              <div class="flex items-center gap-2">
                <div class={clsx('w-2 h-2 rounded-full', statusColor[agent.status])} />
                <span class="text-sm text-gray-200 truncate">{agent.name}</span>
              </div>
              <div class="text-xs text-gray-500 mt-0.5 truncate">{agent.branch}</div>
            </button>
          )}
        </For>
      </div>

      <div class="p-3 border-t border-border">
        <div class="text-xs text-gray-500">
          {agents.filter(a => a.status === 'running').length} running
        </div>
      </div>
    </div>
  )
}
