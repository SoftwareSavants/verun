import { Component, Show, For, createMemo, createResource, createEffect, createSignal, onCleanup } from 'solid-js'
import { X, ExternalLink, Download, Trash2, Loader2, Check } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { AvailablePlugin, PluginScope } from '../types'
import {
  selectedPluginId, setSelectedPluginId,
  catalog, marketplaces,
  isInstalled, isPending, installedPluginById,
  installPlugin, uninstallPlugin,
} from '../store/plugins'
import { selectedProjectId } from '../store/ui'
import { projects } from '../store/projects'
import * as ipc from '../lib/ipc'
import { detectPluginType, pluginTypeLabel, formatCompactCount } from '../lib/pluginMeta'

/** Best-effort source URL extraction. The CLI returns either a structured
 * object or a bare string; we surface a clickable URL whenever we can.
 * For plugins from Anthropic's official marketplace we link to the
 * Anthropic-hosted plugin page instead of the underlying repo. */
function sourceUrl(plugin: AvailablePlugin): string | null {
  if (plugin.marketplaceName === 'claude-plugins-official') {
    return `https://claude.com/plugins/${encodeURIComponent(plugin.name)}`
  }
  const s = plugin.source as unknown
  if (!s) return null
  if (typeof s === 'string') {
    if (s.startsWith('http')) return s
    const mp = marketplaces.find(m => m.name === plugin.marketplaceName)
    if (mp?.url) return mp.url
    if (mp?.repo) return `https://github.com/${mp.repo}`
    return null
  }
  if (typeof s === 'object') {
    const o = s as Record<string, unknown>
    if (typeof o.url === 'string') return o.url
    if (typeof o.repo === 'string') return `https://github.com/${o.repo}`
  }
  return null
}

export const PluginDetailDrawer: Component = () => {
  const plugin = createMemo<AvailablePlugin | null>(() => {
    const id = selectedPluginId()
    if (!id) return null
    const found = catalog.available.find(p => p.pluginId === id)
    if (found) return found
    // Synthesize from installed if not in available (matches PluginsPage behaviour).
    const inst = catalog.installed.find(p => p.id === id)
    if (!inst) return null
    const at = inst.id.lastIndexOf('@')
    return {
      pluginId: inst.id,
      name: at >= 0 ? inst.id.slice(0, at) : inst.id,
      description: '',
      marketplaceName: at >= 0 ? inst.id.slice(at + 1) : '',
      source: '',
      version: inst.version,
    }
  })

  // Keep the last plugin around for ~200ms after close so the drawer can
  // animate out with its content still visible. Without this, content would
  // disappear instantly and the empty drawer would slide right.
  const [displayPlugin, setDisplayPlugin] = createSignal<AvailablePlugin | null>(null)
  createEffect(() => {
    const p = plugin()
    if (p) {
      setDisplayPlugin(p)
    } else {
      const t = setTimeout(() => setDisplayPlugin(null), 200)
      onCleanup(() => clearTimeout(t))
    }
  })
  const isOpen = () => plugin() != null

  const installedRecord = createMemo(() => {
    const p = plugin()
    return p ? installedPluginById(p.pluginId) : undefined
  })

  // Lazy-load the manifest only for installed plugins (we have the install path).
  const [manifest] = createResource(installedRecord, async (rec) => {
    if (!rec?.installPath) return null
    try { return await ipc.pluginReadManifest(rec.installPath) } catch { return null }
  })

  const cwd = createMemo(() => {
    const pid = selectedProjectId()
    if (pid) {
      const proj = projects.find(p => p.id === pid)
      if (proj) return proj.repoPath
    }
    return ''
  })
  const allowProjectScope = () => selectedProjectId() != null

  const close = () => setSelectedPluginId(null)

  // Close on Escape
  createEffect(() => {
    if (!plugin()) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  const type = createMemo(() => {
    const p = plugin()
    return p ? detectPluginType(p.description) : null
  })

  const installed = () => {
    const p = plugin()
    return p ? isInstalled(p.pluginId) : false
  }
  const pending = () => {
    const p = plugin()
    return p ? isPending(p.pluginId) : false
  }

  const handleInstall = (scope: PluginScope) => {
    const p = plugin()
    if (!p) return
    void installPlugin(p.pluginId, scope, cwd())
  }
  const handleUninstall = () => {
    const p = plugin()
    if (!p) return
    void uninstallPlugin(p.pluginId, cwd())
  }

  return (
    <>
      {/* Backdrop — always mounted, fades via opacity */}
      <div
        class={`fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 ${
          isOpen() ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={close}
      />
      {/* Sheet — always mounted, slides via transform */}
      <aside
        class={`fixed right-0 top-0 bottom-0 z-50 w-[min(92vw,28rem)] bg-surface-2 border-l border-border shadow-2xl flex flex-col transform transition-transform duration-200 ease-out ${
          isOpen() ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
      >
        <Show when={displayPlugin()}>
          {(p) => (
            <>
            {/* Header */}
            <div class="flex items-start gap-3 px-4 py-3 border-b border-border">
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <h2 class="m-0 text-base font-semibold text-text-primary truncate">
                    {p().name}
                  </h2>
                  <Show when={p().version}>
                    <span class="text-[11px] text-text-dim tabular-nums shrink-0">v{p().version}</span>
                  </Show>
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                  <Show when={type()}>
                    <span class="text-[9px] uppercase tracking-wider font-semibold text-text-secondary px-1.5 py-0.5 rounded ring-1 ring-outline/10">
                      {pluginTypeLabel(type()!)}
                    </span>
                  </Show>
                  <Show when={p().installCount != null}>
                    <span class="text-[11px] text-text-dim tabular-nums">{formatCompactCount(p().installCount!)} installs</span>
                  </Show>
                </div>
              </div>
              <button
                class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors shrink-0"
                onClick={close}
                aria-label="Close"
              >
                <X class="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div class="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
              <Show when={p().description}>
                <p class="m-0 text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {p().description}
                </p>
              </Show>

              {/* Metadata */}
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                <dt class="text-text-dim">Marketplace</dt>
                <dd class="m-0 text-text-secondary truncate">{p().marketplaceName || '—'}</dd>

                <Show when={installedRecord()}>
                  {(rec) => (
                    <>
                      <dt class="text-text-dim">Status</dt>
                      <dd class="m-0 text-accent flex items-center gap-1">
                        <Check class="w-3 h-3" /> Installed{rec().enabled ? '' : ' (disabled)'}
                      </dd>
                      <dt class="text-text-dim">Scope</dt>
                      <dd class="m-0 text-text-secondary">{rec().scope}</dd>
                      <Show when={rec().installedAt}>
                        <dt class="text-text-dim">Installed</dt>
                        <dd class="m-0 text-text-secondary">{new Date(rec().installedAt!).toLocaleString()}</dd>
                      </Show>
                      <Show when={rec().installPath}>
                        <dt class="text-text-dim">Path</dt>
                        <dd class="m-0 text-text-dim truncate" title={rec().installPath}>
                          <code class="text-[11px]">{rec().installPath}</code>
                        </dd>
                      </Show>
                    </>
                  )}
                </Show>
              </dl>

              {/* Components — installed only */}
              <Show when={manifest()}>
                {(m) => (
                  <Show when={
                    m().skills.length > 0 || m().commands.length > 0 || m().agents.length > 0 ||
                    m().hasHooks || m().hasMcpConfig || m().hasLspConfig
                  }>
                    <div>
                      <h3 class="m-0 text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">
                        What this plugin ships
                      </h3>
                      <div class="flex flex-col gap-2">
                        <Show when={m().skills.length > 0}>
                          <ComponentGroup label={`Skills (${m().skills.length})`} items={m().skills} />
                        </Show>
                        <Show when={m().commands.length > 0}>
                          <ComponentGroup label={`Commands (${m().commands.length})`} items={m().commands.map(c => `/${c}`)} />
                        </Show>
                        <Show when={m().agents.length > 0}>
                          <ComponentGroup label={`Agents (${m().agents.length})`} items={m().agents} />
                        </Show>
                        <Show when={m().hasHooks}>
                          <ComponentBadge label="Hooks" />
                        </Show>
                        <Show when={m().hasMcpConfig}>
                          <ComponentBadge label="MCP server" />
                        </Show>
                        <Show when={m().hasLspConfig}>
                          <ComponentBadge label="LSP server" />
                        </Show>
                      </div>
                    </div>
                  </Show>
                )}
              </Show>

              <Show when={!installed()}>
                <p class="m-0 text-[11px] text-text-dim italic">
                  Install to see the full list of skills, commands, agents and integrations this plugin ships.
                </p>
              </Show>
            </div>

            {/* Footer actions */}
            <div class="px-4 py-3 border-t border-border flex items-center gap-2">
              <Show when={sourceUrl(p())}>
                {(url) => (
                  <button
                    class="flex items-center gap-1.5 px-2.5 py-1.5 rounded ring-1 ring-outline/10 hover:bg-outline/5 text-[12px] text-text-secondary"
                    onClick={() => openUrl(url())}
                  >
                    <ExternalLink class="w-3.5 h-3.5" />
                    View source
                  </button>
                )}
              </Show>
              <div class="ml-auto flex items-center gap-2">
                <Show when={installed()}>
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded ring-1 ring-outline/10 hover:bg-outline/5 text-[12px] disabled:opacity-50"
                    disabled={pending()}
                    onClick={handleUninstall}
                  >
                    <Show when={pending()} fallback={<Trash2 class="w-3.5 h-3.5" />}>
                      <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    </Show>
                    Uninstall
                  </button>
                </Show>
                <Show when={!installed()}>
                  <ScopedInstallButton
                    pending={pending()}
                    allowProjectScope={allowProjectScope()}
                    onInstall={handleInstall}
                  />
                </Show>
              </div>
            </div>
            </>
          )}
        </Show>
      </aside>
    </>
  )
}

const ComponentGroup: Component<{ label: string; items: string[] }> = (props) => (
  <div>
    <div class="text-[11px] text-text-dim mb-1">{props.label}</div>
    <div class="flex flex-wrap gap-1">
      <For each={props.items}>
        {item => (
          <code class="text-[11px] px-1.5 py-0.5 rounded ring-1 ring-outline/10 text-text-secondary bg-surface-1">
            {item}
          </code>
        )}
      </For>
    </div>
  </div>
)

const ComponentBadge: Component<{ label: string }> = (props) => (
  <div class="text-[11px] text-text-secondary flex items-center gap-1.5">
    <span class="w-1 h-1 rounded-full bg-accent" />
    {props.label}
  </div>
)

const ScopedInstallButton: Component<{
  pending: boolean
  allowProjectScope: boolean
  onInstall: (scope: PluginScope) => void
}> = (props) => {
  return (
    <div class="flex items-center gap-1.5">
      <Show when={props.allowProjectScope}>
        <ScopeMenu onPick={s => props.onInstall(s)} pending={props.pending} />
      </Show>
      <Show when={!props.allowProjectScope}>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded ring-1 ring-accent/30 bg-accent-muted text-accent hover:bg-accent/15 text-[12px] disabled:opacity-50"
          disabled={props.pending}
          onClick={() => props.onInstall('user')}
        >
          <Show when={props.pending} fallback={<Download class="w-3.5 h-3.5" />}>
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          </Show>
          Install
        </button>
      </Show>
    </div>
  )
}

const ScopeMenu: Component<{
  onPick: (scope: PluginScope) => void
  pending: boolean
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [scope, setScope] = createSignal<PluginScope>('user')
  return (
    <>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded ring-1 ring-accent/30 bg-accent-muted text-accent hover:bg-accent/15 text-[12px] disabled:opacity-50"
        disabled={props.pending}
        onClick={() => props.onPick(scope())}
      >
        <Show when={props.pending} fallback={<Download class="w-3.5 h-3.5" />}>
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
        </Show>
        Install
      </button>
      <div class="relative">
        <button
          class="px-2 py-1.5 rounded ring-1 ring-outline/10 hover:bg-outline/5 text-[11px] flex items-center gap-1"
          onClick={() => setOpen(o => !o)}
          title="Install scope"
        >
          {scope()}
        </button>
        <Show when={open()}>
          <div class="absolute right-0 bottom-full mb-1 ring-1 ring-outline/10 rounded bg-surface-2 z-10 min-w-24 shadow-lg">
            <For each={['user', 'project', 'local'] as PluginScope[]}>
              {s => (
                <button
                  class="block w-full px-3 py-1.5 text-left text-[11px] hover:bg-outline/5"
                  onClick={() => { setScope(s); setOpen(false) }}
                >
                  {s}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
