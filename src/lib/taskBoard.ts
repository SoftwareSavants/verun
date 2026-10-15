export type BoardColumn = 'attention' | 'running' | 'ready' | 'archived'
export interface BoardActivity {
  archived?: boolean
  approval?: boolean
  error?: boolean
  conflicts?: boolean
  failedChecks?: boolean
  running?: boolean
  creating?: boolean
  archiving?: boolean
  merged?: boolean
  prOpen?: boolean
}
export function taskBoardState(activity: BoardActivity): { column: BoardColumn; label: string } {
  if (activity.archived) return { column: 'archived', label: 'Archived' }
  if (activity.approval) return { column: 'attention', label: 'Approval needed' }
  if (activity.error) return { column: 'attention', label: 'Error' }
  if (activity.conflicts) return { column: 'attention', label: 'Merge conflicts' }
  if (activity.failedChecks) return { column: 'attention', label: 'CI failing' }
  if (activity.archiving) return { column: 'running', label: 'Archiving' }
  if (activity.creating) return { column: 'running', label: 'Setting up' }
  if (activity.running) return { column: 'running', label: 'Running' }
  return { column: 'ready', label: activity.merged ? 'PR merged' : activity.prOpen ? 'PR open' : 'Ready to continue' }
}
