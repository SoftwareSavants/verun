import { Component } from 'solid-js'

interface Props {
  onCancel: () => void
  onConfirm: () => void
  confirmLabel?: string
  loadingLabel?: string
  confirmClass?: string
  disabled?: boolean
  loading?: boolean
}

export const DialogFooter: Component<Props> = (props) => {
  return (
    <div class="flex justify-end gap-2">
      <button class="btn-ghost" onClick={props.onCancel}>Cancel</button>
      <button
        class={props.confirmClass || 'btn-primary'}
        onClick={props.onConfirm}
        disabled={props.disabled || props.loading}
      >
        {props.loading ? (props.loadingLabel || 'Loading...') : (props.confirmLabel || 'Confirm')}
      </button>
    </div>
  )
}
