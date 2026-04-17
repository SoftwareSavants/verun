import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import type { ModelOption } from '../types'

interface Props {
  model: ModelOption
  selected?: boolean
  locked: boolean
  onClick: () => void
}

export const ModelRow: Component<Props> = (props) => {
  return (
    <button
      class={clsx(
        'w-full text-left px-3 py-1.5 text-xs transition-colors',
        props.locked
          ? 'opacity-50'
          : props.selected
            ? 'text-accent bg-accent-muted'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
      )}
      onClick={props.onClick}
    >
      <div class="flex items-center gap-1.5">
        <span class="font-medium">{props.model.label}</span>
        <Show when={props.locked}>
          <span class="text-[9px] px-1 py-px rounded bg-warning/15 text-warning leading-tight shrink-0">Update required</span>
        </Show>
      </div>
      <Show when={props.locked && props.model.minVersion}>
        <span class="block text-[10px] text-text-dim mt-0.5">Requires v{props.model.minVersion}+</span>
      </Show>
      <Show when={!props.locked && props.model.description}>
        <span class="block text-[10px] text-text-dim mt-0.5">{props.model.description}</span>
      </Show>
    </button>
  )
}
