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
  /** What the terminal hooks reported still running, when they did. */
  backgroundWork?: BackgroundWork
  creating?: boolean
  archiving?: boolean
  merged?: boolean
  prOpen?: boolean
}
export interface BackgroundWork { agents: number; shells: number; total: number }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 agents and 1 shell": tells waiting on subagents apart from a lone shell or watcher. */
function backgroundLabel(work?: BackgroundWork): string {
  if (!work || work.total === 0) return 'Your turn, work running in background'
  const other = work.total - work.agents - work.shells
  if (work.agents === 0 && work.shells === 0) return `Your turn, ${plural(work.total, 'background task')} still running`
  const parts = [
    work.agents && plural(work.agents, 'agent'),
    work.shells && plural(work.shells, 'shell'),
    other > 0 && plural(other, 'other task'),
  ].filter((p): p is string => !!p)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  return `Your turn, ${list} still running`
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
  if (activity.background) return { column: 'idle', kind: 'background', label: backgroundLabel(activity.backgroundWork) }
  if (activity.unknown) return { column: 'unknown', kind: 'unknown', label: 'Status unavailable' }
  if (activity.merged) return { column: 'done', kind: 'merged', label: 'PR merged' }
  if (activity.prOpen) return { column: 'review', kind: 'pr-open', label: 'PR open' }
  return { column: 'idle', kind: 'idle', label: 'Idle' }
}

/** Agents doing work right now, in a turn or in the background: what keep-awake guards. */
export const agentsWorking = (s: TaskStatus) => s.kind === 'running' || s.kind === 'background'

/** The board's columns in order; the sidebar and board share them. */
export const BOARD_COLUMNS: { id: BoardColumn; name: string; empty: string }[] = [
  { id: 'attention', name: 'Needs you', empty: 'Nothing needs you.' },
  { id: 'running', name: 'Running', empty: 'No agents working.' },
  { id: 'idle', name: 'Idle', empty: 'Agents that finished their turn land here.' },
  { id: 'review', name: 'In review', empty: 'Open pull requests land here.' },
  { id: 'done', name: 'Done', empty: 'Merged work lands here.' },
  { id: 'unknown', name: 'Status unavailable', empty: '' },
  { id: 'archived', name: 'Archived', empty: 'No archived tasks.' },
]

/** The status key: what each icon means, in the order a glance needs them. */
export const STATUS_GUIDE: { kind: TaskStatusKind; name: string; meaning: string }[] = [
  { kind: 'input', name: 'Needs input', meaning: 'Claude is waiting on an approval or an answer from you.' },
  { kind: 'failed', name: 'Error', meaning: 'The session or its setup failed.' },
  { kind: 'conflicts', name: 'Merge conflicts', meaning: 'The open PR conflicts with its base branch.' },
  { kind: 'ci-failed', name: 'CI failing', meaning: 'Checks on the open PR failed.' },
  { kind: 'running', name: 'Running', meaning: 'Claude is working on a turn.' },
  { kind: 'background', name: 'Your turn, work still running', meaning: 'Subagents, shells or watchers Claude started are still going. Hover a task to see which.' },
  { kind: 'idle', name: 'Idle', meaning: 'Claude finished and nothing is running.' },
  { kind: 'pr-open', name: 'PR open', meaning: 'Waiting on review.' },
  { kind: 'merged', name: 'PR merged', meaning: 'Done.' },
  { kind: 'unknown', name: 'Status unavailable', meaning: "Claude's state can't be read, so check the task." },
]
