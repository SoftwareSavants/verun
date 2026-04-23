import { Component, For, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Search } from 'lucide-solid'
import { clsx } from 'clsx'
import type { AgentType, ModelOption, AgentInfo } from '../types'
import { agents } from '../store/agents'
import { sessions } from '../store/sessions'
import { agentIcon, meetsVersionReq } from '../lib/agents'
import { registerDismissable } from '../lib/dismissable'
import SvgIcon from './SvgIcon'
import { UpdateRequiredDialog } from './UpdateRequiredDialog'

// Cap visible models per provider so keyboard nav can hop between providers
// with a few arrow presses; users expand on demand via the `Show N more` row.
const COLLAPSE_LIMIT = 4

type Row =
  | { kind: 'model'; agent: AgentInfo; model?: ModelOption }
  | { kind: 'more'; agent: AgentInfo; hidden: number }

interface Props {
  open: boolean
  defaultAgent?: AgentType
  defaultModel?: string
  title?: string
  placeholder?: string
  onClose: () => void
  onPick: (agentType: AgentType, model?: string) => void | Promise<void>
}

export const ModelPicker: Component<Props> = (props) => {
  const [query, setQuery] = createSignal('')
  const [activeIdx, setActiveIdx] = createSignal(0)
  const [updateReq, setUpdateReq] = createSignal<{ model: ModelOption; agent: AgentInfo } | null>(null)
  // Snapshot of last-used-at per "{agent}:{model}", frozen when the picker
  // opens so model rows don't shuffle while the user is navigating.
  const [lru, setLru] = createSignal<Map<string, number>>(new Map())
  // Per-agent expansion state. Reset on open.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  const installed = createMemo(() => {
    const list = agents.filter(a => a.installed)
    const def = props.defaultAgent ?? 'claude'
    return [...list].sort((a, b) => {
      if (a.id === def && b.id !== def) return -1
      if (b.id === def && a.id !== def) return 1
      return a.name.localeCompare(b.name)
    })
  })

  // Sort models: pinned default first, then by LRU desc, then by original
  // declaration order as a stable fallback so sorts are deterministic.
  const sortedModelsFor = (agent: AgentInfo): ModelOption[] => {
    const map = lru()
    const def = props.defaultModel
    return agent.models
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const aDef = a.m.id === def
        const bDef = b.m.id === def
        if (aDef !== bDef) return aDef ? -1 : 1
        const la = map.get(`${agent.id}:${a.m.id}`) ?? 0
        const lb = map.get(`${agent.id}:${b.m.id}`) ?? 0
        if (la !== lb) return lb - la
        return a.i - b.i
      })
      .map(x => x.m)
  }

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = []
    const tokens = query().toLowerCase().split(/\s+/).filter(Boolean)
    const match = (agent: AgentInfo, model?: ModelOption) => {
      if (tokens.length === 0) return true
      const hay = `${agent.id} ${agent.name} ${model?.label ?? ''} ${model?.id ?? ''} ${model?.description ?? ''}`.toLowerCase()
      return tokens.every(t => hay.includes(t))
    }
    for (const agent of installed()) {
      if (agent.models.length === 0) {
        if (match(agent, undefined)) out.push({ kind: 'model', agent })
        continue
      }
      // Filter first, slice second: when searching, the top-4 shown are the
      // top-4 *matches* from the full sorted list, not the first 4 in the list
      // that happen to match. Otherwise matches in the hidden tail disappear.
      const matched = sortedModelsFor(agent).filter(m => match(agent, m))
      const isExpanded = expanded().has(agent.id) || matched.length <= COLLAPSE_LIMIT
      const visible = isExpanded ? matched : matched.slice(0, COLLAPSE_LIMIT)
      const hidden = matched.length - visible.length
      for (const m of visible) out.push({ kind: 'model', agent, model: m })
      if (hidden > 0) out.push({ kind: 'more', agent, hidden })
    }
    return out
  })

  // Reset the cursor when the query changes (so a fresh match list doesn't
  // leave the highlight on a now-missing row). Do NOT reset on expansion —
  // when the user hits Enter on "Show N more", the newly-revealed first
  // hidden row takes the same index, so keeping activeIdx put lets them
  // continue navigating without re-finding their place.
  createEffect(() => {
    query()
    setActiveIdx(0)
  })

  createEffect(() => {
    if (!props.open) return
    setQuery('')
    setActiveIdx(0)
    setExpanded(new Set<string>())
    // Snapshot LRU: per (agent, model), keep the max startedAt across all sessions.
    const m = new Map<string, number>()
    for (const s of sessions) {
      if (!s.model) continue
      const k = `${s.agentType}:${s.model}`
      const prev = m.get(k) ?? 0
      if (s.startedAt > prev) m.set(k, s.startedAt)
    }
    setLru(m)
    const unregister = registerDismissable(props.onClose)
    onCleanup(unregister)
  })

  const pick = (row: Extract<Row, { kind: 'model' }>) => {
    if (row.model?.minVersion && !meetsVersionReq(row.agent.cliVersion, row.model.minVersion)) {
      setUpdateReq({ model: row.model, agent: row.agent })
      return
    }
    void props.onPick(row.agent.id, row.model?.id)
    props.onClose()
  }

  const expandGroup = (agentId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.add(agentId)
      return next
    })
  }

  const activateRow = (row: Row) => {
    if (row.kind === 'more') expandGroup(row.agent.id)
    else pick(row)
  }

  let listRef: HTMLDivElement | undefined
  const [keyNavTick, setKeyNavTick] = createSignal(0)

  createEffect(() => {
    keyNavTick()
    const el = listRef?.querySelector<HTMLElement>(`button[data-pick-row][data-idx="${activeIdx()}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  })

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, rows().length - 1))
      setKeyNavTick(t => t + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
      setKeyNavTick(t => t + 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows()[activeIdx()]
      if (row) activateRow(row)
    }
  }

  const grouped = createMemo(() => {
    const list = rows()
    const groups: Array<{ agent: AgentInfo; rows: Array<{ row: Row; idx: number }> }> = []
    const byAgentId = new Map<string, number>()
    list.forEach((row, idx) => {
      const gi = byAgentId.get(row.agent.id)
      if (gi === undefined) {
        byAgentId.set(row.agent.id, groups.length)
        groups.push({ agent: row.agent, rows: [{ row, idx }] })
      } else {
        groups[gi].rows.push({ row, idx })
      }
    })
    return groups
  })

  return (
    <>
      <Show when={props.open}>
        <Portal>
          <div
            data-picker-root
            class="fixed inset-0 z-100 flex items-start justify-center bg-black/60 pt-[15vh] p-6"
            onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
            onKeyDown={onKey}
          >
            <div
              class="bg-surface-2 ring-1 ring-outline/8 rounded-lg shadow-2xl w-full max-w-md max-h-[50vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="px-3 py-2 border-b border-outline/6 flex items-center gap-2 shrink-0">
                <Search size={12} class="text-text-dim shrink-0" />
                <input
                  type="text"
                  class="bg-transparent text-sm text-text-primary outline-none w-full placeholder:text-text-dim"
                  placeholder={props.placeholder ?? 'Search agents and models...'}
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                />
                <Show when={props.title}>
                  <span class="text-[10px] text-text-dim uppercase tracking-wide shrink-0">{props.title}</span>
                </Show>
              </div>
              <div class="overflow-y-auto flex-1" ref={listRef}>
                <For each={grouped()}>
                  {(group, gi) => (
                    <div class={clsx(gi() > 0 && 'border-t border-outline/6')}>
                      <div class="sticky top-0 z-1 bg-surface-2/95 backdrop-blur-sm px-3 py-1.5 flex items-center gap-2">
                        <SvgIcon svg={agentIcon(group.agent.id)} size={12} />
                        <span class="text-[11px] font-semibold text-text-primary">{group.agent.name}</span>
                        <Show when={group.agent.id === props.defaultAgent}>
                          <span class="text-[9px] px-1 py-px rounded bg-accent/12 text-accent leading-tight uppercase tracking-wide">Current</span>
                        </Show>
                        <span class="flex-1" />
                        <span class="text-[9px] text-text-dim">{group.rows.length}</span>
                      </div>
                      <For each={group.rows}>
                        {(entry) => {
                          if (entry.row.kind === 'more') {
                            return (
                              <button
                                data-pick-row
                                data-show-more
                                data-idx={entry.idx}
                                style={{ 'scroll-margin-top': '2rem', 'scroll-margin-bottom': '2rem' }}
                                class={clsx(
                                  'w-full text-left pl-8 pr-3 py-1.5 flex items-center gap-2 transition-colors text-[11px]',
                                  activeIdx() === entry.idx
                                    ? 'bg-surface-3 text-text-primary'
                                    : 'text-text-dim hover:bg-surface-3 hover:text-text-primary',
                                )}
                                onClick={() => expandGroup(entry.row.agent.id)}
                                onMouseEnter={() => setActiveIdx(entry.idx)}
                              >
                                <span class="flex-1 italic">Show {entry.row.kind === 'more' ? entry.row.hidden : 0} more</span>
                              </button>
                            )
                          }
                          const row = entry.row
                          const locked = () => !!row.model?.minVersion
                            && !meetsVersionReq(row.agent.cliVersion, row.model.minVersion)
                          return (
                            <button
                              data-pick-row
                              data-idx={entry.idx}
                              style={{ 'scroll-margin-top': '2rem', 'scroll-margin-bottom': '2rem' }}
                              class={clsx(
                                'w-full text-left pl-8 pr-3 py-1.5 flex items-center gap-2 transition-colors',
                                activeIdx() === entry.idx
                                  ? 'bg-surface-3 text-text-primary'
                                  : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                                locked() && 'opacity-60'
                              )}
                              onClick={() => pick(row)}
                              onMouseEnter={() => setActiveIdx(entry.idx)}
                            >
                              <div class="flex-1 min-w-0 flex items-baseline gap-2">
                                <span class="text-xs font-medium truncate">
                                  {row.model?.label ?? row.agent.name}
                                </span>
                                <Show when={row.model?.description}>
                                  <span class="text-[10px] text-text-dim truncate">{row.model!.description}</span>
                                </Show>
                                <Show when={row.model && row.model.id === props.defaultModel}>
                                  <span class="text-[9px] px-1 py-px rounded bg-accent/12 text-accent leading-tight uppercase tracking-wide shrink-0">Current</span>
                                </Show>
                              </div>
                              <Show when={locked()}>
                                <span class="text-[9px] px-1 py-px rounded bg-warning/15 text-warning leading-tight shrink-0">Update</span>
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  )}
                </For>
                <Show when={rows().length === 0}>
                  <div class="px-3 py-6 text-xs text-text-dim text-center">No matches</div>
                </Show>
              </div>
              <div class="px-3 py-1.5 border-t border-outline/6 flex items-center gap-3 text-[10px] text-text-dim shrink-0">
                <span><kbd class="font-mono">↑↓</kbd> navigate</span>
                <span><kbd class="font-mono">⏎</kbd> select</span>
                <span><kbd class="font-mono">esc</kbd> close</span>
                <span class="flex-1" />
                <Show when={rows().length > 0}>
                  <span>{rows().length} {rows().length === 1 ? 'result' : 'results'}</span>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
      <UpdateRequiredDialog
        open={!!updateReq()}
        modelName={updateReq()?.model.label ?? ''}
        minVersion={updateReq()?.model.minVersion ?? ''}
        updateHint={updateReq()?.agent.updateHint ?? updateReq()?.agent.installHint ?? ''}
        onClose={() => setUpdateReq(null)}
      />
    </>
  )
}
