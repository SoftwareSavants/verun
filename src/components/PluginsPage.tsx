import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { Search, X, Sparkles } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { AgentType, AvailablePlugin } from '../types'
import { AGENT_DISPLAY_NAMES } from '../types'
import { catalog, marketplaces, isSupported, isLoading, isInstalled, loadCatalog } from '../store/plugins'
import { showPlugins, setShowPlugins, selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'
import { agentIcon } from '../lib/agents'
import { Dialog } from './Dialog'
import { PluginCard } from './PluginCard'
import { PluginDetailDrawer } from './PluginDetailDrawer'
import SvgIcon from './SvgIcon'

type SortKey = 'installs' | 'name'
type MarketplaceFilterValue = 'all' | string

const AGENT_ORDER: AgentType[] = ['claude', 'codex', 'cursor', 'gemini', 'opencode']
const SUPPORTED_AGENTS = new Set<AgentType>(['claude'])

export const PluginsPage: Component = () => {
  const [activeAgent, setActiveAgent] = createSignal<AgentType>('claude')
  const [query, setQuery] = createSignal('')
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

  // The CLI's --available list excludes already-installed plugins, so we
  // synthesize entries for the installed-but-not-available case to make sure
  // installed plugins still render as cards.
  const allPlugins = createMemo<AvailablePlugin[]>(() => {
    const availableIds = new Set(catalog.available.map(p => p.pluginId))
    const synthesized: AvailablePlugin[] = catalog.installed
      .filter(p => !availableIds.has(p.id))
      .map(p => {
        const at = p.id.lastIndexOf('@')
        const name = at >= 0 ? p.id.slice(0, at) : p.id
        const marketplaceName = at >= 0 ? p.id.slice(at + 1) : ''
        return {
          pluginId: p.id,
          name,
          description: '',
          marketplaceName,
          source: '',
          version: p.version,
        }
      })
    return [...catalog.available, ...synthesized]
  })

  const POPULAR_CAP = 8

  const installedItems = createMemo(() =>
    allPlugins().filter(p => isInstalled(p.pluginId))
  )

  const popularItems = createMemo(() =>
    [...allPlugins()]
      .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))
      .slice(0, POPULAR_CAP)
  )

  /** Browse-all is the only section that responds to the filter controls. */
  const browseItems = createMemo(() => {
    const q = query().trim().toLowerCase()
    const mpFilter = marketplaceFilter()
    let list = allPlugins().filter(p => {
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
      <div class="-m-5 flex flex-col" style={{ height: 'min(78vh, 720px)' }}>
        <div class="flex items-center justify-between px-4 py-2 border-b border-border">
          <h2 class="text-sm font-semibold text-text-primary">Plugins</h2>
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => setShowPlugins(false)}
            title="Close"
            aria-label="Close"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        <div class="flex-1 grid grid-cols-[160px_1fr] min-h-0">
          {/* Agent rail — matches the app's main sidebar density */}
          <nav class="flex flex-col gap-0.5 border-r border-border px-2 pt-2 pb-2 overflow-y-auto">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-2.5 mb-1">
              Coding agent
            </div>
            <For each={AGENT_ORDER}>
              {agent => {
                const active = () => activeAgent() === agent
                return (
                  <button
                    class={`relative flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${
                      active()
                        ? 'bg-surface-3 text-text-primary font-semibold'
                        : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                    }`}
                    onClick={() => setActiveAgent(agent)}
                  >
                    <Show when={active()}>
                      <span class="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent" />
                    </Show>
                    <SvgIcon svg={agentIcon(agent)} size={14} />
                    <span class="text-[12px] font-medium flex-1 truncate">{AGENT_DISPLAY_NAMES[agent]}</span>
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
                <div class="flex-1 overflow-y-auto px-4 pt-2 pb-3">
                  <div class="flex flex-col gap-5">
                    {/* Installed */}
                    <Show when={installedItems().length > 0}>
                      <section>
                        <div class="flex items-baseline gap-2 mb-2">
                          <h3 class="m-0 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Installed</h3>
                          <span class="text-[10px] text-text-dim tabular-nums">{installedItems().length}</span>
                        </div>
                        <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                          <For each={installedItems()}>
                            {p => (
                              <PluginCard plugin={p} cwd={cwd()} allowProjectScope={allowProjectScope()} showMarketplace={showMarketplaceBadge()} />
                            )}
                          </For>
                        </div>
                      </section>
                    </Show>

                    {/* Popular */}
                    <section>
                      <div class="flex items-baseline gap-2 mb-2">
                        <h3 class="m-0 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Popular</h3>
                      </div>
                      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                        <For each={popularItems()}>
                          {p => (
                            <PluginCard plugin={p} cwd={cwd()} allowProjectScope={allowProjectScope()} showMarketplace={showMarketplaceBadge()} />
                          )}
                        </For>
                      </div>
                    </section>

                    {/* Browse all — owns the filter controls */}
                    <section>
                      <div class="flex items-center gap-2 mb-2 flex-wrap">
                        <h3 class="m-0 text-[10px] font-semibold uppercase tracking-wider text-text-muted shrink-0">Browse all</h3>
                        <span class="text-[10px] text-text-dim tabular-nums shrink-0">{allPlugins().length}</span>
                        <div class="ml-auto flex items-center gap-2 flex-wrap">
                          <div class="relative w-56">
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
                        </div>
                      </div>
                      <Show when={!isLoading() && browseItems().length === 0}>
                        <p class="text-sm text-text-dim text-center py-8">No plugins match your filters.</p>
                      </Show>
                      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                        <For each={browseItems()}>
                          {p => (
                            <PluginCard plugin={p} cwd={cwd()} allowProjectScope={allowProjectScope()} showMarketplace={showMarketplaceBadge()} />
                          )}
                        </For>
                      </div>
                    </section>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
      <PluginDetailDrawer />
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
          <div class="relative w-16 h-16 rounded-2xl bg-surface-1 ring-1 ring-outline/8 flex items-center justify-center">
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
        <button
          class="inline-flex items-center gap-1.5 text-[11px] text-accent bg-accent-muted px-2.5 py-1 rounded-full ring-1 ring-accent/20 hover:bg-accent/15 transition-colors cursor-pointer"
          onClick={() => openUrl('https://github.com/SoftwareSavants/verun/blob/main/ROADMAP.md')}
        >
          <Sparkles class="w-3 h-3" />
          Track progress in our public roadmap
        </button>
      </div>
    </div>
  )
}
