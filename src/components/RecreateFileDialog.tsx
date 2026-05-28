import { Component, Show } from 'solid-js'
import { Dialog } from './Dialog'
import {
  activeRecreate,
  dismissRecreate,
  resolveRecreate,
} from '../store/fileSync'

export const RecreateFileDialog: Component = () => {
  return (
    <Show when={activeRecreate()}>
      {(r) => (
        <Dialog open={true} onClose={() => dismissRecreate()} width="24rem">
          <h2 class="text-base font-semibold text-text-primary mb-2">
            Recreate file?
          </h2>
          <p class="text-sm text-text-muted mb-4">
            <code class="text-text-primary">{r().relativePath}</code> was deleted
            on disk. Saving will recreate it with your buffer.
          </p>

          <div class="flex justify-end gap-2">
            <button class="btn-ghost" onClick={() => dismissRecreate()}>
              Cancel
            </button>
            <button class="btn-primary" onClick={() => resolveRecreate(r())}>
              Recreate
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  )
}
