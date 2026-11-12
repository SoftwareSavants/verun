import type { OutputItem } from '../types'

/**
 * Claude ran out of usage on its account: the CLI reports it as a synthetic
 * assistant message tagged `"error":"rate_limit"` ("You've hit your weekly
 * limit · resets ..."). The text is the fallback when the raw line is gone.
 */
export function isUsageLimit(message: string, raw?: string): boolean {
  if (raw) {
    try {
      if ((JSON.parse(raw) as { error?: unknown }).error === 'rate_limit') return true
    } catch { /* not JSON: fall back to the text */ }
  }
  return /\byou've hit your (\w+ )?limit\b/i.test(message)
}

/** The usage-limit error a session is stuck on, until the user sends something again. */
export function pendingUsageLimit(items: readonly OutputItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'userMessage' || item.kind === 'transcriptUserMessage') return null
    if (item.kind === 'errorMessage') return isUsageLimit(item.message, item.raw) ? item.message : null
  }
  return null
}
