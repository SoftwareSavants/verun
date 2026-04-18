import { Component, For, Show, createSignal, createEffect, createMemo } from 'solid-js'
import { AGENT_DISPLAY_NAMES } from '../types'
import type { ModelId, AgentType, ModelOption } from '../types'
import { agents } from '../store/agents'
import { ChevronDown, Search } from 'lucide-solid'
import { clsx } from 'clsx'
import { Popover } from './Popover'
import { agentIcon, meetsVersionReq } from '../lib/agents'
import SvgIcon from './SvgIcon'
import { ModelRow } from './ModelRow'
import { UpdateRequiredDialog } from './UpdateRequiredDialog'

const MODEL_SEARCH_THRESHOLD = 10

interface Props {
  model: ModelId | null | undefined
  agentType: AgentType
  onChange: (model: ModelId) => void
  disabled?: boolean
  /** Render popover with fixed positioning so it escapes overflow-clipping ancestors */
  fixedPosition?: boolean
  compact?: boolean
}

export const ModelSelector: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [updateModel, setUpdateModel] = createSignal<ModelOption | null>(null)
  const [popoverPos, setPopoverPos] = createSignal<{ x: number; y: number } | undefined>()
  let buttonRef: HTMLButtonElement | undefined

  const agentInfo = () => agents.find(a => a.id === props.agentType)
  const cliVersion = () => agentInfo()?.cliVersion
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

  const resolvedModel = createMemo(() => {
    const models = agentModels()
    if (models.length === 0) return props.model ?? undefined
    const match = models.find(m => m.id === props.model)
    return match ? props.model! : models[0].id
  })

  createEffect(() => {
    const resolved = resolvedModel()
    if (resolved && resolved !== props.model) {
      props.onChange(resolved)
    }
  })

  createEffect(() => {
    if (!open()) setQuery('')
  })

  const currentOpt = () => {
    const models = agentModels()
    return models.find(m => m.id === resolvedModel()) ?? models[0]
  }

  const handleModelSelect = (opt: ModelOption) => {
    if (opt.minVersion && !meetsVersionReq(cliVersion(), opt.minVersion)) {
      setUpdateModel(opt)
      setOpen(false)
      return
    }
    props.onChange(opt.id)
    setOpen(false)
  }

  const handleToggle = () => {
    if (!open() && props.fixedPosition && buttonRef) {
      const r = buttonRef.getBoundingClientRect()
      setPopoverPos({ x: r.left, y: r.top })
    }
    setOpen(o => !o)
  }

  return (
    <div class="relative">
      <button
        ref={buttonRef}
        class={clsx(
          'flex items-center gap-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-30',
          props.compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
          open() && 'text-text-secondary bg-surface-2',
        )}
        onClick={handleToggle}
        disabled={props.disabled}
      >
        <SvgIcon svg={agentSvg()} size={props.compact ? 10 : 12} />
        <span>{currentOpt()?.label ?? resolvedModel()}</span>
        <ChevronDown size={props.compact ? 8 : 9} class={clsx('transition-transform', open() && 'rotate-180')} />
      </button>

      <Popover
        open={open()}
        onClose={() => setOpen(false)}
        pos={props.fixedPosition ? popoverPos() : undefined}
        class={clsx(
          'py-1 min-w-52',
          props.fixedPosition ? '-translate-y-full -mt-1' : 'absolute bottom-full left-0 mb-1',
        )}
      >
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
          {(opt) => (
            <ModelRow
              model={opt}
              selected={resolvedModel() === opt.id}
              locked={!meetsVersionReq(cliVersion(), opt.minVersion)}
              onClick={() => handleModelSelect(opt)}
            />
          )}
        </For>
        <Show when={query() && filteredModels().length === 0}>
          <div class="px-3 py-2 text-[11px] text-text-dim">No matches</div>
        </Show>
        </div>
      </Popover>

      <UpdateRequiredDialog
        open={!!updateModel()}
        modelName={updateModel()?.label ?? ''}
        minVersion={updateModel()?.minVersion ?? ''}
        updateHint={agentInfo()?.updateHint ?? agentInfo()?.installHint ?? ''}
        onClose={() => setUpdateModel(null)}
      />
    </div>
  )
}
