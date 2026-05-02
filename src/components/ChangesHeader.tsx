import { Component, Show } from 'solid-js'
import { RefreshCw } from 'lucide-solid'
import type { SectionKind } from './FileSection'

interface Props {
  conflicts: number
  staged: number
  changes: number
  totalInsertions: number
  totalDeletions: number
  loading: boolean
  selectedCommitShortHash?: string
  onRefresh: () => void
  onJumpToSection: (kind: SectionKind) => void
}

export const ChangesHeader: Component<Props> = (props) => {
  return (
    <div class="flex items-center justify-between px-3 h-9 bg-surface-1">
      <div class="flex items-center gap-2 text-xs text-text-muted min-w-0">
        <span class="font-medium text-text-secondary shrink-0">
          {props.selectedCommitShortHash ? 'Commit' : 'Changes'}
        </span>
        <Show when={props.selectedCommitShortHash}>
          <span class="font-mono text-text-dim truncate">{props.selectedCommitShortHash}</span>
        </Show>

        <Show when={props.conflicts > 0}>
          <button
            data-testid="conflict-seg"
            class="text-red-400 animate-pulse hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('conflicts')}
          >
            !{props.conflicts} conflict{props.conflicts !== 1 ? 's' : ''}
          </button>
        </Show>
        <Show when={props.staged > 0}>
          <Show when={props.conflicts > 0}><span class="text-text-dim shrink-0">·</span></Show>
          <button
            data-testid="staged-seg"
            class="hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('staged')}
          >
            {props.staged} staged
          </button>
        </Show>
        <Show when={props.changes > 0}>
          <Show when={props.conflicts > 0 || props.staged > 0}><span class="text-text-dim shrink-0">·</span></Show>
          <button
            data-testid="changes-seg"
            class="hover:underline shrink-0 tabular-nums"
            onClick={() => props.onJumpToSection('changes')}
          >
            {props.changes} change{props.changes !== 1 ? 's' : ''}
          </button>
        </Show>

        <Show when={props.totalInsertions > 0}>
          <span class="text-emerald-400 shrink-0 tabular-nums">+{props.totalInsertions}</span>
        </Show>
        <Show when={props.totalDeletions > 0}>
          <span class="text-red-400 shrink-0 tabular-nums">-{props.totalDeletions}</span>
        </Show>
      </div>

      <div class="flex items-center gap-0.5 shrink-0">
        <button
          class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 disabled:opacity-40"
          onClick={props.onRefresh}
          disabled={props.loading}
          title="Refresh"
        >
          <RefreshCw size={12} class={props.loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  )
}
