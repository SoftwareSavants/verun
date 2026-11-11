// Single source of truth for a task's status, shared by the sidebar, the task
// board and anything else that shows where a task stands.
export type BoardColumn = 'attention' | 'running' | 'idle' | 'review' | 'done' | 'archived' | 'unknown'
/** Icon vocabulary: every kind has its own glyph so status never relies on color alone. */
export type TaskStatusKind =
  | 'input' | 'failed' | 'conflicts' | 'ci-failed'
  | 'running' | 'busy' | 'background'
  | 'idle' | 'pr-open' | 'merged'
  | 'unknown' | 'archived'
export interface TaskStatus { column: BoardColumn; kind: TaskStatusKind; label: string }
export interface BoardActivity {
  unknown?: boolean
  archived?: boolean
  approval?: boolean
  error?: boolean
  conflicts?: boolean
  failedChecks?: boolean
  running?: boolean
  /** The turn ended with background work still going. */
  background?: boolean
  creating?: boolean
  archiving?: boolean
  merged?: boolean
  prOpen?: boolean
}
export function taskBoardState(activity: BoardActivity): TaskStatus {
  if (activity.archived) return { column: 'archived', kind: 'archived', label: 'Archived' }
  if (activity.approval) return { column: 'attention', kind: 'input', label: 'Needs input' }
  if (activity.error) return { column: 'attention', kind: 'failed', label: 'Error' }
  if (activity.conflicts) return { column: 'attention', kind: 'conflicts', label: 'Merge conflicts' }
  if (activity.failedChecks) return { column: 'attention', kind: 'ci-failed', label: 'CI failing' }
  if (activity.archiving) return { column: 'running', kind: 'busy', label: 'Archiving' }
  if (activity.creating) return { column: 'running', kind: 'busy', label: 'Setting up' }
  if (activity.running) return { column: 'running', kind: 'running', label: 'Running' }
  if (activity.background) return { column: 'idle', kind: 'background', label: 'Your turn, work running in background' }
  if (activity.unknown) return { column: 'unknown', kind: 'unknown', label: 'Status unavailable' }
  if (activity.merged) return { column: 'done', kind: 'merged', label: 'PR merged' }
  if (activity.prOpen) return { column: 'review', kind: 'pr-open', label: 'PR open' }
  return { column: 'idle', kind: 'idle', label: 'Idle' }
}

/** Agents doing work right now, in a turn or in the background: what keep-awake guards. */
export const agentsWorking = (s: TaskStatus) => s.kind === 'running' || s.kind === 'background'
