import { Component, Show } from 'solid-js'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmDialog: Component<Props> = (props) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onCancel()
    if (e.key === 'Enter') props.onConfirm()
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={(e) => { if (e.target === e.currentTarget) props.onCancel() }}
        onKeyDown={handleKeyDown}
      >
        <div class="bg-surface-2 border border-border rounded-xl shadow-2xl w-80 p-5 animate-in">
          <h2 class="text-base font-semibold text-text-primary mb-2">{props.title}</h2>
          <p class="text-sm text-text-muted mb-4">{props.message}</p>

          <div class="flex justify-end gap-2">
            <button class="btn-ghost" onClick={props.onCancel}>Cancel</button>
            <button
              class={props.danger ? 'btn-danger border border-status-error/20' : 'btn-primary'}
              onClick={props.onConfirm}
            >
              {props.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
