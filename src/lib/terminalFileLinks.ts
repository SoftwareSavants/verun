import type { ILinkProvider, Terminal } from '@xterm/xterm'

export interface FileLink {
  path: string
  line: number
  column: number
  start: number
  end: number
}

/** Parse candidates synchronously; the provider validates them before exposing links. */
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
    // Bare domains are ambiguous with filenames. Prefer web addresses for
    // common host suffixes; explicit local paths still resolve as files.
    const host = path.split('/')[0]
    if (/^(?:[\w.+-]+@)?(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:com|org|net|edu|gov|io|ai|app|dev|co|me|cloud|tech|xyz|online|site|vercel|pages)$/i.test(host)) continue
    if (!path.includes('/') && !/^(?:Makefile|Dockerfile|README|LICENSE|\.[\w.-]+)$/.test(path) && !/^[\w@.+-]*[a-zA-Z_-][\w@.+-]*\.[a-zA-Z][\w-]*$/.test(path)) continue
    if (!path.includes('/') && /^v?\d+(\.\d+)+$/.test(path)) continue
    const line = Number(location?.[1] ?? location?.[3] ?? 1)
    const column = Number(location?.[2] ?? location?.[4] ?? 1)
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) continue
    links.push({ path, line, column, start: match.index! + leading, end: match.index! + leading + raw.length })
  }
  return links
}

export function createFileLinkProvider(term: Terminal, open: (link: FileLink) => void, validate?: (link: FileLink) => Promise<boolean>): ILinkProvider {
  return { provideLinks(y, callback) {
    const buffer = term.buffer.active
    let first = y - 1
    let last = first
    const rowText = (row: number) => {
      const line = buffer.getLine(row)
      let result = ''
      for (let x = 0; x < term.cols; x++) {
        const cell = line?.getCell(x)
        if (cell && cell.getWidth() !== 0) result += cell.getChars() || ' '
      }
      return result.trimEnd()
    }
    // Harnesses sometimes insert hard newlines with indentation inside long
    // paths. Join only an unfinished path and a single indented continuation,
    // never arbitrary adjacent output or a second absolute/relative path.
    const joins = (row: number, depth = 0): boolean => {
      if (row <= 0 || row >= buffer.length) return false
      if (buffer.getLine(row)?.isWrapped) return true
      const previous = rowText(row - 1)
      const next = rowText(row)
      let unfinished = /(?:^|\s)((?:\/|~\/|\.\.?\/)[^\s"'`]+)$/.exec(previous)?.[1]
      if (!unfinished && depth < 99 && joins(row - 1, depth + 1)) unfinished = previous.trim()
      if (!unfinished || !/^\s{2,}[^\s/][^\s]*$/.test(next) || /^\s+\.\.?\//.test(next)) return false
      return /[-/]$/.test(unfinished) && (next.trim().includes('/') || findFileLinks(next.trim()).length > 0)
    }
    // Bound work for pathological wrapped output.
    while (first > 0 && joins(first) && y - first < 100) first--
    while (last + 1 < buffer.length && joins(last + 1) && last - first < 100) last++
    let text = ''
    const starts: { x: number; y: number }[] = []
    const ends: { x: number; y: number }[] = []
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(row)
      if (!line) continue
      const trimIndent = row > first && !line.isWrapped
      const content = rowText(row)
      const from = trimIndent ? content.length - content.trimStart().length : 0
      // Trim terminal padding only at a hard line break; preserve actual
      // spaces across soft wraps so unrelated tokens never merge.
      let to = term.cols
      if (row === last || !buffer.getLine(row + 1)?.isWrapped) {
        while (to > 0 && !(line.getCell(to - 1)?.getChars() ?? '').trim() && line.getCell(to - 1)?.getWidth() !== 0) to--
      }
      for (let x = from; x < Math.min(term.cols, to); x++) {
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
    const candidates = findFileLinks(text).filter(link => starts[link.start].y <= y && ends[link.end - 1].y >= y)
    const publish = (links: FileLink[]) => callback(links.map(link => ({
      text: text.slice(link.start, link.end),
      range: { start: starts[link.start], end: ends[link.end - 1] },
      decorations: { pointerCursor: true, underline: true },
      activate: () => open(link),
    })))
    if (!validate) { publish(candidates); return }
    // Validation uses Rust IPC, never browser filesystem access. Missing files
    // and prose that resembles paths are simply not links. No negative cache:
    // newly created files should become clickable on the next hover.
    void Promise.all(candidates.map(async link => {
      try { return await validate(link) } catch { return false }
    })).then(valid => publish(candidates.filter((_, index) => valid[index])))
  } }
}
