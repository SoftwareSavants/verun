import { describe, test, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => `asset://${p}` }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn() }))
vi.mock('./ipc', () => ({ resolveWorktreeFilePath: vi.fn() }))

import { marked } from 'marked'
import { renderMarkdown } from './markdown'

describe('renderMarkdown cache', () => {
  test('rendering the same text for the same worktree parses it once', () => {
    const parse = vi.spyOn(marked, 'parse')
    const text = 'Some **bold** text with `src/a.ts` and ![x](img.png) - cache-1'
    const first = renderMarkdown(text, '/wt')
    const second = renderMarkdown(text, '/wt')
    expect(second).toBe(first)
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
  })

  test('a different worktree renders separately', () => {
    const text = '![x](img.png) - cache-2'
    expect(renderMarkdown(text, '/a')).toContain('asset:///a/img.png')
    expect(renderMarkdown(text, '/b')).toContain('asset:///b/img.png')
    expect(renderMarkdown(text, { worktreePath: '/b', fileDir: 'docs' })).toContain('asset:///b/docs/img.png')
  })
})
