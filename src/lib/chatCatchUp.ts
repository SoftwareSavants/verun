// Catching up on a chat session: where the turns are, and which ones
// finished since you last looked.

export interface TurnStart {
  /** Index of the turn's first block (the prompt). */
  index: number
  text: string
  /** When the prompt was sent. */
  at?: number
  /** When the turn finished; unset while it runs. */
  endedAt?: number
  failed?: boolean
}

type BlockLike =
  | { type: 'user'; text: string; at?: number; endedAt?: number; failed?: boolean }
  | { type: 'wakeup'; prompt: string; at?: number; endedAt?: number; failed?: boolean }
  | { type: string }

export function turnOutline(blocks: readonly BlockLike[]): TurnStart[] {
  const out: TurnStart[] = []
  blocks.forEach((b, index) => {
    const failed = 'failed' in b && b.failed ? { failed: true } : {}
    if (b.type === 'user' && 'text' in b) out.push({ index, text: b.text, at: b.at, endedAt: b.endedAt, ...failed })
    else if (b.type === 'wakeup' && 'prompt' in b) out.push({ index, text: b.prompt, at: b.at, endedAt: b.endedAt, ...failed })
  })
  return out
}

export interface UnseenAnchor {
  /** Block index the "new" divider goes before. */
  index: number
  /** Finished turns since the last look. */
  turns: number
  since: number
}

/**
 * The first turn that finished after `seenAt`. A prompt sent before the last
 * look was already seen, so the divider then sits after it. A turn still
 * running is not news by itself: its live status already says so.
 */
export function unseenAnchor(turns: readonly TurnStart[], seenAt: number | undefined, blockCount: number): UnseenAnchor | null {
  if (seenAt === undefined) return null
  const fresh = turns.filter(t => t.endedAt !== undefined && t.endedAt > seenAt)
  if (fresh.length === 0) return null
  const first = fresh[0]
  const index = first.at !== undefined && first.at <= seenAt ? first.index + 1 : first.index
  if (index >= blockCount) return null
  return { index, turns: fresh.length, since: seenAt }
}

const KEY = 'verun:chatSeen'
const MAX_ENTRIES = 500

function read(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function loadSeen(sessionId: string): number | undefined {
  const v = read()[sessionId]
  return typeof v === 'number' ? v : undefined
}

/** Records that everything up to `at` in this session has been on screen. */
export function markSeen(sessionId: string, at: number) {
  const all = read()
  if ((all[sessionId] ?? 0) >= at) return
  delete all[sessionId]
  all[sessionId] = at
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k]
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* storage full or blocked */ }
}
