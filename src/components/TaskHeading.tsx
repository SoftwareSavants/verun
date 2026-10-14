import { Show } from 'solid-js'

export function TaskHeading(props: { projectName?: string; taskName?: string | null }) {
  return <div class="flex items-center gap-2 min-w-0">
    <Show when={props.projectName}>
      <span class="text-[11px] text-text-muted truncate max-w-40" title={props.projectName}>{props.projectName}</span>
      <span class="text-text-dim text-xs shrink-0" aria-hidden="true">/</span>
    </Show>
    <h2 class="text-[13px] font-medium text-text-primary truncate" title={props.taskName || 'New task'}>{props.taskName || 'New task'}</h2>
  </div>
}
