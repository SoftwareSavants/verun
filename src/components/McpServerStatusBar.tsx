import { Component, createSignal, For, Show, onCleanup, onMount } from 'solid-js'
import { Plug, X, Loader2 } from 'lucide-solid'
import { mcpServers, refreshMcpStatus, authenticateMcpServer, reconnectMcpServer, mcpActionPending } from '../store/mcpServers'
import { mcpServersNeedingAttention, mcpServerAction } from '../lib/mcpStatus'

// Shows MCP servers that failed or need sign-in for the current session. In
// stream-json mode there is no `/mcp`, so this is the only place to fix them.
export const McpServerStatusBar: Component<{ sessionId: string }> = (props) => {
  const [dismissed, setDismissed] = createSignal<Record<string, boolean>>({})
  const [expanded, setExpanded] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const problems = () => mcpServersNeedingAttention(mcpServers[props.sessionId])
  const visible = () => problems().length > 0 && !dismissed()[props.sessionId]

  // Sign-in finishes in the browser; re-check when the user comes back.
  onMount(() => {
    const onFocus = () => {
      if (problems().length > 0) refreshMcpStatus(props.sessionId)
    }
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  const run = async (name: string, status: string) => {
    setError(null)
    const action = mcpServerAction(status)
    const err = action === 'authenticate'
      ? await authenticateMcpServer(props.sessionId, name)
      : await reconnectMcpServer(props.sessionId, name)
    if (err) setError(`${name}: ${err}`)
  }

  return (
    <Show when={visible()}>
      <div class="bg-surface-1 ring-1 ring-amber-500/30 rounded-xl px-3 py-2 mb-2 text-xs">
        <div class="flex items-center gap-2">
          <Plug size={13} class="text-amber-500 shrink-0" />
          <button class="flex-1 text-left text-amber-500 hover:text-amber-400" onClick={() => setExpanded(e => !e)}>
            {problems().length === 1 ? `MCP server "${problems()[0].name}"` : `${problems().length} MCP servers`} unavailable
            <span class="text-text-dim ml-1">{expanded() ? '(hide)' : '(details)'}</span>
          </button>
          <button
            class="p-0.5 rounded text-text-dim hover:text-text-secondary"
            title="Dismiss"
            onClick={() => setDismissed(d => ({ ...d, [props.sessionId]: true }))}
          >
            <X size={12} />
          </button>
        </div>
        <Show when={expanded()}>
          <div class="mt-2 flex flex-col gap-1.5">
            <For each={problems()}>
              {(s) => (
                <div class="flex items-center gap-2 min-w-0">
                  <span class="font-medium text-text-primary truncate">{s.name}</span>
                  <span class="text-text-dim truncate flex-1" title={s.error}>
                    {s.status === 'needs-auth' ? 'needs sign-in' : s.error ?? 'failed to connect'}
                  </span>
                  <button
                    class="shrink-0 px-2 py-0.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-60 flex items-center gap-1"
                    disabled={mcpActionPending(props.sessionId, s.name)}
                    onClick={() => run(s.name, s.status)}
                  >
                    <Show when={mcpActionPending(props.sessionId, s.name)}>
                      <Loader2 size={10} class="animate-spin" />
                    </Show>
                    {mcpServerAction(s.status) === 'authenticate' ? 'Sign in' : 'Reconnect'}
                  </button>
                </div>
              )}
            </For>
            <Show when={error()}>
              <div class="text-status-error">{error()}</div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
