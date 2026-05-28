import { Component, Show } from 'solid-js'

export type ConflictChoice = 'ours' | 'theirs' | 'asIs'

interface Props {
  path: string | null
  onChoose: (choice: ConflictChoice) => void
  onClose: () => void
}

export const ConflictStageDialog: Component<Props> = (props) => {
  return (
    <Show when={props.path}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={props.onClose}
      >
        <div
          class="bg-surface-2 rounded-lg shadow-2xl ring-1 ring-outline/8 p-4 w-96 max-w-[90vw]"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 class="text-sm font-medium text-text-primary mb-1">Stage with conflict</h3>
          <p class="text-xs text-text-muted mb-3 truncate" title={props.path!}>
            {props.path}
          </p>
          <p class="text-xs text-text-muted mb-4">
            This file has unresolved conflict markers. Choose how to stage it.
          </p>
          <div class="flex flex-col gap-2">
            <button
              class="h-8 px-3 rounded text-xs bg-surface-3 hover:bg-surface-4 text-text-primary text-left"
              onClick={() => props.onChoose('ours')}
            >
              <span class="font-medium">Accept ours</span>
              <span class="text-text-dim ml-2">— keep this branch's version</span>
            </button>
            <button
              class="h-8 px-3 rounded text-xs bg-surface-3 hover:bg-surface-4 text-text-primary text-left"
              onClick={() => props.onChoose('theirs')}
            >
              <span class="font-medium">Accept theirs</span>
              <span class="text-text-dim ml-2">— take the other branch's version</span>
            </button>
            <button
              class="h-8 px-3 rounded text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-left"
              onClick={() => props.onChoose('asIs')}
            >
              <span class="font-medium">Stage as-is</span>
              <span class="text-amber-300/70 ml-2">— keep conflict markers in the commit</span>
            </button>
          </div>
          <div class="mt-3 flex justify-end">
            <button
              class="text-[11px] text-text-dim hover:text-text-secondary"
              onClick={props.onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
