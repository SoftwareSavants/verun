import { Component, createSignal, For, Show, onCleanup, onMount, type JSX } from 'solid-js'
import { clsx } from 'clsx'
import { Plug, EyeOff, Loader2 } from 'lucide-solid'
import { Popover } from './Popover'
import {
  mcpServers, refreshMcpStatus, authenticateMcpServer, reconnectMcpServer, mcpActionPending,
  hiddenMcpServers, hideMcpServers, unhideAllMcpServers,
} from '../store/mcpServers'
import { mcpProblemGroups, mcpDisplayName, mcpServerAction } from '../lib/mcpStatus'
import type { McpServerStatus } from '../types'

// MCP servers that failed or are waiting for sign-in, as a composer chip.
// In stream-json mode there is no `/mcp`, so this is where they get fixed.
// A failed server is a problem; one never signed in is usually a claude.ai
// connector nobody uses, so it stays quiet and can be hidden for good.
export const McpStatusChip: Component<{ sessionId: string }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // Folded behind the failures; the whole point when nothing failed.
  const [expandSignIn, setShowSignIn] = createSignal(false)
  const showSignIn = () => expandSignIn() || groups().failed.length === 0
  const groups = () => mcpProblemGroups(mcpServers[props.sessionId], hiddenMcpServers())
  const anything = () => { const g = groups(); return g.failed.length + g.signIn.length + g.hidden > 0 }

  // Sign-in finishes in the browser; re-check when the user comes back.
  onMount(() => {
    const onFocus = () => { if (anything()) void refreshMcpStatus(props.sessionId) }
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  const label = () => {
    const g = groups()
    if (g.failed.length) return `${g.failed.length} MCP failed`
    if (g.signIn.length) return `${g.signIn.length} MCP sign-in${g.signIn.length === 1 ? '' : 's'}`
    return ''
  }

  const run = async (s: McpServerStatus) => {
    setError(null)
    const err = mcpServerAction(s.status) === 'authenticate'
      ? await authenticateMcpServer(props.sessionId, s.name)
      : await reconnectMcpServer(props.sessionId, s.name)
    if (err) setError(`${mcpDisplayName(s.name).name}: ${err}`)
  }

  const heading = (text: string, action?: JSX.Element) => (
    <div class="flex items-center justify-between px-3 pt-2.5 pb-1">
      <span class="text-[10px] uppercase tracking-wider text-text-secondary font-medium">{text}</span>
      {action}
    </div>
  )

  const row = (s: McpServerStatus) => {
    const display = mcpDisplayName(s.name)
    const signIn = s.status === 'needs-auth'
    const pending = () => mcpActionPending(props.sessionId, s.name)
    return (
      <div class={clsx("group/row flex items-center gap-2 px-3 hover:bg-surface-3/60", signIn ? "py-1" : "py-1.5")}>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-1.5 min-w-0">
            <span class="text-[12px] text-text-primary truncate">{display.name}</span>
            <Show when={display.source}>
              <span class="text-[10px] text-text-dim shrink-0">{display.source}</span>
            </Show>
          </div>
          <Show when={!signIn}>
            <div class="text-[11px] text-text-dim line-clamp-2 break-words" title={s.error}>{s.error ?? 'Failed to connect'}</div>
          </Show>
        </div>
        <button
          class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-accent hover:bg-accent/10 disabled:opacity-60 transition-colors"
          aria-label={signIn ? `Sign in to ${display.name}` : `Reconnect ${display.name}`}
          disabled={pending()}
          onClick={() => run(s)}
        >
          <Show when={pending()}><Loader2 size={10} class="animate-spin" /></Show>
          {signIn ? 'Sign in' : 'Reconnect'}
        </button>
        <button
          class="shrink-0 p-1 rounded text-text-dim opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-text-secondary hover:bg-surface-3 transition-opacity"
          aria-label={`Hide ${display.name}`}
          title="Hide this server"
          onClick={() => hideMcpServers([s.name])}
        >
          <EyeOff size={12} />
        </button>
      </div>
    )
  }

  return (
    <Show when={anything()}>
      <div class="relative">
        <button
          class={clsx(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-surface-2',
            groups().failed.length ? 'text-text-secondary hover:text-text-primary' : 'text-text-dim hover:text-text-secondary',
          )}
          aria-label={`MCP servers${label() ? `: ${label()}` : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open()}
          title="MCP servers"
          onClick={() => setOpen(o => !o)}
        >
          <span class="relative flex">
            <Plug size={13} />
            <Show when={groups().failed.length}>
              <span class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-status-error ring-2 ring-surface-1" />
            </Show>
          </span>
          <Show when={label()}><span>{label()}</span></Show>
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} class="w-80 absolute bottom-full left-0 mb-1.5 max-h-[60vh] overflow-y-auto pb-1">
          <Show when={groups().failed.length}>
            {heading('Failed')}
            <For each={groups().failed}>{row}</For>
          </Show>
          <Show when={groups().signIn.length}>
            {heading('Not signed in', (
              <button
                class="text-[11px] text-text-muted hover:text-text-primary"
                aria-label="Hide all not signed in"
                onClick={() => hideMcpServers(groups().signIn.map(s => s.name))}
              >
                Hide all
              </button>
            ))}
            <Show
              when={showSignIn()}
              fallback={
                <button
                  class="w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-3/60"
                  aria-label="Show servers not signed in"
                  onClick={() => setShowSignIn(true)}
                >
                  <span>{groups().signIn.length} server{groups().signIn.length === 1 ? '' : 's'}</span>
                  <span class="text-[11px] text-text-muted">Show</span>
                </button>
              }
            >
              <For each={groups().signIn}>{row}</For>
            </Show>
          </Show>
          <Show when={error()}>
            <div class="px-3 py-1.5 text-[11px] text-status-error">{error()}</div>
          </Show>
          <Show when={groups().hidden}>
            <div class={clsx('flex items-center justify-between px-3 py-2 text-[11px] text-text-dim', (groups().failed.length || groups().signIn.length) && 'mt-1 border-t-1 border-t-solid border-t-border-subtle')}>
              <span>{groups().hidden} hidden</span>
              <button class="hover:text-text-secondary" aria-label="Show hidden" onClick={() => unhideAllMcpServers()}>Show</button>
            </div>
          </Show>
        </Popover>
      </div>
    </Show>
  )
}
