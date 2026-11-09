import { Dynamic } from 'solid-js/web'
import type { Component } from 'solid-js'
import {
  Archive, CircleCheck, CircleDashed, CircleOff, CircleX, GitMergeConflict, GitPullRequest,
  LoaderCircle, MessageCircleQuestion, TriangleAlert,
} from 'lucide-solid'
import type { TaskStatusKind } from '../lib/taskBoard'

// One glyph per status kind: shape carries the meaning, color only reinforces it.
const ICONS: Record<TaskStatusKind, { icon: Component<{ size?: number; class?: string; 'stroke-width'?: number }>; color: string; spin?: boolean; fill?: string }> = {
  input: { icon: MessageCircleQuestion, color: 'text-status-waiting' },
  failed: { icon: TriangleAlert, color: 'text-status-error' },
  conflicts: { icon: GitMergeConflict, color: 'text-status-error' },
  'ci-failed': { icon: CircleX, color: 'text-status-error' },
  running: { icon: LoaderCircle, color: 'text-status-running', spin: true },
  busy: { icon: LoaderCircle, color: 'text-text-dim', spin: true },
  'pr-open': { icon: GitPullRequest, color: 'text-status-done' },
  // Dashed ring: the agent finished its turn but the work isn't done.
  idle: { icon: CircleDashed, color: 'text-text-muted' },
  merged: { icon: CircleCheck, color: 'text-purple-400', fill: 'fill-purple-400/25' },
  unknown: { icon: CircleOff, color: 'text-text-dim' },
  archived: { icon: Archive, color: 'text-text-dim' },
}

export const TaskStatusIcon: Component<{ kind: TaskStatusKind; size?: number; label?: string }> = props => {
  const size = () => props.size ?? 13
  return (
    <span class="shrink-0 inline-flex items-center justify-center" style={{ width: `${size()}px`, height: `${size()}px` }}
      role="img" aria-label={props.label ?? props.kind} title={props.label}>
      <Dynamic component={ICONS[props.kind].icon} size={size()} stroke-width={2.25}
        class={`${ICONS[props.kind].color} ${ICONS[props.kind].fill ?? ''} ${ICONS[props.kind].spin ? 'animate-spin' : ''}`} />
    </span>
  )
}
