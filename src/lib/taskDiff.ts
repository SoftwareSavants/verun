/**
 * Ids present in `curr` but not in `prev`. When `prev` is undefined (first run),
 * every id in `curr` is returned. Used by the sidebar's "load per-task data"
 * effect so a single task insert doesn't re-fire the effect for every existing
 * task — that storm is what exhausts macOS's 256 FD limit when `ipc.createTask`
 * is spawning `git check-ref-format` in parallel.
 */
export function newTaskIds(
  prev: readonly string[] | undefined,
  curr: readonly string[],
): string[] {
  if (!prev) return [...curr]
  const prevSet = new Set(prev)
  return curr.filter(id => !prevSet.has(id))
}
