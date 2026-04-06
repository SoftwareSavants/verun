import { Component, For, Show, createSignal } from 'solid-js'
import { MODEL_OPTIONS } from '../types'
import type { ModelId } from '../types'
import { ChevronDown } from 'lucide-solid'
import { clsx } from 'clsx'

interface Props {
  model: ModelId
  onChange: (model: ModelId) => void
  disabled?: boolean
}

const modelLabel: Record<ModelId, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

export const ModelSelector: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)

  return (
    <div class="relative">
      <button
        class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-30"
        onClick={() => setOpen(o => !o)}
        disabled={props.disabled}
      >
        <span>{modelLabel[props.model]}</span>
        <ChevronDown size={10} />
      </button>

      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute bottom-full left-0 mb-1 z-50 bg-surface-3 border border-border-active rounded-lg shadow-xl py-1 min-w-32 animate-in">
          <For each={MODEL_OPTIONS}>
            {(opt) => (
              <button
                class={clsx(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center justify-between',
                  props.model === opt.id
                    ? 'text-accent bg-accent-muted'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-4'
                )}
                onClick={() => {
                  props.onChange(opt.id)
                  setOpen(false)
                }}
              >
                <span>{opt.label}</span>
                <span class="text-text-dim text-[10px]">{opt.description}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
