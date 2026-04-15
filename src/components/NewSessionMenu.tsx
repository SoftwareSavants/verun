import { Component, For, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { AgentType } from '../types'
import { agents } from '../store/agents'
import { clsx } from 'clsx'
import { Plus, ChevronRight, Loader2, Search } from 'lucide-solid'
import { registerDismissable } from '../lib/dismissable'
import { agentIcon } from '../lib/agents'
import SvgIcon from './SvgIcon'

const MODEL_SEARCH_THRESHOLD = 10

interface Props {
  disabled?: boolean
  onCreate: (agentType: AgentType, model?: string) => Promise<void>
}

export const NewSessionMenu: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [menuRect, setMenuRect] = createSignal<{ left: number; top: number } | null>(null)
  const [hoveredAgent, setHoveredAgent] = createSignal<string | null>(null)
  const [submenuRect, setSubmenuRect] = createSignal<{ left: number; top: number } | null>(null)
  let buttonRef: HTMLButtonElement | undefined

  const installedAgents = () => agents.filter(a => a.installed)

  const openMenu = () => {
    if (buttonRef) {
      const r = buttonRef.getBoundingClientRect()
      setMenuRect({ left: r.left, top: r.bottom + 4 })
    }
    setHoveredAgent(null)
    setOpen(true)
  }

  const closeMenu = () => {
    setOpen(false)
    setHoveredAgent(null)
  }

  createEffect(() => {
    if (!open()) return
    const unregister = registerDismissable(closeMenu)
    onCleanup(unregister)
  })

  const handleAgentHover = (agentId: string, rowEl: HTMLButtonElement | null) => {
    if (hoveredAgent() !== agentId) setModelQuery('')
    setHoveredAgent(agentId)
    if (rowEl) {
      const r = rowEl.getBoundingClientRect()
      setSubmenuRect({ left: r.right - 4, top: r.top - 4 })
    }
  }

  const handleSelect = async (agentType: AgentType, model?: string) => {
    closeMenu()
    setCreating(true)
    try {
      await props.onCreate(agentType, model)
    } finally {
      setCreating(false)
    }
  }

  const [modelQuery, setModelQuery] = createSignal('')

  const hoveredAgentInfo = () => {
    const id = hoveredAgent()
    return id ? agents.find(a => a.id === id) : null
  }

  const hoveredModels = () => hoveredAgentInfo()?.models ?? []
  const showModelSearch = () => hoveredModels().length > MODEL_SEARCH_THRESHOLD

  const filteredHoveredModels = createMemo(() => {
    const q = modelQuery().toLowerCase()
    const models = hoveredModels()
    if (!q) return models
    return models.filter(m =>
      m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    )
  })

  return (
    <>
      <button
        ref={buttonRef}
        class="h-8 w-8 shrink-0 flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-white/3 transition-colors disabled:opacity-40"
        onClick={openMenu}
        disabled={props.disabled || creating()}
        title="New Session"
      >
        <Show when={creating()} fallback={<Plus size={13} />}>
          <Loader2 size={13} class="animate-spin" />
        </Show>
      </button>

      <Show when={open()}>
        <Portal>
          {/* backdrop */}
          <div
            class="fixed inset-0 z-[100]"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu() }}
          />

          {/* main menu */}
          <div
            class="fixed z-[101] bg-surface-2 ring-1 ring-white/8 rounded-md shadow-xl py-1 w-44"
            style={{
              left: `${menuRect()?.left ?? 0}px`,
              top: `${menuRect()?.top ?? 0}px`,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Show
              when={installedAgents().length > 0}
              fallback={
                <div class="px-3 py-2 text-xs text-text-dim">No agents installed</div>
              }
            >
              <For each={installedAgents()}>
                {(agent) => {
                  let rowRef: HTMLButtonElement | undefined
                  const hasModels = () => agent.models.length > 0
                  const isHovered = () => hoveredAgent() === agent.id
                  const icon = () => agentIcon(agent.id)

                  return (
                    <button
                      ref={rowRef}
                      class={clsx(
                        'w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors',
                        isHovered()
                          ? 'text-text-primary bg-surface-3'
                          : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
                      )}
                      onMouseEnter={() => handleAgentHover(agent.id, rowRef ?? null)}
                      onClick={() => {
                        if (!hasModels()) {
                          handleSelect(agent.id as AgentType)
                        }
                      }}
                    >
                      <SvgIcon svg={icon()} size={13} />
                      <span class="flex-1 font-medium">{agent.name}</span>
                      <Show when={hasModels()}>
                        <ChevronRight size={11} class="text-text-dim shrink-0" />
                      </Show>
                    </button>
                  )
                }}
              </For>
            </Show>
          </div>

          {/* model submenu */}
          <Show when={hoveredAgentInfo() && hoveredAgentInfo()!.models.length > 0}>
            <div
              class="fixed z-[102] bg-surface-2 ring-1 ring-white/8 rounded-md shadow-xl py-1 w-44 max-h-80 flex flex-col"
              style={{
                left: `${submenuRect()?.left ?? 0}px`,
                top: `${submenuRect()?.top ?? 0}px`,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                // keep hovered state while mouse is in submenu
              }}
            >
              <Show when={showModelSearch()}>
                <div class="px-2 py-1 shrink-0">
                  <div class="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-1 ring-1 ring-white/6">
                    <Search size={10} class="text-text-dim shrink-0" />
                    <input
                      type="text"
                      class="bg-transparent text-[11px] text-text-secondary outline-none w-full placeholder:text-text-dim"
                      placeholder="Search models..."
                      value={modelQuery()}
                      onInput={(e) => setModelQuery(e.currentTarget.value)}
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    />
                  </div>
                </div>
              </Show>
              <div class="overflow-y-auto">
                <For each={filteredHoveredModels()}>
                  {(model) => (
                    <button
                      class="w-full text-left px-3 py-2 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors truncate"
                      onClick={() => handleSelect(hoveredAgentInfo()!.id as AgentType, model.id)}
                    >
                      {model.label}
                    </button>
                  )}
                </For>
                <Show when={modelQuery() && filteredHoveredModels().length === 0}>
                  <div class="px-3 py-2 text-[11px] text-text-dim">No matches</div>
                </Show>
              </div>
            </div>
          </Show>
        </Portal>
      </Show>
    </>
  )
}
