// Tasks grouped by where they stand, newest first: the sidebar's status view
// and the board share the groups and their order.
import type { BoardColumn } from './taskBoard'

export const BOARD_COLUMNS: { id: BoardColumn; name: string; empty: string }[] = [
  { id: 'attention', name: 'Needs you', empty: 'Nothing needs you.' },
  { id: 'running', name: 'Running', empty: 'No agents working.' },
  { id: 'idle', name: 'Idle', empty: 'Agents that finished their turn land here.' },
  { id: 'review', name: 'In review', empty: 'Open pull requests land here.' },
  { id: 'done', name: 'Done', empty: 'Merged work lands here.' },
  { id: 'unknown', name: 'Status unavailable', empty: '' },
  { id: 'archived', name: 'Archived', empty: 'No archived tasks.' },
]

/** Untouched this long, a task folds away under its group. */
export const QUIET_AFTER_MS = 3 * 24 * 3600_000

export interface StatusRow { id: string; column: BoardColumn; lastActive: number }
export interface StatusSection<T extends StatusRow> { id: BoardColumn; name: string; recent: T[]; quiet: T[] }

/** Only work that's settled folds; what needs you or is running always shows. */
const folds = (column: BoardColumn) => column === 'idle' || column === 'review' || column === 'done'

export const byRecency = <T extends { lastActive: number }>(a: T, b: T) => b.lastActive - a.lastActive

export function statusSections<T extends StatusRow>(rows: readonly T[], now: number, quietAfter = QUIET_AFTER_MS): StatusSection<T>[] {
  return BOARD_COLUMNS.filter(c => c.id !== 'archived').flatMap(column => {
    const all = rows.filter(r => r.column === column.id).sort(byRecency)
    if (all.length === 0) return []
    const isQuiet = (r: T) => folds(column.id) && now - r.lastActive > quietAfter
    return [{ id: column.id, name: column.name, recent: all.filter(r => !isQuiet(r)), quiet: all.filter(isQuiet) }]
  })
}
