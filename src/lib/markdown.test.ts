import { describe, test, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p: string) => `asset://${p}` }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn(), setPendingGoToLine: vi.fn() }))
vi.mock('./ipc', () => ({ resolveWorktreeFilePath: vi.fn(() => Promise.resolve('/wt/src/a.ts')) }))

import { marked } from 'marked'
import { renderMarkdown, handleMarkdownLinkClick } from './markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openFile, setPendingGoToLine } from '../store/editorView'

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

describe('links in rendered markdown', () => {
  const host = (html: string) => {
    const div = document.createElement('div')
    div.innerHTML = html
    document.body.appendChild(div)
    return div
  }
  const click = (el: Element, mod: boolean) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: mod, ctrlKey: mod })
    Object.defineProperty(e, 'target', { value: el })
    handleMarkdownLinkClick(e, 'task-1')
    return e
  }

  test('a file path keeps its line and column and says how to open it', () => {
    const div = host(renderMarkdown('See `src/a.ts:12:3` now'))
    const a = div.querySelector('a[data-file-link]')!
    expect(a.getAttribute('href')).toBe('src/a.ts')
    expect(a.getAttribute('data-line')).toBe('12')
    expect(a.getAttribute('data-column')).toBe('3')
    expect(a.getAttribute('title')).toMatch(/click to open/)
  })

  test('a plain click opens nothing and does not navigate', () => {
    vi.mocked(openUrl).mockClear(); vi.mocked(openFile).mockClear()
    const div = host(renderMarkdown('[docs](https://example.com) and `src/a.ts:12`'))
    for (const a of div.querySelectorAll('a')) expect(click(a, false).defaultPrevented).toBe(true)
    expect(openUrl).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })

  test('Cmd/Ctrl-click opens a URL in the browser and a path in the editor at its line', async () => {
    const div = host(renderMarkdown('[docs](https://example.com) and `src/a.ts:12:3`'))
    click(div.querySelector('a[href^="https"]')!, true)
    expect(openUrl).toHaveBeenCalledWith('https://example.com/')
    click(div.querySelector('a[data-file-link]')!, true)
    await new Promise(r => setTimeout(r, 0))
    expect(openFile).toHaveBeenCalledWith('task-1', 'src/a.ts', 'a.ts')
    expect(setPendingGoToLine).toHaveBeenCalledWith({ taskId: 'task-1', relativePath: 'src/a.ts', line: 12, column: 3 })
  })
})

describe('code blocks', () => {
  test('get a header with their language and a copy button that copies the code only', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('```ts\nconst a = 1\n```')
    document.body.appendChild(div)
    expect(div.querySelector('[data-code-lang]')?.textContent).toBe('ts')
    const button = div.querySelector('button[data-copy-code]')!
    expect(button.getAttribute('aria-label')).toBe('Copy code')
    const e = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'target', { value: button })
    handleMarkdownLinkClick(e)
    expect(writeText).toHaveBeenCalledWith('const a = 1\n')
    await Promise.resolve()
    expect(button.textContent).toBe('Copied')
  })

  test('a block without a language still gets a copy button', () => {
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('```\nplain\n```')
    expect(div.querySelector('button[data-copy-code]')).not.toBeNull()
    expect(div.querySelector('[data-code-lang]')).toBeNull()
  })
})
