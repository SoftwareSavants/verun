import { Component, Show } from 'solid-js'
import { Dialog } from './Dialog'
import {
  activeConflict,
  dismissConflict,
  resolveConflictDiscard,
  resolveConflictOverwrite,
} from '../store/fileSync'

export const FileConflictDialog: Component = () => {
  return (
    <Show when={activeConflict()}>
      {(c) => (
        <Dialog open={true} onClose={() => dismissConflict()} width="28rem">
          <h2 class="text-base font-semibold text-text-primary mb-2">
            File changed on disk
          </h2>
          <p class="text-sm text-text-muted mb-4">
            <code class="text-text-primary">{c().relativePath}</code> was modified
            outside Verun while you have unsaved edits. Overwrite the external
            changes with your version, or discard your edits and load the disk
            version?
          </p>

          <div class="flex justify-end gap-2">
            <button class="btn-ghost" onClick={() => dismissConflict()}>
              Cancel
            </button>
            <button
              class="btn-danger border border-status-error/20"
              onClick={() => resolveConflictDiscard(c())}
            >
              Discard my changes
            </button>
            <button
              class="btn-primary"
              onClick={() => resolveConflictOverwrite(c())}
            >
              Overwrite disk
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  )
}
