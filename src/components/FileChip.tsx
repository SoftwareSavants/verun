import { Component, Show } from 'solid-js'
import { FileText, X } from 'lucide-solid'
import type { AttachmentRef } from '../types'
import { formatBytes } from '../lib/format'

/** A non-image attachment (e.g. a handoff packet), in the composer or a sent message. */
export const FileChip: Component<{ file: AttachmentRef; onRemove?: () => void }> = (props) => (
  <div
    class="group relative h-9 max-w-60 flex items-center gap-2 pl-2.5 pr-3 rounded-lg bg-surface-2 ring-1 ring-outline/8 text-[11px] text-text-secondary"
    title={`${props.file.name} · ${formatBytes(props.file.size)}`}
  >
    <FileText size={14} class="shrink-0 text-text-dim" />
    <span class="truncate">{props.file.name}</span>
    <Show when={props.onRemove}>
      <button
        type="button"
        aria-label={`Remove ${props.file.name}`}
        class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-3 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => props.onRemove?.()}
      >
        <X size={10} class="text-text-muted" />
      </button>
    </Show>
  </div>
)
