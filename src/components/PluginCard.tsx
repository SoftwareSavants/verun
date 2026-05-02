import { Component, Show, createSignal, For, createMemo } from 'solid-js'
import { Loader2, Download, Trash2, ChevronDown, Check } from 'lucide-solid'
import type { AvailablePlugin, PluginScope } from '../types'
import { installPlugin, uninstallPlugin, isInstalled, isPending, setSelectedPluginId } from '../store/plugins'
import { detectPluginType, pluginTypeLabel, formatCompactCount } from '../lib/pluginMeta'

interface Props {
  plugin: AvailablePlugin
  cwd: string
  /** When false, only `user` scope is offered (no project context). */
  allowProjectScope: boolean
  /** When true, render the marketplace name in the footer row. When false
   * (single marketplace configured), it's hidden — every card would
   * otherwise repeat the same string. */
  showMarketplace: boolean
}

export const PluginCard: Component<Props> = (props) => {
  const [scope, setScope] = createSignal<PluginScope>('user')
  const [scopeOpen, setScopeOpen] = createSignal(false)

  const installed = () => isInstalled(props.plugin.pluginId)
  const pending = () => isPending(props.plugin.pluginId)
  const type = createMemo(() => detectPluginType(props.plugin.description))
  const scopes = (): PluginScope[] =>
    props.allowProjectScope ? ['user', 'project', 'local'] : ['user']

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedPluginId(props.plugin.pluginId)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedPluginId(props.plugin.pluginId) } }}
      class={`group relative rounded-lg p-3 flex flex-col gap-1.5 transition-colors ring-1 cursor-pointer ${
        installed()
          ? 'ring-accent/25 bg-accent-muted/40 hover:bg-accent-muted/60'
          : 'ring-outline/8 bg-outline/2 hover:bg-outline/4'
      }`}
    >
      {/* Header: title + count */}
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="m-0 truncate text-[13px] font-semibold leading-tight min-w-0 flex-1 text-text-primary">
          {props.plugin.name}
        </h3>
        <Show when={props.plugin.installCount != null}>
          <span class="text-[10px] text-text-dim tabular-nums shrink-0">
            {formatCompactCount(props.plugin.installCount!)}
          </span>
        </Show>
      </div>

      {/* Type chip — only when we can identify it confidently */}
      <Show when={type()}>
        <div>
          <span class="text-[9px] uppercase tracking-wider font-semibold text-text-secondary px-1.5 py-0.5 rounded ring-1 ring-outline/10">
            {pluginTypeLabel(type()!)}
          </span>
        </div>
      </Show>

      {/* Description */}
      <p class="m-0 text-[11px] text-text-dim line-clamp-3 leading-relaxed">
        {props.plugin.description}
      </p>

      {/* Footer: marketplace (left) + status/action (right) */}
      <div class="flex items-center justify-between gap-2 mt-auto pt-1.5 min-h-[28px]">
        <Show when={props.showMarketplace}>
          <span class="text-[10px] text-text-dim truncate">
            {props.plugin.marketplaceName}
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-1.5 shrink-0">
          <Show when={installed()}>
            {/* Resting: subtle 'Installed' indicator. Hover swaps in Uninstall. */}
            <span class="text-[10px] text-accent flex items-center gap-1 group-hover:hidden">
              <Check class="w-3 h-3" /> Installed
            </span>
            <button
              class="hidden group-hover:flex px-2 py-0.5 rounded ring-1 ring-outline/10 hover:bg-outline/5 text-[10px] items-center gap-1 disabled:opacity-50"
              disabled={pending()}
              onClick={(e) => { e.stopPropagation(); uninstallPlugin(props.plugin.pluginId, props.cwd) }}
            >
              <Show when={pending()} fallback={<Trash2 class="w-3 h-3" />}>
                <Loader2 class="w-3 h-3 animate-spin" />
              </Show>
              Uninstall
            </button>
          </Show>
          <Show when={!installed()}>
            <button
              class="px-2 py-0.5 rounded ring-1 ring-accent/30 bg-accent-muted text-accent hover:bg-accent/15 text-[10px] flex items-center gap-1 disabled:opacity-50"
              disabled={pending()}
              onClick={(e) => { e.stopPropagation(); installPlugin(props.plugin.pluginId, scope(), props.cwd) }}
            >
              <Show when={pending()} fallback={<Download class="w-3 h-3" />}>
                <Loader2 class="w-3 h-3 animate-spin" />
              </Show>
              Install
            </button>
            <Show when={props.allowProjectScope}>
              <div class="relative">
                <button
                  class="px-1.5 py-0.5 rounded ring-1 ring-outline/10 hover:bg-outline/5 text-[10px] flex items-center gap-0.5"
                  onClick={(e) => { e.stopPropagation(); setScopeOpen(o => !o) }}
                  title="Install scope"
                >
                  {scope()} <ChevronDown class="w-2.5 h-2.5" />
                </button>
                <Show when={scopeOpen()}>
                  <div class="absolute right-0 bottom-full mb-1 ring-1 ring-outline/10 rounded bg-surface-2 z-10 min-w-20 shadow-lg">
                    <For each={scopes()}>
                      {s => (
                        <button
                          class="block w-full px-2 py-1 text-left text-[10px] hover:bg-outline/5"
                          onClick={(e) => { e.stopPropagation(); setScope(s); setScopeOpen(false) }}
                        >
                          {s}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
