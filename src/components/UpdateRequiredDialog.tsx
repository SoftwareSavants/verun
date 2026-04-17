import { Component } from 'solid-js'
import { Dialog } from './Dialog'

interface Props {
  open: boolean
  modelName: string
  minVersion: string
  updateHint: string
  onClose: () => void
}

export const UpdateRequiredDialog: Component<Props> = (props) => {
  const copyCommand = () => navigator.clipboard.writeText(props.updateHint)

  return (
    <Dialog open={props.open} onClose={props.onClose}>
      <h2 class="text-base font-semibold text-text-primary mb-2">Update Required</h2>
      <p class="text-sm text-text-muted mb-3">
        {props.modelName} requires v{props.minVersion} or later.
      </p>
      <button
        class="w-full text-left px-3 py-2 mb-4 rounded-md bg-surface-1 ring-1 ring-white/6 font-mono text-xs text-text-secondary hover:text-text-primary hover:ring-white/12 transition-colors select-all"
        onClick={copyCommand}
        title="Click to copy"
      >
        {props.updateHint}
      </button>
      <div class="flex justify-end">
        <button
          class="btn-primary px-3 py-1.5 text-xs rounded-md"
          onClick={props.onClose}
        >
          OK
        </button>
      </div>
    </Dialog>
  )
}
