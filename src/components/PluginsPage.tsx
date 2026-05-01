import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { X, Search, RefreshCw } from 'lucide-solid'
import { catalog, marketplaces, isSupported, isLoading, isInstalled, loadCatalog } from '../store/plugins'
import { setShowPlugins, selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'
import { PluginCard } from './PluginCard'

type SortKey = 'installs' | 'name'

export const PluginsPage: Component = () => {
  const [query, setQuery] = createSignal('')
  const [installedOnly, setInstalledOnly] = createSignal(false)
  const [marketplaceFilter, setMarketplaceFilter] = createSignal<Set<string>>(new Set())
  const [sortKey, setSortKey] = createSignal<SortKey>('installs')

  onMount(() => { void loadCatalog() })

  // When a project is selected we run installs from its worktree, which lets
  // project / local scopes write to the right `.claude/settings.json`. With
  // no project selected we restrict to user scope and run from the home dir
  // so the CLI never falls back to writing into the wrong directory.
  const cwd = createMemo(() => {
    const pid = selectedProjectId()
    if (pid) {
      const proj = projects.find(p => p.id === pid)
      if (proj) return proj.repoPath
    }
    return ''
  })
  const allowProjectScope = createMemo(() => selectedProjectId() != null)

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
    <div class="absolute inset-0 bg-bg z-20 flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b-1 border-b-solid border-b-white/8">
        <h1 class="text-lg font-medium">Plugins</h1>
        <div class="flex items-center gap-2">
          <button
            class="p-1 rounded hover:bg-white/5"
            onClick={() => loadCatalog()}
            title="Refresh"
            disabled={isLoading()}
          >
            <RefreshCw class={`w-4 h-4 ${isLoading() ? 'animate-spin' : ''}`} />
          </button>
          <button class="p-1 rounded hover:bg-white/5" onClick={() => setShowPlugins(false)} aria-label="Close">
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <Show when={isSupported() === false}>
        <div class="p-8 text-center text-sm text-fg/60">
          Update Claude Code to 2.0+ to use the plugin marketplace.
        </div>
      </Show>

      <Show when={isSupported() !== false}>
        <div class="px-4 py-3 flex items-center gap-3 flex-wrap border-b-1 border-b-solid border-b-white/8">
          <div class="relative flex-1 min-w-60">
            <Search class="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-fg/40" />
            <input
              type="text"
              placeholder="Search plugins…"
              class="w-full pl-8 pr-3 py-1.5 rounded ring-1 ring-white/10 bg-bg text-sm focus:ring-accent focus:outline-none"
              value={query()}
              onInput={e => setQuery(e.currentTarget.value)}
            />
          </div>
          <label class="flex items-center gap-1.5 text-sm text-fg/80">
            <input
              type="checkbox"
              checked={installedOnly()}
              onChange={e => setInstalledOnly(e.currentTarget.checked)}
              aria-label="Installed only"
            />
            Installed only
          </label>
          <select
            class="px-2 py-1.5 rounded ring-1 ring-white/10 bg-bg text-sm"
            value={sortKey()}
            onChange={e => setSortKey(e.currentTarget.value as SortKey)}
          >
            <option value="installs">Most installed</option>
            <option value="name">Name</option>
          </select>
        </div>

        <Show when={marketplaces.length > 1}>
          <div class="px-4 py-2 flex items-center gap-2 flex-wrap border-b-1 border-b-solid border-b-white/8">
            <span class="text-xs text-fg/50">Marketplaces:</span>
            <For each={marketplaces}>
              {mp => {
                const active = () => marketplaceFilter().has(mp.name)
                return (
                  <button
                    class={`px-2 py-0.5 rounded-full text-xs ring-1 ${active() ? 'ring-accent bg-accent/10 text-accent' : 'ring-white/10 hover:bg-white/5'}`}
                    onClick={() => toggleMp(mp.name)}
                  >
                    {mp.name}
                  </button>
                )
              }}
            </For>
          </div>
        </Show>

        <div class="flex-1 overflow-auto p-4">
          <Show when={!isLoading() && filtered().length === 0}>
            <p class="text-sm text-fg/60 text-center py-8">No plugins match your filters.</p>
          </Show>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            <For each={filtered()}>
              {p => <PluginCard plugin={p} cwd={cwd()} allowProjectScope={allowProjectScope()} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
