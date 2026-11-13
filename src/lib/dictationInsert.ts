export interface Selection { start: number; end: number }

/** Han, Hiragana, Katakana, CJK punctuation and fullwidth forms: written without spaces between words. */
const CJK = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/u
/** Never preceded by a space. */
const CLOSING = /^[,.;:!?)\]}،؛؟]/u
/** Never followed by a space. */
const OPENING = /[(\[{“‘«]$/u
/** A straight quote opens when it starts the text or follows whitespace. */
const OPENING_STRAIGHT = /(^|\s)["']$/u

/** Whether `left` and `right` (both non-empty, neither side whitespace at the seam) need a space between them. */
function needsSpace(left: string, right: string): boolean {
  const l = [...left].pop() ?? ''
  const r = [...right][0] ?? ''
  if (CJK.test(l) || CJK.test(r)) return false
  if (CLOSING.test(right)) return false
  if (OPENING.test(left) || OPENING_STRAIGHT.test(left)) return false
  return true
}

function parts(existing: string, take: string, sel: Selection | null) {
  const start = sel ? Math.min(sel.start, sel.end) : existing.length
  const end = sel ? Math.max(sel.start, sel.end) : existing.length
  const t = take.trim()
  const before = existing.slice(0, start)
  const after = existing.slice(end)
  const lead = t && before !== '' && !/\s$/.test(before) && needsSpace(before, t) ? ' ' : ''
  const trail = t && after !== '' && !/^\s/.test(after) && needsSpace(t, after) ? ' ' : ''
  return { start, before, after, lead, t, trail }
}

/** The exact string that replaces `sel` (or goes at the end): the trimmed take plus any space it needs on either side. Empty for an empty take. */
export function dictationInsertText(existing: string, take: string, sel: Selection | null): string {
  const { lead, t, trail } = parts(existing, take, sel)
  return t ? lead + t + trail : ''
}

/**
 * Insert at `sel` when given, else append. Adds one space between existing text and the take when neither side has
 * whitespace, except next to CJK text, before closing punctuation and after an opening bracket or quote.
 */
export function insertDictation(existing: string, take: string, sel: Selection | null): { text: string; cursor: number } {
  const { start, before, after, lead, t } = parts(existing, take, sel)
  if (!t) return { text: existing, cursor: start }
  const head = before + lead + t
  return { text: before + dictationInsertText(existing, take, sel) + after, cursor: head.length }
}
