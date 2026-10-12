import { describe, expect, test, vi } from 'vitest'
import { findFileLinks, createFileLinkProvider } from './terminalFileLinks'
import type { Terminal, ILink } from '@xterm/xterm'

describe('terminal file links', () => {
  test('recognizes paths, compiler locations, and quoted spaces without including punctuation', () => {
    const text = 'at (src/app.ts:12:4), /tmp/main.rs:9 ./README.md "src/my file.ts":3:2 foo.ts(8,6)'
    expect(findFileLinks(text).map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: 'src/app.ts', line: 12, column: 4 },
      { path: '/tmp/main.rs', line: 9, column: 1 },
      { path: './README.md', line: 1, column: 1 },
      { path: 'src/my file.ts', line: 3, column: 2 },
      { path: 'foo.ts', line: 8, column: 6 },
    ])
  })
  test('recognizes diagnostics with trailing punctuation and extensionless project files', () => {
    expect(findFileLinks('src/main.ts:8:2: error foo.ts(4,2), Makefile .env').map(x => [x.path, x.line, x.column])).toEqual([
      ['src/main.ts', 8, 2], ['foo.ts', 4, 2], ['Makefile', 1, 1], ['.env', 1, 1],
    ])
  })
  test('ignores URLs, ordinary words, and version numbers', () => {
    expect(findFileLinks('https://example.com/src/a.ts localhost:1420 v1.2.3 1.2.3 hello')).toEqual([])
  })
  test('maps wrapped lines and wide characters to terminal cells', () => {
    const rows = [
      { isWrapped: false, cells: ['界', '', ' ', 's', 'r', 'c', '/', 'a'] },
      { isWrapped: true, cells: ['.', 't', 's', ':', '2', ':', '3', ' '] },
    ]
    const term = { cols: 8, buffer: { active: { length: 2, getLine: (i: number) => {
      const row = rows[i]
      return row && { isWrapped: row.isWrapped, length: 8, getCell: (x: number) => ({ getChars: () => row.cells[x], getWidth: () => row.cells[x] === '' ? 0 : row.cells[x] === '界' ? 2 : 1 }) }
    } } } } as unknown as Terminal
    const open = vi.fn()
    let links: ILink[] | undefined
    createFileLinkProvider(term, open).provideLinks(2, value => { links = value })
    expect(links).toHaveLength(1)
    expect(links![0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 7, y: 2 } })
    links![0].activate(new MouseEvent('click'), links![0].text)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/a.ts', line: 2, column: 3 }))
  })
})
