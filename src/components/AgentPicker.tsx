import { Component, For, Show, createResource } from 'solid-js'
import type { AgentType, AgentInfo } from '../types'
import { listAvailableAgents } from '../lib/ipc'
import { clsx } from 'clsx'
import claudeIcon from '../assets/icons/claude.svg?raw'
import codexIcon from '../assets/icons/codex.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import opencodeIcon from '../assets/icons/opencode.svg?raw'

interface Props {
  value: AgentType
  onChange: (agent: AgentType) => void
}

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
  opencode: opencodeIcon,
}

function SvgIcon(props: { svg: string; size?: number }) {
  const s = props.size ?? 16
  const sized = props.svg.replace('<svg ', `<svg width="${s}" height="${s}" `)
  return <span class="inline-flex items-center justify-center shrink-0" innerHTML={sized} />
}

export const AgentPicker: Component<Props> = (props) => {
  const [agents] = createResource<AgentInfo[]>(listAvailableAgents, { initialValue: [] })

  return (
    <div>
      <label class="text-xs text-text-dim mb-1.5 block">Agent</label>
      <Show when={!agents.loading} fallback={
        <div class="text-xs text-text-dim py-2">Detecting agents…</div>
      }>
        <div class="flex flex-col gap-1">
          <For each={agents()}>
            {(agent) => {
              const selected = () => props.value === agent.id
              const icon = () => AGENT_ICONS[agent.id] || claudeIcon
              return (
                <button
                  class={clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ring-1',
                    agent.installed
                      ? selected()
                        ? 'ring-accent/60 bg-accent-muted text-text-primary'
                        : 'ring-white/8 bg-surface-3 text-text-secondary hover:bg-surface-4 hover:text-text-primary'
                      : 'ring-white/5 bg-surface-1 text-text-dim opacity-60 cursor-default'
                  )}
                  onClick={() => agent.installed && props.onChange(agent.id as AgentType)}
                  disabled={!agent.installed}
                >
                  <span class={clsx(
                    selected() && agent.installed ? 'opacity-100' : 'opacity-50'
                  )}>
                    <SvgIcon svg={icon()} size={16} />
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-medium">{agent.name}</span>
                      <Show when={!agent.installed}>
                        <span class="text-[10px] text-text-dim ring-1 ring-white/8 px-1.5 py-0.5 rounded">
                          not installed
                        </span>
                      </Show>
                    </div>
                    <Show when={!agent.installed}>
                      <code class="text-[10px] text-text-dim font-mono mt-0.5 block truncate">
                        {agent.installHint}
                      </code>
                    </Show>
                  </div>
                  <Show when={selected() && agent.installed}>
                    <div class="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
