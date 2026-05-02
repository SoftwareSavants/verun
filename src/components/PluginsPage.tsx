import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { Search, RefreshCw, Sparkles } from 'lucide-solid'
import type { AgentType } from '../types'
import { AGENT_DISPLAY_NAMES } from '../types'
import { catalog, marketplaces, isSupported, isLoading, isInstalled, loadCatalog } from '../store/plugins'
import { showPlugins, setShowPlugins, selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'
import { agentIcon } from '../lib/agents'
import { Dialog } from './Dialog'
import { PluginCard } from './PluginCard'
import SvgIcon from './SvgIcon'

type SortKey = 'installs' | 'name'
type MarketplaceFilterValue = 'all' | string

const AGENT_ORDER: AgentType[] = ['claude', 'codex', 'cursor', 'gemini', 'opencode']
const SUPPORTED_AGENTS = new Set<AgentType>(['claude'])

export const PluginsPage: Component = () => {
  const [activeAgent, setActiveAgent] = createSignal<AgentType>('claude')
  const [query, setQuery] = createSignal('')
  const [installedOnly, setInstalledOnly] = createSignal(false)
  const [marketplaceFilter, setMarketplaceFilter] = createSignal<MarketplaceFilterValue>('all')
  const [sortKey, setSortKey] = createSignal<SortKey>('installs')

  onMount(() => { void loadCatalog() })

  const cwd = createMemo(() => {
    const pid = selectedProjectId()
    if (pid) {
      const proj = projects.find(p => p.id === pid)
      if (proj) return proj.repoPath
    }
    return ''
  })
  const allowProjectScope = createMemo(() => selectedProjectId() != null)
  const showMarketplaceBadge = createMemo(() => marketplaces.length > 1)

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    const mpFilter = marketplaceFilter()
    const onlyInstalled = installedOnly()
    let list = catalog.available.filter(p => {
      if (onlyInstalled && !isInstalled(p.pluginId)) return false
      if (mpFilter !== 'all' && p.marketplaceName !== mpFilter) return false
      if (q && !p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false
      return true
    })
    if (sortKey() === 'installs') {
      list = [...list].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    return list
  })

  const selectClass =
    'bg-surface-1 border border-border rounded-md px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent transition-colors shrink-0'

  return (
    <Dialog open={showPlugins()} onClose={() => setShowPlugins(false)} width="min(92vw, 80rem)">
      <div class="flex flex-col" style={{ height: 'min(78vh, 720px)' }}>
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold text-text-primary">Plugins</h2>
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50"
            onClick={() => loadCatalog()}
            title="Refresh"
            disabled={isLoading() || activeAgent() !== 'claude'}
          >
            <RefreshCw class={`w-3.5 h-3.5 ${isLoading() ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div class="flex-1 grid grid-cols-[180px_1fr] gap-4 min-h-0">
          {/* Agent rail */}
          <nav class="flex flex-col gap-0.5">
            <For each={AGENT_ORDER}>
              {agent => {
                const active = () => activeAgent() === agent
                const supported = SUPPORTED_AGENTS.has(agent)
                return (
                  <button
                    class={`group flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors ${
                      active()
                        ? 'bg-accent-muted text-accent ring-1 ring-accent/30'
                        : 'text-text-secondary hover:bg-surface-3'
                    }`}
                    onClick={() => setActiveAgent(agent)}
                  >
                    <SvgIcon svg={agentIcon(agent)} size={16} />
                    <span class="text-[12px] font-medium flex-1 truncate">{AGENT_DISPLAY_NAMES[agent]}</span>
                    <Show when={!supported}>
                      <span class={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded ring-1 ${
                        active() ? 'ring-accent/30' : 'ring-white/10 text-text-dim'
                      }`}>
                        Soon
                      </span>
                    </Show>
                  </button>
                )
              }}
            </For>
          </nav>

          {/* Right panel */}
          <div class="flex flex-col min-h-0 min-w-0">
            <Show
              when={SUPPORTED_AGENTS.has(activeAgent())}
              fallback={<ComingSoon agent={activeAgent()} />}
            >
              <Show when={isSupported() === false}>
                <div class="p-8 text-center text-sm text-text-dim">
                  Update Claude Code to 2.0+ to use the plugin marketplace.
                </div>
              </Show>

              <Show when={isSupported() !== false}>
                <div class="flex items-center gap-2 mb-3">
                  <div class="relative flex-1 min-w-0">
                    <Search class="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-text-dim" />
                    <input
                      type="text"
                      placeholder="Search plugins…"
                      class="w-full bg-surface-1 border border-border rounded-md pl-7 pr-3 py-1 text-[12px] text-text-primary outline-none focus:border-accent transition-colors"
                      value={query()}
                      onInput={e => setQuery(e.currentTarget.value)}
                    />
                  </div>
                  <Show when={showMarketplaceBadge()}>
                    <select
                      class={selectClass}
                      value={marketplaceFilter()}
                      onChange={e => setMarketplaceFilter(e.currentTarget.value)}
                      title="Filter by marketplace"
                    >
                      <option value="all">All marketplaces</option>
                      <For each={marketplaces}>
                        {mp => <option value={mp.name}>{mp.name}</option>}
                      </For>
                    </select>
                  </Show>
                  <select
                    class={selectClass}
                    value={sortKey()}
                    onChange={e => setSortKey(e.currentTarget.value as SortKey)}
                    title="Sort"
                  >
                    <option value="installs">Most installed</option>
                    <option value="name">Alphabetical</option>
                  </select>
                  <label class="flex items-center gap-1.5 text-[11px] text-text-secondary shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={installedOnly()}
                      onChange={e => setInstalledOnly(e.currentTarget.checked)}
                      aria-label="Installed only"
                    />
                    Installed only
                  </label>
                </div>

                <div class="flex-1 overflow-y-auto -mx-1 px-1">
                  <Show when={!isLoading() && filtered().length === 0}>
                    <p class="text-sm text-text-dim text-center py-8">No plugins match your filters.</p>
                  </Show>
                  <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                    <For each={filtered()}>
                      {p => (
                        <PluginCard
                          plugin={p}
                          cwd={cwd()}
                          allowProjectScope={allowProjectScope()}
                          showMarketplace={showMarketplaceBadge()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

const ComingSoon: Component<{ agent: AgentType }> = (props) => {
  const name = () => AGENT_DISPLAY_NAMES[props.agent]
  return (
    <div class="flex-1 flex items-center justify-center">
      <div class="max-w-md text-center">
        <div class="relative inline-flex mb-5">
          <div class="absolute inset-0 blur-2xl bg-accent/15 rounded-full" />
          <div class="relative w-16 h-16 rounded-2xl bg-surface-1 ring-1 ring-white/8 flex items-center justify-center">
            <SvgIcon svg={agentIcon(props.agent)} size={32} />
          </div>
        </div>
        <h3 class="text-base font-semibold text-text-primary mb-1.5">
          {name()} plugins coming soon
        </h3>
        <p class="text-sm text-text-secondary leading-relaxed mb-4">
          Verun's plugin browser currently supports Claude Code only.
          {' '}{name()} support is on the roadmap.
        </p>
        <div class="inline-flex items-center gap-1.5 text-[11px] text-accent bg-accent-muted px-2.5 py-1 rounded-full ring-1 ring-accent/20">
          <Sparkles class="w-3 h-3" />
          Track progress in our public roadmap
        </div>
      </div>
    </div>
  )
}
