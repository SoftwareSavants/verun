import { Component } from 'solid-js'
import { GitMerge } from 'lucide-solid'

interface Props {
  taskId: string
  branch: string
  onMerge: (targetBranch: string) => void
}

export const MergeBar: Component<Props> = (props) => {
  return (
    <div class="border-t border-border-subtle">
      <div class="px-4 py-3 flex items-center justify-between bg-surface-1">
        <div class="text-sm text-text-muted">
          Branch <span class="text-text-primary font-medium">{props.branch}</span> ready to merge
        </div>
        <div class="flex items-center gap-2">
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
