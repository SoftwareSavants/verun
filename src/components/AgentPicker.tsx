import { Component, For, Show, createResource, createSignal, createMemo } from 'solid-js'
import type { AgentType, AgentInfo } from '../types'
import { listAvailableAgents } from '../lib/ipc'
import { tasksForProject } from '../store/tasks'
import { clsx } from 'clsx'
import { ChevronDown, Check, Terminal } from 'lucide-solid'
import { Popover } from './Popover'
import claudeIcon from '../assets/icons/claude.svg?raw'
import codexIcon from '../assets/icons/codex.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import opencodeIcon from '../assets/icons/opencode.svg?raw'

interface Props {
  value: AgentType
  onChange: (agent: AgentType) => void
  projectId?: string | null
  defaultAgent?: AgentType
}

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
  opencode: opencodeIcon,
}

function SvgIcon(props: { svg: string; size?: number }) {
  const s = props.size ?? 14
  const sized = props.svg.replace('<svg ', `<svg width="${s}" height="${s}" `)
  return <span class="inline-flex items-center justify-center shrink-0" innerHTML={sized} />
}

export const AgentPicker: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [agents] = createResource<AgentInfo[]>(listAvailableAgents, { initialValue: [] })

  // Sort: default first, then by most recently used in this project, then rest
  const sortedAgents = createMemo(() => {
    const list = agents() ?? []
    const defaultAgent = props.defaultAgent ?? 'claude'
    const projectTasks = props.projectId ? tasksForProject(props.projectId) : []

    // Build last-used map: agentType -> most recent createdAt
    const lastUsed: Record<string, number> = {}
    for (const task of projectTasks) {
      const at = task.agentType
      if (!lastUsed[at] || task.createdAt > lastUsed[at]) {
        lastUsed[at] = task.createdAt
      }
    }

    return [...list].sort((a, b) => {
      if (a.id === defaultAgent && b.id !== defaultAgent) return -1
      if (b.id === defaultAgent && a.id !== defaultAgent) return 1
      const aLast = lastUsed[a.id] ?? 0
      const bLast = lastUsed[b.id] ?? 0
      return bLast - aLast
    })
  })

  const current = () => agents()?.find(a => a.id === props.value)
  const currentIcon = () => AGENT_ICONS[props.value] || claudeIcon

  return (
    <div class="relative">
      <button
        class={clsx(
          'input-base flex items-center gap-2 cursor-pointer pr-3 text-sm',
          open() && 'border-accent/40'
        )}
        onClick={() => setOpen(o => !o)}
      >
        <Show when={!agents.loading} fallback={
          <span class="text-text-dim text-xs">Detecting…</span>
        }>
          <SvgIcon svg={currentIcon()} size={14} />
          <span class="flex-1 text-left text-text-primary">{current()?.name ?? props.value}</span>
          <Show when={!current()?.installed}>
            <span class="text-[10px] text-text-dim ring-1 ring-white/8 px-1.5 py-0.5 rounded">not installed</span>
          </Show>
        </Show>
        <ChevronDown size={12} class={clsx('text-text-dim ml-auto shrink-0 transition-transform', open() && 'rotate-180')} />
      </button>

      <Popover open={open()} onClose={() => setOpen(false)} class="py-1 w-full absolute top-full left-0 mt-1 min-w-56">
        <For each={sortedAgents()}>
          {(agent) => {
            const isDefault = () => agent.id === props.defaultAgent
            const selected = () => props.value === agent.id
            const icon = () => AGENT_ICONS[agent.id] || claudeIcon
            return (
              <button
                class={clsx(
                  'w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5',
                  agent.installed
                    ? selected()
                      ? 'text-accent bg-accent-muted'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
                    : 'text-text-dim opacity-50 cursor-default'
                )}
                onClick={() => { if (agent.installed) { props.onChange(agent.id as AgentType); setOpen(false) } }}
                disabled={!agent.installed}
              >
                <span class={clsx(!agent.installed && 'opacity-40')}>
                  <SvgIcon svg={icon()} size={13} />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="font-medium">{agent.name}</span>
                    <Show when={isDefault()}>
                      <span class="text-[10px] text-text-dim">default</span>
                    </Show>
                    <Show when={!agent.installed}>
                      <span class="text-[10px] text-text-dim ring-1 ring-white/8 px-1 py-0.5 rounded">not installed</span>
                    </Show>
                  </div>
                  <Show when={!agent.installed}>
                    <div class="flex items-center gap-1 mt-0.5">
                      <Terminal size={9} class="text-text-dim shrink-0" />
                      <code class="text-[10px] text-text-dim font-mono truncate">{agent.installHint}</code>
                    </div>
                  </Show>
                </div>
                <Show when={selected()}>
                  <Check size={12} class="text-accent shrink-0" />
                </Show>
              </button>
            )
          }}
        </For>
      </Popover>
    </div>
  )
}
