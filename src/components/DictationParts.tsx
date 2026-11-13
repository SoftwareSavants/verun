import { Component, Show, createMemo, type Accessor } from 'solid-js'
import { modelDownloads, downloadDictationModel } from '../store/voice'
import { formatDownloadSize } from '../lib/format'
import type { FnSystemAction, ModelStatus, VoiceStatus } from '../types/voice'

// Pieces shared by Settings -> Dictation and the setup dialog.

export const MIC_DENIED_HELP =
  'Microphone access is turned off for Verun. Turn it on in System Settings > Privacy & Security > Microphone.'

const FN_ACTIONS: Partial<Record<FnSystemAction, string>> = {
  'input-source': 'change the input source',
  emoji: 'show the emoji picker',
  dictation: 'start macOS dictation',
}

/** One line when Fn is the hold key and macOS also acts on Fn; nothing otherwise. */
export const FnConflictHint: Component<{ status: VoiceStatus; class?: string }> = (props) => {
  const action = () => (props.status.holdKey === 'fn' ? FN_ACTIONS[props.status.fnSystemAction] : undefined)
  return (
    <Show when={action()}>
      {(a) => (
        <p class={props.class ?? 'text-xs text-status-waiting'}>
          macOS also uses the Fn key to {a()}. Turn that off in System Settings &gt; Keyboard, or choose another hold key.
        </p>
      )}
    </Show>
  )
}

export const SMALL_BUTTON = 'shrink-0 px-2.5 py-1 rounded-lg text-xs bg-surface-3 hover:bg-surface-4 text-text-secondary hover:text-text-primary transition-colors'

/**
 * The keys of a list from the status, as an array that keeps its identity until
 * the set of keys changes: `<For>` over it keeps its rows (and their focus) when
 * a status event brings new but equal objects. Look each item up by key.
 */
export function stableKeys<K>(keys: () => K[]): Accessor<K[]> {
  return createMemo(keys, [], { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) })
}

/** Focuses the element once it is in the document: the primary action of a dialog step. */
export const focusOnMount = (el: HTMLElement) => queueMicrotask(() => el.focus())

/** Where a model's download stands, from the progress events. */
export function downloadPhase(model: ModelStatus): 'idle' | 'running' | 'failed' | 'finishing' {
  const d = modelDownloads()[model.id]
  if (!d) return 'idle'
  if (!d.done) return 'running'
  if (d.error) return 'failed'
  return model.installed ? 'idle' : 'finishing'
}

export const downloadLabel = (model: ModelStatus) => `Download (${formatDownloadSize(model.bytes)})`

/** Progress bar and "received / total" for a running download. */
export const DownloadProgress: Component<{ model: ModelStatus }> = (props) => {
  const d = () => modelDownloads()[props.model.id]
  const total = () => d()?.total || props.model.bytes
  const received = () => Math.min(d()?.received ?? 0, total())
  return (
    <div class="flex-1 min-w-0">
      <div
        role="progressbar"
        aria-label={`Downloading ${props.model.displayName}`}
        aria-valuemin={0}
        aria-valuemax={total()}
        aria-valuenow={received()}
        class="h-1.5 rounded-full bg-surface-3 overflow-hidden"
      >
        <div class="h-full bg-accent transition-[width]" style={{ width: `${total() > 0 ? (received() / total()) * 100 : 0}%` }} />
      </div>
      <div class="text-xs text-text-dim mt-1 tabular-nums">
        {formatDownloadSize(received())} / {formatDownloadSize(total())}
      </div>
    </div>
  )
}

/**
 * A model's download: a button naming the size before it starts, progress while
 * it runs, the error and Try again when it failed. Nothing starts without a click.
 */
export const ModelDownload: Component<{ model: ModelStatus; focus?: boolean; onStart?: () => void }> = (props) => {
  const phase = () => downloadPhase(props.model)
  const start = () => {
    props.onStart?.()
    downloadDictationModel(props.model.id)
  }
  const focus = (el: HTMLElement) => { if (props.focus) focusOnMount(el) }
  return (
    <Show when={phase() !== 'idle'} fallback={
      <button type="button" ref={focus} class={props.focus ? 'btn-primary' : SMALL_BUTTON} onClick={start}>
        {downloadLabel(props.model)}
      </button>
    }>
      <Show when={phase() === 'failed'} fallback={<DownloadProgress model={props.model} />}>
        <div class="flex-1 min-w-0 flex items-center justify-between gap-3">
          <span class="text-xs text-status-error min-w-0">Download failed: {modelDownloads()[props.model.id]?.error}</span>
          <button type="button" ref={focus} class={props.focus ? 'btn-primary' : SMALL_BUTTON} onClick={start}>Try again</button>
        </div>
      </Show>
    </Show>
  )
}
