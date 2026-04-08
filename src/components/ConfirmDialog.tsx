import { Component } from 'solid-js'
import { Dialog } from './Dialog'

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
  return (
    <Dialog open={props.open} onClose={props.onCancel} onConfirm={props.onConfirm}>
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
    </Dialog>
  )
}
