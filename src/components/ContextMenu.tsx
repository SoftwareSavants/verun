import { Component, For, Show } from 'solid-js'
import { Popover } from './Popover'
import { clsx } from 'clsx'

export type ContextMenuItem =
  | {
      label: string
      icon?: Component<{ size: number; class?: string }>
      shortcut?: string
      action: () => void
      danger?: boolean
      disabled?: boolean
    }
  | { separator: true }

interface Props {
  open: boolean
  pos?: { x: number; y: number }
  items: ContextMenuItem[]
  onClose: () => void
  minWidth?: string
}

export const ContextMenu: Component<Props> = (props) => (
  <Popover
    open={props.open}
    onClose={props.onClose}
    pos={props.pos}
    class={`py-1 ${props.minWidth ?? 'min-w-32'}`}
  >
    <For each={props.items}>
      {(item) => (
        <Show
          when={!('separator' in item)}
          fallback={<div class="my-1 h-px bg-white/8" />}
        >
          {(() => {
            const action = item as Extract<ContextMenuItem, { label: string }>
            const Icon = action.icon
            return (
              <button
                class={clsx(
                  'w-full flex items-center gap-2 text-left px-2.5 py-1 text-[11px] disabled:opacity-35 disabled:pointer-events-none',
                  action.danger
                    ? 'text-status-error hover:bg-status-error/10'
                    : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                )}
                disabled={action.disabled}
                onClick={() => {
                  action.action()
                  props.onClose()
                }}
              >
                {Icon && <Icon size={12} class="shrink-0" />}
                <span class="flex-1 truncate">{action.label}</span>
                <Show when={action.shortcut}>
                  <span class="ml-4 text-[10px] text-text-dim shrink-0">{action.shortcut}</span>
                </Show>
              </button>
            )
          })()}
        </Show>
      )}
    </For>
  </Popover>
)
