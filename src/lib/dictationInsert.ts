export interface Selection { start: number; end: number }

function parts(existing: string, take: string, sel: Selection | null) {
  const start = sel ? Math.min(sel.start, sel.end) : existing.length
  const end = sel ? Math.max(sel.start, sel.end) : existing.length
  const t = take.trim()
  const before = existing.slice(0, start)
  const after = existing.slice(end)
  const lead = t && before !== '' && !/\s$/.test(before) ? ' ' : ''
  const trail = t && after !== '' && !/^\s/.test(after) ? ' ' : ''
  return { start, before, after, lead, t, trail }
}

/** The exact string that replaces `sel` (or goes at the end): the trimmed take plus any space it needs on either side. Empty for an empty take. */
export function dictationInsertText(existing: string, take: string, sel: Selection | null): string {
  const { lead, t, trail } = parts(existing, take, sel)
  return t ? lead + t + trail : ''
}

/** Insert at `sel` when given, else append. Adds one space between existing text and the take when neither side has whitespace. */
export function insertDictation(existing: string, take: string, sel: Selection | null): { text: string; cursor: number } {
  const { start, before, after, lead, t } = parts(existing, take, sel)
  if (!t) return { text: existing, cursor: start }
  const head = before + lead + t
  return { text: before + dictationInsertText(existing, take, sel) + after, cursor: head.length }
}
