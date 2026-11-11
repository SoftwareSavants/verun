import { For, Show, createSignal, type JSX } from 'solid-js'
import { QUIET_AFTER_MS, type RecentRow } from '../lib/recentTasks'

/** Tasks most recently active first, with the ones quiet for days folded under one line. */
export function RecentTaskList<T extends RecentRow>(props: { recent: T[]; quiet: T[]; row: (task: T) => JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Show when={props.recent.length + props.quiet.length > 0} fallback={<p class="px-2 py-2 text-[11px] text-text-dim">No other tasks.</p>}>
      <div class="flex flex-col gap-0.5" role="list" aria-label="Recent tasks">
        <For each={props.recent}>{props.row}</For>
        <Show when={props.quiet.length > 0}>
          <Show when={open()}><For each={props.quiet}>{props.row}</For></Show>
          <button
            type="button"
            class="w-full px-2 py-1 rounded-md text-left text-[11px] text-text-dim hover:bg-surface-2 hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => setOpen(o => !o)}
          >
            {open() ? 'Hide quiet tasks' : `${props.quiet.length} quiet for ${QUIET_AFTER_MS / 86_400_000}+ days`}
          </button>
        </Show>
      </div>
    </Show>
  )
}
