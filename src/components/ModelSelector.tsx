import { Component, For, Show, createSignal, createEffect, createMemo } from 'solid-js'
import { AGENT_DISPLAY_NAMES } from '../types'
import type { ModelId, AgentType } from '../types'
import { agents } from '../store/agents'
import { ChevronDown } from 'lucide-solid'
import { clsx } from 'clsx'
import { Popover } from './Popover'
import { agentIcon } from '../lib/agents'
import SvgIcon from './SvgIcon'

interface Props {
  model: ModelId | null | undefined
  agentType: AgentType
  onChange: (model: ModelId) => void
  disabled?: boolean
}

export const ModelSelector: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)

  const agentInfo = () => agents.find(a => a.id === props.agentType)
  const agentModels = () => agentInfo()?.models ?? []
  const agentSvg = () => agentIcon(props.agentType)

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
        <div class="max-h-52 overflow-y-auto">
        <For each={agentModels()}>
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
        </div>
      </Popover>
    </div>
  )
}
