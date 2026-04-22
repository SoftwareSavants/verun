import { describe, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { groupReferencesByFile, stripCommonPrefix } = await import('./CodeEditor')

// Pure helpers for the inline find-references peek. Keep them exported so we
// can regression-test grouping + file-label shortening without spinning up a
// full EditorView + LSP client.
describe('stripCommonPrefix', () => {
  test('trims everything up to the last common `/`', () => {
    const n = stripCommonPrefix([
      'file:///work/src/a/one.ts',
      'file:///work/src/a/two.ts',
      'file:///work/src/b/three.ts',
    ])
    // common prefix is `file:///work/src/` (17 chars)
    expect(n).toBe('file:///work/src/'.length)
  })

  test('no prefix trimming when paths diverge at root', () => {
    expect(stripCommonPrefix(['file:///a.ts', 'file:///b.ts'])).toBe('file:///'.length)
  })

  test('empty list', () => {
    expect(stripCommonPrefix([])).toBe(0)
  })
})

describe('groupReferencesByFile', () => {
  test('groups entries by fileUri preserving order', () => {
    const groups = groupReferencesByFile([
      { fileUri: 'u1', fileName: 'a.ts', relativePath: 'a.ts', line: 1, lineText: '', matchStart: 0, matchEnd: 1, rangeStart: { line: 0, character: 0 } },
      { fileUri: 'u2', fileName: 'b.ts', relativePath: 'b.ts', line: 4, lineText: '', matchStart: 0, matchEnd: 1, rangeStart: { line: 3, character: 0 } },
      { fileUri: 'u1', fileName: 'a.ts', relativePath: 'a.ts', line: 9, lineText: '', matchStart: 0, matchEnd: 1, rangeStart: { line: 8, character: 0 } },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].fileUri).toBe('u1')
    expect(groups[0].entries).toHaveLength(2)
    expect(groups[1].fileUri).toBe('u2')
    expect(groups[1].entries).toHaveLength(1)
  })

  test('empty input returns empty array', () => {
    expect(groupReferencesByFile([])).toEqual([])
  })
})
