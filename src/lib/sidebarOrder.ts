import type { SidebarView } from '../store/sidebarView'

/**
 * The order the sidebar shows tasks in, for everything that walks it:
 * `numbered` is what the ⌘1-9 labels and shortcuts count (folded quiet tasks
 * and the pinned Needs you rows get none in the recent view), `navigation` is
 * what ⌘⌥↑/↓ steps through, top to bottom as on screen.
 */
export function sidebarOrder<T extends { id: string }>(
  view: SidebarView,
  lists: { byProject: readonly T[]; recent: readonly T[]; needsYou: readonly T[] },
): { numbered: T[]; navigation: T[] } {
  if (view === 'recent') {
    return { numbered: [...lists.recent], navigation: [...lists.needsYou, ...lists.recent] }
  }
  return { numbered: [...lists.byProject], navigation: [...lists.byProject] }
}
