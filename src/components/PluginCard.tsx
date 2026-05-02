import { Component, Show, createSignal, For } from 'solid-js'
import { Loader2, Download, Trash2, ChevronDown } from 'lucide-solid'
import type { AvailablePlugin, PluginScope } from '../types'
import { installPlugin, uninstallPlugin, isInstalled, isPending } from '../store/plugins'

interface Props {
  plugin: AvailablePlugin
  cwd: string
  /** When false, only `user` scope is offered (no project context). */
  allowProjectScope: boolean
  /** When true, render the marketplace name as a small badge near the install
   * count. When false (single marketplace configured), it's hidden — every
   * card would otherwise repeat the same string. */
  showMarketplace: boolean
}

export const PluginCard: Component<Props> = (props) => {
  const [scope, setScope] = createSignal<PluginScope>('user')
  const [scopeOpen, setScopeOpen] = createSignal(false)

  const installed = () => isInstalled(props.plugin.pluginId)
  const pending = () => isPending(props.plugin.pluginId)
  const scopes = (): PluginScope[] =>
    props.allowProjectScope ? ['user', 'project', 'local'] : ['user']

  return (
    <div class="ring-1 ring-white/8 rounded-lg p-4 flex flex-col gap-1 bg-white/2 hover:bg-white/4 transition-colors">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="font-medium truncate min-w-0 flex-1 leading-tight m-0">{props.plugin.name}</h3>
        <div class="flex flex-col items-end gap-1 shrink-0 text-[11px] text-text-dim">
          <Show when={props.plugin.installCount != null}>
            <span>{props.plugin.installCount!.toLocaleString()} installs</span>
          </Show>
          <Show when={props.showMarketplace}>
            <span class="px-1.5 py-0.5 rounded ring-1 ring-white/10 text-[10px]">
              {props.plugin.marketplaceName}
            </span>
          </Show>
        </div>
      </div>
      <p class="text-sm text-text-secondary line-clamp-4">{props.plugin.description}</p>
      <div class="flex items-center gap-2 mt-auto">
        <Show
          when={!installed()}
          fallback={
            <button
              class="flex-1 px-3 py-1.5 rounded ring-1 ring-white/10 hover:bg-white/5 text-sm flex items-center justify-center gap-1.5"
              disabled={pending()}
              onClick={() => uninstallPlugin(props.plugin.pluginId, props.cwd)}
            >
              <Show when={pending()} fallback={<Trash2 class="w-3.5 h-3.5" />}>
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
              </Show>
              Uninstall
            </button>
          }
        >
          <button
            class="flex-1 px-3 py-1.5 rounded bg-accent text-accent-foreground hover:bg-accent-hover text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
            disabled={pending()}
            onClick={() => installPlugin(props.plugin.pluginId, scope(), props.cwd)}
          >
            <Show when={pending()} fallback={<Download class="w-3.5 h-3.5" />}>
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
            </Show>
            Install
          </button>
          <Show when={props.allowProjectScope}>
            <div class="relative">
              <button
                class="px-2 py-1.5 rounded ring-1 ring-white/10 hover:bg-white/5 text-xs flex items-center gap-1"
                onClick={() => setScopeOpen(o => !o)}
                title="Install scope"
              >
                {scope()} <ChevronDown class="w-3 h-3" />
              </button>
              <Show when={scopeOpen()}>
                <div class="absolute right-0 top-full mt-1 ring-1 ring-white/10 rounded bg-surface-2 z-10 min-w-24">
                  <For each={scopes()}>
                    {s => (
                      <button
                        class="block w-full px-3 py-1.5 text-left text-xs hover:bg-white/5"
                        onClick={() => { setScope(s); setScopeOpen(false) }}
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
  )
}
