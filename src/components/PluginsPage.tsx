import { Component, onMount, Show } from 'solid-js'
import { loadCatalog, isLoading, isSupported } from '../store/plugins'
import { setShowPlugins } from '../store/ui'
import { X } from 'lucide-solid'

export const PluginsPage: Component = () => {
  onMount(() => { void loadCatalog() })
  return (
    <div class="absolute inset-0 bg-bg z-20 flex flex-col">
      <div class="flex items-center justify-between px-4 py-3 border-b-1 border-b-solid border-b-white/8">
        <h1 class="text-lg font-medium">Plugins</h1>
        <button class="p-1 rounded hover:bg-white/5" onClick={() => setShowPlugins(false)} aria-label="Close">
          <X class="w-4 h-4" />
        </button>
      </div>
      <div class="flex-1 overflow-auto p-4">
        <Show when={isSupported() === false}>
          <p class="text-sm text-fg/60">Update Claude Code to 2.0+ to use the plugin marketplace.</p>
        </Show>
        <Show when={isLoading()}>
          <p class="text-sm text-fg/60">Loading…</p>
        </Show>
      </div>
    </div>
  )
}
