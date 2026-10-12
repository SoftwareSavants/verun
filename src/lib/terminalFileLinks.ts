import type { ILinkProvider, Terminal } from '@xterm/xterm'

export interface FileLink {
  path: string
  line: number
  column: number
  start: number
  end: number
}

/** Keep recognition synchronous; Rust resolves and validates only on activation. */
export function findFileLinks(text: string): FileLink[] {
  const links: FileLink[] = []
  const tokens = /"[^"\r\n]+"(?::\d+(?::\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+)?)?|[^\s<>"'`]+/g
  for (const match of text.matchAll(tokens)) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(match[0])) continue
    const leading = match[0].match(/^[([]+/)?.[0].length ?? 0
    let raw = match[0].slice(leading).replace(/[,;.:\]]+$/, '')
    if (!/\(\d+,\d+\)$/.test(raw)) raw = raw.replace(/\)+$/, '')
    const location = raw.match(/(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))$/)
    const path = (location ? raw.slice(0, location.index) : raw).replace(/^["']|["']$/g, '')
    if (!path || path.includes('://') || path.includes(':')) continue
    if (!path.includes('/') && !/^(?:Makefile|Dockerfile|README|LICENSE|\.[\w.-]+)$/.test(path) && !/^[\w@.+-]*[a-zA-Z_-][\w@.+-]*\.[a-zA-Z][\w-]*$/.test(path)) continue
    if (!path.includes('/') && /^v?\d+(\.\d+)+$/.test(path)) continue
    const line = Number(location?.[1] ?? location?.[3] ?? 1)
    const column = Number(location?.[2] ?? location?.[4] ?? 1)
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) continue
    links.push({ path, line, column, start: match.index! + leading, end: match.index! + leading + raw.length })
  }
  return links
}

export function createFileLinkProvider(term: Terminal, open: (link: FileLink) => void): ILinkProvider {
  return { provideLinks(y, callback) {
    const buffer = term.buffer.active
    let first = y - 1
    let last = first
    // Bound work for pathological wrapped output.
    while (first > 0 && buffer.getLine(first)?.isWrapped && y - first < 100) first--
    while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped && last - first < 100) last++
    let text = ''
    const starts: { x: number; y: number }[] = []
    const ends: { x: number; y: number }[] = []
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(row)
      if (!line) continue
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x)
        if (!cell || cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        text += chars
        for (let i = 0; i < chars.length; i++) {
          starts.push({ x: x + 1, y: row + 1 })
          ends.push({ x: x + cell.getWidth(), y: row + 1 })
        }
      }
    }
    callback(findFileLinks(text).filter(link => starts[link.start].y <= y && ends[link.end - 1].y >= y).map(link => ({
      text: text.slice(link.start, link.end),
      range: { start: starts[link.start], end: ends[link.end - 1] },
      decorations: { pointerCursor: true, underline: true },
      activate: () => open(link),
    })))
  } }
}
