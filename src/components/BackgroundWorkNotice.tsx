import { Show, type Component } from 'solid-js'
import { LoaderCircle } from 'lucide-solid'
import type { SessionStatus } from '../types'

/** The turn ended but Claude's subagents or background shells are still running. */
export const BackgroundWorkNotice: Component<{ status: SessionStatus | undefined }> = props => (
  <Show when={props.status === 'background'}>
    <div role="status" class="mx-4 mb-2 px-3 py-1.5 flex items-center gap-2 rounded-md bg-surface-1 ring-1 ring-outline/8 text-xs text-text-muted">
      <LoaderCircle size={12} class="animate-spin text-status-running shrink-0" />
      <span>Background agents are still working. You can keep chatting; Claude picks up their results when they finish.</span>
    </div>
  </Show>
)
