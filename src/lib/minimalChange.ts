/**
 * The smallest single replacement that turns `a` into `b`: everything between
 * their common prefix and common suffix. Applying a file's new disk content
 * this way keeps the editor's cursor, scroll and folds outside the edit.
 */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  let start = 0
  const max = Math.min(a.length, b.length)
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB-- }
  return { from: start, to: endA, insert: b.slice(start, endB) }
}
