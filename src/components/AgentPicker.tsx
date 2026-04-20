import { Component, For, Show, createSignal, createMemo, createEffect, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { AgentType } from '../types'
import { agents } from '../store/agents'
import { clsx } from 'clsx'
import { ChevronDown, Check } from 'lucide-solid'
import { registerDismissable } from '../lib/dismissable'
import { agentIcon } from '../lib/agents'
import SvgIcon from './SvgIcon'

interface Props {
  value: AgentType
  onChange: (agent: AgentType) => void
  projectId?: string | null
  defaultAgent?: AgentType
}

export const AgentPicker: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [dropdownRect, setDropdownRect] = createSignal<{ left: number; top: number; width: number } | null>(null)
  // Snapshot of the sorted list taken when the dropdown opens — stays frozen until closed
  const [snapshotAgents, setSnapshotAgents] = createSignal<ReturnType<typeof sortAgents>>([])
  let buttonRef: HTMLButtonElement | undefined

  // Sort: default first, rest alphabetical
  const sortAgents = createMemo(() => {
    const list = agents
    const defaultAgent = props.defaultAgent ?? 'claude'
    return [...list].sort((a, b) => {
      if (a.id === defaultAgent && b.id !== defaultAgent) return -1
      if (b.id === defaultAgent && a.id !== defaultAgent) return 1
      return a.name.localeCompare(b.name)
    })
  })

  const openDropdown = () => {
    if (buttonRef) {
      const r = buttonRef.getBoundingClientRect()
      setDropdownRect({ left: r.left, top: r.bottom + 4, width: r.width })
    }
    setSnapshotAgents(sortAgents())
    setOpen(true)
  }

  const closeDropdown = () => setOpen(false)

  createEffect(() => {
    if (!open()) return
    const unregister = registerDismissable(closeDropdown)
    onCleanup(unregister)
  })

  const current = () => agents.find(a => a.id === props.value)
  const currentIcon = () => agentIcon(props.value)

  return (
    <div class="relative">
      <button
        ref={buttonRef}
        class={clsx(
          'input-base flex items-center gap-2 cursor-pointer pr-3 text-sm',
          open() && 'border-accent/40'
        )}
        onClick={() => open() ? closeDropdown() : openDropdown()}
      >
        <SvgIcon svg={currentIcon()} size={14} />
        <span class="flex-1 text-left text-text-primary">{current()?.name ?? props.value}</span>
        <Show when={current() && !current()!.installed}>
          <span class="text-[10px] text-text-dim ring-1 ring-outline/8 px-1.5 py-0.5 rounded">not installed</span>
        </Show>
        <ChevronDown size={12} class={clsx('text-text-dim ml-auto shrink-0 transition-transform', open() && 'rotate-180')} />
      </button>

      <Show when={open()}>
        <Portal>
          {/* backdrop */}
          <div
            class="fixed inset-0 z-[100]"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeDropdown}
            onContextMenu={(e) => { e.preventDefault(); closeDropdown() }}
          />
          <div
            class="fixed z-[101] bg-surface-2 ring-1 ring-outline/8 rounded-md shadow-xl animate-in py-1 min-w-56"
            style={{
              left: `${dropdownRect()?.left ?? 0}px`,
              top: `${dropdownRect()?.top ?? 0}px`,
              width: `${dropdownRect()?.width ?? 0}px`,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={snapshotAgents()}>
              {(agent) => {
                const isDefault = () => agent.id === props.defaultAgent
                const selected = () => props.value === agent.id
                const icon = () => agentIcon(agent.id)
                return (
                  <button
                    class={clsx(
                      'w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5',
                      selected()
                        ? 'text-accent bg-accent-muted'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
                    )}
                    onClick={() => { props.onChange(agent.id as AgentType); closeDropdown() }}
                  >
                    <span class={clsx(!agent.installed && 'opacity-50')}>
                      <SvgIcon svg={icon()} size={13} />
                    </span>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class={clsx('font-medium', !agent.installed && 'opacity-50')}>{agent.name}</span>
                        <Show when={isDefault()}>
                          <span class="text-[10px] text-text-dim">default</span>
                        </Show>
                        <Show when={!agent.installed}>
                          <span class="text-[10px] text-text-dim ring-1 ring-outline/8 px-1 py-0.5 rounded">not installed</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={selected()}>
                      <Check size={12} class="text-accent shrink-0" />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
