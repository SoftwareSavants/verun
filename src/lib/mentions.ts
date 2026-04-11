export interface MentionSegment {
  type: 'text' | 'mention'
  value: string
}

const MENTION_RE = /@([^\s]+)/g

export function parseMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(MENTION_RE)) {
    const start = match.index!
    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) })
    }
    segments.push({ type: 'mention', value: match[1] })
    lastIndex = start + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return segments
}

export function extractMentionedFiles(text: string): string[] {
  const files: string[] = []
  for (const match of text.matchAll(MENTION_RE)) {
    const path = match[1]
    if (!files.includes(path)) files.push(path)
  }
  return files
}
