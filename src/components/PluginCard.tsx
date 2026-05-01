import { Component, Show, createSignal, For } from 'solid-js'
import { Loader2, Download, Trash2, ChevronDown } from 'lucide-solid'
import type { AvailablePlugin, PluginScope } from '../types'
import { installPlugin, uninstallPlugin, isInstalled, isPending } from '../store/plugins'

interface Props {
  plugin: AvailablePlugin
  cwd: string
  /** When false, only `user` scope is offered (no project context). */
  allowProjectScope: boolean
}

export const PluginCard: Component<Props> = (props) => {
  const [scope, setScope] = createSignal<PluginScope>('user')
  const [scopeOpen, setScopeOpen] = createSignal(false)

  const installed = () => isInstalled(props.plugin.pluginId)
  const pending = () => isPending(props.plugin.pluginId)
  const scopes = (): PluginScope[] =>
    props.allowProjectScope ? ['user', 'project', 'local'] : ['user']

  return (
    <div class="ring-1 ring-white/8 rounded-lg p-4 flex flex-col gap-3 bg-bg">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="font-medium truncate">{props.plugin.name}</h3>
          <p class="text-xs text-fg/50 truncate">{props.plugin.marketplaceName}</p>
        </div>
        <Show when={props.plugin.installCount != null}>
          <span class="text-xs text-fg/60 shrink-0">
            {props.plugin.installCount!.toLocaleString()} installs
          </span>
        </Show>
      </div>
      <p class="text-sm text-fg/80 line-clamp-3">{props.plugin.description}</p>
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
            class="flex-1 px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
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
                <div class="absolute right-0 top-full mt-1 ring-1 ring-white/10 rounded bg-bg z-10 min-w-24">
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
