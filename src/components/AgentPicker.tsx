import { Component, For, Show, createSignal, createMemo, createEffect, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { AgentType } from '../types'
import { agents } from '../store/agents'
import { tasksForProject } from '../store/tasks'
import { clsx } from 'clsx'
import { ChevronDown, Check } from 'lucide-solid'
import { registerDismissable } from '../lib/dismissable'
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
  return (
    <span
      class="inline-flex items-center justify-center shrink-0"
      innerHTML={props.svg.replace('<svg ', `<svg width="${props.size ?? 14}" height="${props.size ?? 14}" `)}
    />
  )
}

export const AgentPicker: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [dropdownRect, setDropdownRect] = createSignal<{ left: number; top: number; width: number } | null>(null)
  let buttonRef: HTMLButtonElement | undefined

  const openDropdown = () => {
    if (buttonRef) {
      const r = buttonRef.getBoundingClientRect()
      setDropdownRect({ left: r.left, top: r.bottom + 4, width: r.width })
    }
    setOpen(true)
  }

  const closeDropdown = () => setOpen(false)

  createEffect(() => {
    if (!open()) return
    const unregister = registerDismissable(closeDropdown)
    onCleanup(unregister)
  })

  // Sort: default first, then by most recently used in this project, then rest
  const sortedAgents = createMemo(() => {
    const list = agents
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

  const current = () => agents.find(a => a.id === props.value)
  const currentIcon = () => AGENT_ICONS[props.value] || claudeIcon

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
          <span class="text-[10px] text-text-dim ring-1 ring-white/8 px-1.5 py-0.5 rounded">not installed</span>
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
            class="fixed z-[101] bg-surface-2 ring-1 ring-white/8 rounded-md shadow-xl animate-in py-1 min-w-56"
            style={{
              left: `${dropdownRect()?.left ?? 0}px`,
              top: `${dropdownRect()?.top ?? 0}px`,
              width: `${dropdownRect()?.width ?? 0}px`,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={sortedAgents()}>
              {(agent) => {
                const isDefault = () => agent.id === props.defaultAgent
                const selected = () => props.value === agent.id
                const icon = () => AGENT_ICONS[agent.id] || claudeIcon
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
                          <span class="text-[10px] text-text-dim ring-1 ring-white/8 px-1 py-0.5 rounded">not installed</span>
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
