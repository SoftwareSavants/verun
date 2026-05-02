import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { Search, RefreshCw, Puzzle } from 'lucide-solid'
import { catalog, marketplaces, isSupported, isLoading, isInstalled, loadCatalog } from '../store/plugins'
import { showPlugins, setShowPlugins, selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'
import { Dialog } from './Dialog'
import { PluginCard } from './PluginCard'

type SortKey = 'installs' | 'name'

export const PluginsPage: Component = () => {
  const [query, setQuery] = createSignal('')
  const [installedOnly, setInstalledOnly] = createSignal(false)
  const [marketplaceFilter, setMarketplaceFilter] = createSignal<Set<string>>(new Set())
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
      if (mpFilter.size > 0 && !mpFilter.has(p.marketplaceName)) return false
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

  const toggleMp = (name: string) => {
    setMarketplaceFilter(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <Dialog open={showPlugins()} onClose={() => setShowPlugins(false)} width="min(92vw, 80rem)">
      <div class="flex flex-col" style={{ 'min-height': '60vh', 'max-height': 'calc(100vh - 10rem)' }}>
        {/* Consolidated header: title + search + controls in one row */}
        <div class="flex items-center gap-3 mb-4">
          <div class="flex items-center gap-2 shrink-0">
            <Puzzle size={16} class="text-accent" />
            <h2 class="text-sm font-semibold text-text-primary">Plugins</h2>
          </div>
          <Show when={isSupported() !== false}>
            <div class="relative flex-1 min-w-0">
              <Search class="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-text-dim" />
              <input
                type="text"
                placeholder="Search plugins…"
                class="input-base w-full pl-7 pr-3 py-1 text-[12px]"
                value={query()}
                onInput={e => setQuery(e.currentTarget.value)}
              />
            </div>
            <label class="flex items-center gap-1.5 text-[11px] text-text-secondary shrink-0">
              <input
                type="checkbox"
                checked={installedOnly()}
                onChange={e => setInstalledOnly(e.currentTarget.checked)}
                aria-label="Installed only"
              />
              Installed only
            </label>
            <select
              class="input-base px-2 py-1 text-[11px] shrink-0"
              value={sortKey()}
              onChange={e => setSortKey(e.currentTarget.value as SortKey)}
            >
              <option value="installs">Most installed</option>
              <option value="name">Name</option>
            </select>
          </Show>
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => loadCatalog()}
            title="Refresh"
            disabled={isLoading()}
          >
            <RefreshCw class={`w-3.5 h-3.5 ${isLoading() ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <Show when={isSupported() === false}>
          <div class="p-8 text-center text-sm text-text-dim">
            Update Claude Code to 2.0+ to use the plugin marketplace.
          </div>
        </Show>

        <Show when={isSupported() !== false}>
          <Show when={showMarketplaceBadge()}>
            <div class="flex items-center gap-2 flex-wrap mb-3">
              <span class="text-[10px] uppercase tracking-wider text-text-dim">Marketplaces</span>
              <For each={marketplaces}>
                {mp => {
                  const active = () => marketplaceFilter().has(mp.name)
                  return (
                    <button
                      class={`px-2 py-0.5 rounded-full text-[11px] ring-1 ${active() ? 'ring-accent bg-accent/10 text-accent' : 'ring-white/10 text-text-secondary hover:bg-white/5'}`}
                      onClick={() => toggleMp(mp.name)}
                    >
                      {mp.name}
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>

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
      </div>
    </Dialog>
  )
}
