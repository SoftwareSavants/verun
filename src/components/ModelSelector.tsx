import { Component, For, Show, createSignal, createEffect, createMemo } from 'solid-js'
import { AGENT_DISPLAY_NAMES } from '../types'
import type { ModelId, AgentType } from '../types'
import { agents } from '../store/agents'
import { ChevronDown, Search } from 'lucide-solid'
import { clsx } from 'clsx'
import { Popover } from './Popover'
import { agentIcon } from '../lib/agents'
import SvgIcon from './SvgIcon'

const MODEL_SEARCH_THRESHOLD = 10

interface Props {
  model: ModelId | null | undefined
  agentType: AgentType
  onChange: (model: ModelId) => void
  disabled?: boolean
}

export const ModelSelector: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')

  const agentInfo = () => agents.find(a => a.id === props.agentType)
  const agentModels = () => agentInfo()?.models ?? []
  const agentSvg = () => agentIcon(props.agentType)
  const showSearch = () => agentModels().length > MODEL_SEARCH_THRESHOLD

  const filteredModels = createMemo(() => {
    const q = query().toLowerCase()
    if (!q) return agentModels()
    return agentModels().filter(m =>
      m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    )
  })

  // Resolved model: stored value if valid for this agent, else first in list
  const resolvedModel = createMemo(() => {
    const models = agentModels()
    if (models.length === 0) return props.model ?? undefined
    const match = models.find(m => m.id === props.model)
    return match ? props.model! : models[0].id
  })

  // Auto-correct stored model when agent changes and stored model isn't in list
  createEffect(() => {
    const resolved = resolvedModel()
    if (resolved && resolved !== props.model) {
      props.onChange(resolved)
    }
  })

  // Clear search when popover closes
  createEffect(() => {
    if (!open()) setQuery('')
  })

  const currentOpt = () => {
    const models = agentModels()
    return models.find(m => m.id === resolvedModel()) ?? models[0]
  }

  return (
    <div class="relative">
      <button
        class={clsx(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-30',
          open() && 'text-text-secondary bg-surface-2',
        )}
        onClick={() => setOpen(o => !o)}
        disabled={props.disabled}
      >
        <SvgIcon svg={agentSvg()} size={12} />
        <span>{currentOpt()?.label ?? resolvedModel()}</span>
        <ChevronDown size={9} class={clsx('transition-transform', open() && 'rotate-180')} />
      </button>

      <Popover open={open()} onClose={() => setOpen(false)} class="py-1 min-w-52 absolute bottom-full left-0 mb-1">
        <div class="px-3 py-1.5 text-[10px] text-text-dim uppercase tracking-wider flex items-center gap-1.5">
          <SvgIcon svg={agentSvg()} size={10} />
          {AGENT_DISPLAY_NAMES[props.agentType]}
        </div>
        <Show when={showSearch()}>
          <div class="px-2 pt-1 pb-1">
            <div class="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-1 ring-1 ring-white/6">
              <Search size={10} class="text-text-dim shrink-0" />
              <input
                type="text"
                class="bg-transparent text-[11px] text-text-secondary outline-none w-full placeholder:text-text-dim"
                placeholder="Search models..."
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                ref={(el) => setTimeout(() => el.focus(), 0)}
              />
            </div>
          </div>
        </Show>
        <div class="max-h-52 overflow-y-auto">
        <For each={filteredModels()}>
          {(opt) => {
            const selected = () => resolvedModel() === opt.id
            return (
              <button
                class={clsx(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors',
                  selected()
                    ? 'text-accent bg-accent-muted'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
                )}
                onClick={() => {
                  props.onChange(opt.id)
                  setOpen(false)
                }}
              >
                <span class="font-medium">{opt.label}</span>
                <Show when={opt.description}>
                  <span class="block text-[10px] text-text-dim mt-0.5">{opt.description}</span>
                </Show>
              </button>
            )
          }}
        </For>
        <Show when={query() && filteredModels().length === 0}>
          <div class="px-3 py-2 text-[11px] text-text-dim">No matches</div>
        </Show>
        </div>
      </Popover>
    </div>
  )
}
