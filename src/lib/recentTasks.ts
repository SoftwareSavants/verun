// The sidebar's recent view: every task in one list, most recently active
// first. A sort, not groups: a task flips between running and idle every turn,
// and in groups it would jump around; sorted, the work in motion stays on top.
import type { BoardColumn } from './taskBoard'

/** Untouched this long, a task folds away at the bottom. */
export const QUIET_AFTER_MS = 3 * 24 * 3600_000

export interface RecentRow { id: string; column: BoardColumn; lastActive: number }

export function recentTasks<T extends RecentRow>(rows: readonly T[], now: number, quietAfter = QUIET_AFTER_MS) {
  // Needs you is pinned above the list; archived work isn't listed.
  const listed = rows.filter(r => r.column !== 'attention' && r.column !== 'archived').sort((a, b) => b.lastActive - a.lastActive)
  const isQuiet = (r: T) => r.column !== 'running' && now - r.lastActive > quietAfter
  return { recent: listed.filter(r => !isQuiet(r)), quiet: listed.filter(isQuiet) }
}
