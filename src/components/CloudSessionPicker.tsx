import { For, Show, createSignal, onCleanup, onMount, type Component } from 'solid-js'
import { ArrowDownToLine, Loader2, RefreshCw, Search } from 'lucide-solid'
import type { TaskWithSession } from '../types'
import * as ipc from '../lib/ipc'

interface Props {
  projectId: string
  onReady: (result: TaskWithSession) => void
  onBusyChange?: (busy: boolean) => void
}

export const CloudSessionPicker: Component<Props> = (props) => {
  const [sessions, setSessions] = createSignal<ipc.CloudSessionChoice[]>([])
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal<ipc.CloudSessionChoice | null>(null)
  const [phase, setPhase] = createSignal('')
  let importId: string | null = null
  let teleported = false
  let disposed = false
  let published = false
  let generation = 0

  async function load() {
    if (busy()) return
    const current = ++generation
    setLoading(true); setError(null); setSelected(null); setQuery('')
    teleported = false
    try {
      if (importId) { await ipc.cancelCloudImport(importId); importId = null }
      const result = await ipc.beginCloudImport(props.projectId)
      if (disposed || current !== generation) { await ipc.cancelCloudImport(result.importId); return }
      importId = result.importId
      setSessions(result.sessions)
    } catch (e) { if (!disposed && current === generation) setError(String(e).replace(/^Error: /, '')) }
    finally { if (!disposed && current === generation) setLoading(false) }
  }

  async function select(session: ipc.CloudSessionChoice) {
    if (busy() || !importId) return
    setBusy(true); props.onBusyChange?.(true); setError(null); setSelected(session)
    try {
      if (!teleported) {
        setPhase('Importing conversation and code…')
        await ipc.selectCloudImport(props.projectId, importId, session.index)
        teleported = true
      }
      if (disposed) return
      setPhase('Preparing local task…')
      const result = await ipc.finishCloudImport(props.projectId, importId)
      published = true
      if (!disposed) props.onReady(result)
    } catch (e) {
      if (!disposed) setError(String(e).replace(/^Error: /, ''))
    } finally {
      if (!disposed) { setBusy(false); props.onBusyChange?.(false) }
    }
  }

  const filtered = () => sessions().filter(s => s.title.toLowerCase().includes(query().toLowerCase()))
  onMount(() => void load())
  onCleanup(() => {
    disposed = true; generation++
    if (importId && !published) void ipc.cancelCloudImport(importId).catch(() => {})
  })

  return (
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-text-dim">Cloud sessions</span>
        <button class="btn-ghost text-xs flex items-center gap-1.5" disabled={loading() || busy()} onClick={() => void load()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <Show when={loading()}>
        <p role="status" class="text-sm text-text-muted py-5 flex items-center gap-2"><Loader2 size={14} class="animate-spin" />Loading sessions from Claude…</p>
      </Show>
      <Show when={busy()}>
        <p role="status" class="text-sm text-text-muted py-5 flex items-center gap-2"><Loader2 size={14} class="animate-spin" />{phase()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-sm text-status-error mb-3">{error()}</p>
        <Show when={teleported && selected() && !busy()}>
          <button class="btn-primary" onClick={() => void select(selected()!)}>Retry import</button>
        </Show>
      </Show>
      <Show when={!loading() && !busy() && !error()}>
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
