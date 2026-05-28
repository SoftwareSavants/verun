import { Component, Show } from 'solid-js'
import { SquareArrowOutUpRight, Undo2, Plus, Minus } from 'lucide-solid'
import { getFileIcon } from '../lib/fileIcons'
import { badgeForEntry, type FileEntry } from '../lib/gitStatus'

interface Props {
  entry: FileEntry
  active: boolean
  insertions?: number
  deletions?: number
  onOpenDiff: () => void
  onOpenDiffPinned?: () => void
  onOpenFile: () => void
  onPrimary: () => void   // stage on unstaged, unstage on staged, conflict-stage on conflict
  onDiscard: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export const FileRow: Component<Props> = (props) => {
  const badge = () => badgeForEntry(props.entry)
  const fileName = () => props.entry.file.path.split('/').pop() || props.entry.file.path
  const FileIcon = () => {
    const I = getFileIcon(fileName())
    return <I size={12} />
  }

  const isStaged = () => props.entry.kind === 'staged'
  const isConflict = () => props.entry.kind === 'conflict'
  const showDiscard = () => !isConflict()

  const primaryTitle = () => isStaged() ? 'Unstage' : 'Stage'
  const PrimaryIcon = () => isStaged() ? <Minus size={12} /> : <Plus size={12} />

  return (
    <div
      data-testid="file-row"
      class={`group flex items-center gap-2 px-3 h-7 cursor-pointer text-xs ${
        props.active ? 'bg-surface-2 text-text-primary' : 'hover:bg-surface-2 text-text-secondary'
      }`}
      style={{ 'box-shadow': props.active ? 'inset 2px 0 0 #2d6e4f' : undefined }}
      onClick={props.onOpenDiff}
      onDblClick={(e) => { e.stopPropagation(); props.onOpenDiffPinned?.() }}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <span class="shrink-0 text-text-dim">
        <FileIcon />
      </span>

      <span class="truncate flex-1" title={props.entry.file.path}>
        {props.entry.file.path}
      </span>

      <span class="shrink-0 hidden group-hover:flex items-center gap-0.5">
        <button
          class="h-4 w-4 flex items-center justify-center rounded hover:bg-surface-3 text-text-dim hover:text-text-secondary"
          title="Open File"
          onClick={(e) => { e.stopPropagation(); props.onOpenFile() }}
        >
          <SquareArrowOutUpRight size={12} />
        </button>
        <Show when={showDiscard()}>
          <button
            class="h-4 w-4 flex items-center justify-center rounded text-text-dim hover:text-text-secondary hover:bg-surface-3"
            title="Discard"
            onClick={(e) => { e.stopPropagation(); props.onDiscard() }}
          >
            <Undo2 size={12} />
          </button>
        </Show>
        <button
          class="h-4 w-4 flex items-center justify-center rounded hover:bg-surface-3 text-text-dim hover:text-text-secondary"
          title={primaryTitle()}
          onClick={(e) => { e.stopPropagation(); props.onPrimary() }}
        >
          <PrimaryIcon />
        </button>
      </span>

      <Show when={props.insertions || props.deletions}>
        <span class="shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums">
          <Show when={(props.insertions ?? 0) > 0}>
            <span class="text-emerald-400">+{props.insertions}</span>
          </Show>
          <Show when={(props.deletions ?? 0) > 0}>
            <span class="text-red-400">-{props.deletions}</span>
          </Show>
        </span>
      </Show>

      <span
        class={`shrink-0 text-[11px] font-medium tabular-nums w-3 text-center ${badge().colorClass}`}
        title={badge().tooltip || badge().label}
      >
        {badge().letter}
      </span>
    </div>
  )
}
