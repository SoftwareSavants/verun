import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { TaskWithSession } from '../types'
import * as ipc from '../lib/ipc'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'
import { ShellTerminal } from './ShellTerminal'
import { closeTerminal } from '../store/terminals'

interface Props {
  projectId: string
  onClose: () => void
  onReady: (result: TaskWithSession) => void
}

export const CloudImportDialog: Component<Props> = (props) => {
  const [importId, setImportId] = createSignal<string | null>(null)
  const [terminalId, setTerminalId] = createSignal<string | null>(null)
  const [phase, setPhase] = createSignal('Opening cloud sessions…')
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let unlisten: UnlistenFn | undefined
  let disposed = false
  let published = false

  async function begin() {
    setBusy(true); setError(null)
    try {
      const result = await ipc.beginCloudImport(props.projectId)
      if (disposed) { await ipc.cancelCloudImport(result.importId); return }
      setImportId(result.importId); setTerminalId(result.terminalId)
      setPhase('Choose a cloud session')
    } catch (e) { setError(String(e)) }
    finally { if (!disposed) setBusy(false) }
  }

  async function finish() {
    if (busy()) return
    const id = importId()
    if (!id) { await begin(); return }
    setBusy(true); setError(null)
    try {
      const result = await ipc.finishCloudImport(props.projectId, id)
      published = true
      props.onReady(result)
    } catch (e) {
      setError(`Local workspace couldn’t be prepared. ${String(e).replace(/^Error: /, '')}`)
      setPhase('Retry when the import is complete')
    } finally { setBusy(false) }
  }

  async function cancel() {
    if (busy()) return
    setBusy(true)
    try {
      const id = importId()
      if (id) await ipc.cancelCloudImport(id)
      setImportId(null)
      props.onClose()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  onMount(() => {
    void listen<ipc.CloudImportProgress>('cloud-import-progress', event => {
      if (event.payload.importId === importId()) setPhase(event.payload.phase)
    }).then(fn => { if (disposed) fn(); else unlisten = fn })
    void begin()
  })
  onCleanup(() => {
    disposed = true; unlisten?.()
    const id = importId()
    if (id && !published) void ipc.cancelCloudImport(id).catch(() => {})
    const terminal = terminalId()
    if (terminal) void closeTerminal(terminal).catch(() => {})
  })

  return (
    <Dialog open onClose={() => void cancel()} width="min(58rem, calc(100vw - 3rem))">
      <h2 class="text-base font-semibold text-text-primary mb-2">Continue from Claude cloud</h2>
      <p class="text-sm text-text-muted mb-4">
        Choose a session below. Once Claude shows “Session resumed”, enter <code>/exit</code>, then continue locally.
        Your conversation and code will open in a new task.
      </p>
      <p role="status" class="text-xs text-text-secondary mb-2">{phase()}</p>
      <Show when={terminalId()}>{id => (
        <div class="h-[min(28rem,50vh)] min-h-48 mb-4 bg-surface-0 rounded-lg ring-1 ring-outline/8 overflow-hidden">
          <ShellTerminal terminalId={id()} disableCmdVIntercept />
        </div>
      )}</Show>
      <Show when={error()}><p role="alert" class="text-sm text-status-error mb-4">{error()}</p></Show>
      <DialogFooter onCancel={() => void cancel()} onConfirm={() => void finish()}
        confirmLabel={error() ? 'Retry' : 'Continue locally'} loading={busy()} loadingLabel={phase()} />
    </Dialog>
  )
}
