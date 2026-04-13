import { Component, For, createSignal } from 'solid-js'
import { MODEL_OPTIONS, AGENT_DISPLAY_NAMES } from '../types'
import type { ModelId, AgentType } from '../types'
import { ChevronDown } from 'lucide-solid'
import { clsx } from 'clsx'
import { Popover } from './Popover'
import claudeIcon from '../assets/icons/claude.svg?raw'
import codexIcon from '../assets/icons/codex.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'

interface Props {
  model: ModelId
  agentType: AgentType
  onChange: (model: ModelId) => void
  disabled?: boolean
}

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
}

function SvgIcon(props: { svg: string; size?: number; class?: string }) {
  const s = props.size ?? 12
  const sized = props.svg.replace('<svg ', `<svg width="${s}" height="${s}" `)
  return <span class={clsx('inline-flex items-center justify-center shrink-0', props.class)} innerHTML={sized} />
}

export const ModelSelector: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const currentOpt = () => MODEL_OPTIONS.find(o => o.id === props.model)!
  const agentSvg = () => AGENT_ICONS[props.agentType] || claudeIcon

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
        <span>{currentOpt().label}</span>
        <ChevronDown size={9} class={clsx('transition-transform', open() && 'rotate-180')} />
      </button>

      <Popover open={open()} onClose={() => setOpen(false)} class="py-1 min-w-40 absolute bottom-full left-0 mb-1">
        <div class="px-3 py-1.5 text-[10px] text-text-dim uppercase tracking-wider flex items-center gap-1.5">
          <SvgIcon svg={agentSvg()} size={10} />
          {AGENT_DISPLAY_NAMES[props.agentType]}
        </div>
        <For each={MODEL_OPTIONS}>
          {(opt) => {
            const selected = () => props.model === opt.id
            return (
              <button
                class={clsx(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between gap-3',
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
                <span class="text-[10px] text-text-dim">{opt.description}</span>
              </button>
            )
          }}
        </For>
      </Popover>
    </div>
  )
}
