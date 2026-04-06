import { Component, createSignal, Show } from 'solid-js'
import { GitMerge, Eye } from 'lucide-solid'
import * as ipc from '../lib/ipc'

interface Props {
  taskId: string
  branch: string
  onMerge: (targetBranch: string) => void
}

export const MergeBar: Component<Props> = (props) => {
  const [diff, setDiff] = createSignal<string | null>(null)
  const [showDiff, setShowDiff] = createSignal(false)

  const viewDiff = async () => {
    if (!diff()) {
      const d = await ipc.getDiff(props.taskId)
      setDiff(d)
    }
    setShowDiff(!showDiff())
  }

  return (
    <div class="border-t border-border-subtle">
      <Show when={showDiff() && diff()}>
        <pre class="px-4 py-3 text-xs font-mono overflow-auto max-h-60 bg-surface-1 border-b border-border-subtle text-text-muted leading-relaxed">
          {diff()}
        </pre>
      </Show>

      <div class="px-4 py-3 flex items-center justify-between bg-surface-1">
        <div class="text-sm text-text-muted">
          Branch <span class="text-text-primary font-medium">{props.branch}</span> ready to merge
        </div>
        <div class="flex items-center gap-2">
          <button class="btn-ghost flex items-center gap-1.5 text-xs" onClick={viewDiff}>
            <Eye size={13} />
            <span>{showDiff() ? 'Hide' : 'View'} Diff</span>
          </button>
          <button
            class="btn-primary flex items-center gap-1.5 text-xs"
            onClick={() => props.onMerge('main')}
          >
            <GitMerge size={13} />
            <span>Merge to main</span>
          </button>
        </div>
      </div>
    </div>
  )
}
