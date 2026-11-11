import { For, createSignal, type Component } from 'solid-js'
import { CircleHelp } from 'lucide-solid'
import { Popover } from './Popover'
import { TaskStatusIcon } from './TaskStatusIcon'
import { STATUS_GUIDE } from '../lib/taskBoard'

/** What each task status icon means, opened from the sidebar footer. */
export const StatusKey: Component = () => {
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        class="p-1.5 rounded-md transition-colors text-text-dim hover:text-text-secondary hover:bg-surface-3"
        aria-label="Status key"
        title="Status key"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setPos(pos() ? null : { x: r.left, y: r.top - 6 })
        }}
      >
        <CircleHelp size={14} />
      </button>
      <Popover open={!!pos()} pos={pos() ?? undefined} placement="above" onClose={() => setPos(null)} class="w-72 p-1.5">
        <div class="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-dim">Task status</div>
        <For each={STATUS_GUIDE}>{entry => (
          <div class="flex gap-2.5 px-2 py-1">
            <span class="h-4 flex items-center"><TaskStatusIcon kind={entry.kind} label={entry.name} /></span>
            <div class="min-w-0">
              <span class="block text-xs leading-4 text-text-primary">{entry.name}</span>
              <span class="block text-[11px] leading-snug text-text-muted">{entry.meaning}</span>
            </div>
          </div>
        )}</For>
      </Popover>
    </>
  )
}
