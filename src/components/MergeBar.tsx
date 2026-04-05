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
    <div class="border-t border-border bg-surface-1">
      <Show when={showDiff() && diff()}>
        <pre class="p-3 text-xs font-mono overflow-auto max-h-60 bg-surface-0 border-b border-border text-gray-300">
          {diff()}
        </pre>
      </Show>

      <div class="px-4 py-3 flex items-center justify-between">
        <div class="text-sm text-gray-400">
          Branch <span class="text-gray-200 font-medium">{props.branch}</span> is ready to merge
        </div>
        <div class="flex items-center gap-2">
          <button class="btn-ghost flex items-center gap-1.5" onClick={viewDiff}>
            <Eye size={14} />
            <span>{showDiff() ? 'Hide' : 'View'} Diff</span>
          </button>
          <button
            class="btn-primary flex items-center gap-1.5"
            onClick={() => props.onMerge('main')}
          >
            <GitMerge size={14} />
            <span>Merge to main</span>
          </button>
        </div>
      </div>
    </div>
  )
}
