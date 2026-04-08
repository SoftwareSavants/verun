import { Component } from 'solid-js'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'

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

      <DialogFooter
        onCancel={props.onCancel}
        onConfirm={props.onConfirm}
        confirmLabel={props.confirmLabel}
        confirmClass={props.danger ? 'btn-danger border border-status-error/20' : undefined}
      />
    </Dialog>
  )
}
