import { For, Show, createSignal, type JSX } from 'solid-js'
import { clsx } from 'clsx'
import { QUIET_AFTER_MS, type StatusRow, type StatusSection } from '../lib/statusView'

/**
 * The sidebar's status view: one group per status, newest first, with tasks
 * nobody touched for days folded under a single line per group.
 */
export function StatusTaskList<T extends StatusRow>(props: {
  sections: StatusSection<T>[]
  row: (task: T) => JSX.Element
}) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => setOpen(s => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n })
  return (
    <Show when={props.sections.length > 0} fallback={<p class="px-2 py-2 text-[11px] text-text-dim">No tasks yet.</p>}>
      <For each={props.sections}>{section => {
        const urgent = () => section.id === 'attention'
        return (
          <section aria-label={section.name} class="mb-2">
            <h3 class={clsx(
              'px-2 pt-2 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider',
              urgent() ? 'text-status-waiting' : 'text-text-dim',
            )}>
              <span class="flex-1">{section.name}</span>
              <span class="font-normal tabular-nums">{section.recent.length + section.quiet.length}</span>
            </h3>
            <div class="flex flex-col gap-0.5">
              <For each={section.recent}>{props.row}</For>
              <Show when={section.quiet.length > 0}>
                <Show when={open().has(section.id)}>
                  <For each={section.quiet}>{props.row}</For>
                </Show>
                <button
                  type="button"
                  class="w-full px-2 py-1 rounded-md text-left text-[11px] text-text-dim hover:bg-surface-2 hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-accent"
                  onClick={() => toggle(section.id)}
                >
                  {open().has(section.id) ? 'Hide quiet tasks' : `${section.quiet.length} quiet for ${QUIET_AFTER_MS / 86_400_000}+ days`}
                </button>
              </Show>
            </div>
          </section>
        )
      }}</For>
    </Show>
  )
}
