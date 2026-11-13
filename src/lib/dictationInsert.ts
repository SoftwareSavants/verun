export interface Selection { start: number; end: number }

/** Insert at `sel` when given, else append. Adds one space between existing text and the take when neither side has whitespace. */
export function insertDictation(existing: string, take: string, sel: Selection | null): { text: string; cursor: number } {
  const start = sel ? Math.min(sel.start, sel.end) : existing.length
  const end = sel ? Math.max(sel.start, sel.end) : existing.length
  const t = take.trim()
  if (!t) return { text: existing, cursor: start }
  const before = existing.slice(0, start)
  const after = existing.slice(end)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : ''
  const head = before + lead + t
  return { text: head + trail + after, cursor: head.length }
}
