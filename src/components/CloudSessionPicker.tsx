import { For, Show, createSignal, onCleanup, onMount, type Component } from 'solid-js'
import { ArrowDownToLine, Loader2, RefreshCw, Search } from 'lucide-solid'
import { startCloudTaskImport } from '../store/tasks'
import * as ipc from '../lib/ipc'

interface Props {
  projectId: string
  onStarted: () => void
}

export const CloudSessionPicker: Component<Props> = (props) => {
  const [sessions, setSessions] = createSignal<ipc.CloudSessionChoice[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal('')
  let importId: string | null = null
  let disposed = false
  let generation = 0

  async function load() {
    const current = ++generation
    setLoading(true); setError(null); setQuery('')
    try {
      if (importId) { await ipc.cancelCloudImport(importId); importId = null }
      const result = await ipc.beginCloudImport(props.projectId)
      if (disposed || current !== generation) { await ipc.cancelCloudImport(result.importId); return }
      importId = result.importId
      setSessions(result.sessions)
    } catch (e) { if (!disposed && current === generation) setError(String(e).replace(/^Error: /, '')) }
    finally { if (!disposed && current === generation) setLoading(false) }
  }

  function select(session: ipc.CloudSessionChoice) {
    if (!importId) return
    startCloudTaskImport(props.projectId, importId, session)
    importId = null // The background job now owns cleanup, including retries.
    props.onStarted()
  }

  const filtered = () => sessions().filter(s => s.title.toLowerCase().includes(query().toLowerCase()))
  onMount(() => void load())
  onCleanup(() => {
    disposed = true; generation++
    if (importId) void ipc.cancelCloudImport(importId).catch(() => {})
  })

  return (
    <div class="mb-4">
      <Show when={!loading()}>
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-text-dim">Cloud sessions</span>
          <button class="btn-ghost text-xs flex items-center gap-1.5" onClick={() => void load()}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </Show>
      <Show when={loading()}>
        <div class="py-3" role="status">
          <div class="flex items-center gap-2 text-sm text-text-primary"><Loader2 size={14} class="animate-spin text-accent" />Finding cloud sessions</div>
          <p class="text-xs text-text-muted mt-1.5 mb-4">Connecting through Claude Code. This can take a few seconds.</p>
          <div aria-hidden="true" class="rounded-lg ring-1 ring-outline/8 overflow-hidden">
            <For each={['72%', '56%', '64%']}>{width => <div class="px-3 py-3">
              <div class="h-3 rounded bg-surface-3" style={{ width }} />
              <div class="h-2 rounded bg-surface-3 w-16 mt-2" />
            </div>}</For>
          </div>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-sm text-status-error mb-3">{error()}</p>
      </Show>
      <Show when={!loading() && !error()}>
        <Show when={sessions().length > 0} fallback={
          <p class="text-sm text-text-muted py-3">No cloud sessions for this repository. Start one in Claude Code on the web, then refresh.</p>
        }>
          <div class="relative mb-2">
            <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
            <input aria-label="Search cloud sessions" class="input-base pl-8" placeholder="Search sessions…" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
          </div>
          <div class="max-h-64 overflow-y-auto rounded-lg ring-1 ring-outline/8">
            <For each={filtered()}>{session => (
              <button class="w-full flex items-center gap-3 text-left px-3 py-3 hover:bg-surface-3 focus-visible:bg-surface-3 transition-colors" onClick={() => void select(session)}>
                <span class="min-w-0 flex-1"><span class="block text-sm text-text-primary truncate" title={session.title}>{session.title}</span><span class="block text-xs text-text-dim mt-0.5">{session.updated}</span></span>
                <ArrowDownToLine size={14} class="text-text-dim shrink-0" />
              </button>
            )}</For>
            <Show when={filtered().length === 0}><p class="text-sm text-text-dim px-3 py-4">No matching sessions.</p></Show>
          </div>
          <p class="text-xs text-text-dim mt-2">Click a session to continue in a new local task.</p>
        </Show>
      </Show>
    </div>
  )
}
