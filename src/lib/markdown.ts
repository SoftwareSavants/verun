import { marked } from 'marked'
import { convertFileSrc } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openFile, setPendingGoToLine } from '../store/editorView'
import { modPressed, isMac } from './platform'

const modSymbol = isMac ? '⌘' : 'Ctrl'
import { tasks } from '../store/tasks'
import { resolveWorktreeFilePath } from './ipc'

marked.setOptions({ breaks: true, gfm: true })

const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|swift|c|cpp|h|hpp|cs|css|scss|less|html|htm|vue|svelte|astro|json|jsonc|yaml|yml|toml|xml|sql|sh|bash|zsh|md|mdx|txt|cfg|conf|ini|env|makefile|proto|graphql|gql|lock)$/i

function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (t.includes(' ') || t.includes('\n')) return false
  const withoutLineNum = t.replace(/(?::\d+){1,2}$/, "")
  return FILE_EXT_RE.test(withoutLineNum)
}

function resolveLocalImages(doc: Document, worktreePath: string, fileDir?: string) {
  doc.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('blob:')) return
    let absPath: string
    if (src.startsWith('/')) {
      absPath = src
    } else if (fileDir) {
      absPath = `${worktreePath}/${fileDir}/${src}`
    } else {
      absPath = `${worktreePath}/${src}`
    }
    img.src = convertFileSrc(absPath)
  })
}

/** "src/a.ts:12:3" → path and position. */
function splitLocation(text: string): { path: string; line?: number; column?: number } {
  const m = text.trim().match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/)!
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined }
}

function linkifyFilePaths(doc: Document) {
  doc.querySelectorAll('code').forEach(code => {
    if (code.closest('pre') || code.closest('a')) return
    const text = code.textContent
    if (!text || !looksLikeFilePath(text)) return
    const { path, line, column } = splitLocation(text)
    const link = doc.createElement('a')
    link.setAttribute('href', path)
    link.setAttribute('data-file-link', '')
    if (line) link.setAttribute('data-line', String(line))
    if (column) link.setAttribute('data-column', String(column))
    code.parentNode!.replaceChild(link, code)
    link.appendChild(code)
  })
}

/** Code blocks get a slim header: their language and a copy button. */
function decorateCodeBlocks(doc: Document) {
  doc.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement?.hasAttribute('data-code-block')) return
    const lang = pre.querySelector('code')?.className.match(/language-([\w+#-]+)/)?.[1]
    const wrap = doc.createElement('div')
    wrap.setAttribute('data-code-block', '')
    const head = doc.createElement('div')
    head.setAttribute('data-code-head', '')
    if (lang) {
      const label = doc.createElement('span')
      label.setAttribute('data-code-lang', '')
      label.textContent = lang
      head.appendChild(label)
    }
    const copy = doc.createElement('button')
    copy.setAttribute('type', 'button')
    copy.setAttribute('data-copy-code', '')
    copy.setAttribute('aria-label', 'Copy code')
    copy.textContent = 'Copy'
    head.appendChild(copy)
    pre.parentNode!.replaceChild(wrap, pre)
    wrap.append(head, pre)
  })
}

/** Every link says how to open it: links open on Cmd/Ctrl-click only. */
function titleLinks(doc: Document) {
  doc.querySelectorAll('a[href]').forEach(a => {
    if (a.hasAttribute('title')) return
    const href = a.getAttribute('href')!
    a.setAttribute('title', isFileLinkHref(href)
      ? `${modSymbol}-click to open ${a.getAttribute('href')}${a.getAttribute('data-line') ? `:${a.getAttribute('data-line')}` : ''}`
      : `${modSymbol}-click to open ${href}`)
  })
}

export function getWorktreePath(taskId?: string): string | undefined {
  if (!taskId) return undefined
  return tasks.find(t => t.id === taskId)?.worktreePath || undefined
}

export interface RenderOptions {
  worktreePath?: string
  fileDir?: string
}

// Rendered HTML by (worktree, dir, text). Finished chat messages re-render
// whenever their view does - the cache makes that a lookup instead of a
// marked + DOMParser pass. Bounded LRU; Map keeps insertion order.
const RENDER_CACHE_MAX = 500
const renderCache = new Map<string, string>()

export function renderMarkdown(text: string, opts?: string | RenderOptions): string {
  const options: RenderOptions = typeof opts === 'string' ? { worktreePath: opts } : (opts ?? {})
  const key = `${options.worktreePath ?? ''}\0${options.fileDir ?? ''}\0${text}`
  const hit = renderCache.get(key)
  if (hit !== undefined) {
    renderCache.delete(key)
    renderCache.set(key, hit)
    return hit
  }
  const html = renderMarkdownUncached(text, options)
  renderCache.set(key, html)
  if (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value!)
  return html
}

function renderMarkdownUncached(text: string, options: RenderOptions): string {
  const raw = marked.parse(text, { async: false }) as string

  const parser = new DOMParser()
  const doc = parser.parseFromString(raw, 'text/html')

  if (options.worktreePath) {
    resolveLocalImages(doc, options.worktreePath, options.fileDir)
  }
  linkifyFilePaths(doc)
  titleLinks(doc)
  decorateCodeBlocks(doc)

  return doc.body.innerHTML
}

function isFileLinkHref(href: string): boolean {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.startsWith('mailto:')) return false
  return true
}

/**
 * Clicks in rendered markdown. A code block's copy button copies its code.
 * Links open on Cmd/Ctrl-click, like in an editor or a
 * terminal: a plain click stays free for selecting and copying text. URLs open
 * in the browser, file paths in the editor at their line.
 */
export function handleMarkdownLinkClick(e: MouseEvent, taskId?: string) {
  const copy = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy-code]')
  if (copy) {
    const code = copy.closest('[data-code-block]')?.querySelector('pre')?.textContent ?? ''
    void navigator.clipboard.writeText(code).then(() => {
      copy.textContent = 'Copied'
      setTimeout(() => { copy.textContent = 'Copy' }, 1500)
    })
    return
  }
  const anchor = (e.target as HTMLElement).closest('a')
  if (!anchor) return

  // Never navigate the webview.
  e.preventDefault()
  if (!modPressed(e)) return

  const rawHref = anchor.getAttribute('href')
  if (!rawHref) return

  if (!isFileLinkHref(rawHref) || !taskId) {
    openUrl(anchor.href)
    return
  }

  const filePath = rawHref.replace(/^\.\//, '')
  const line = Number(anchor.getAttribute('data-line')) || undefined
  const column = Number(anchor.getAttribute('data-column')) || 1
  resolveWorktreeFilePath(taskId, filePath)
    .then(() => {
      const name = filePath.split('/').pop() || filePath
      openFile(taskId, filePath, name)
      if (line) setPendingGoToLine({ taskId, relativePath: filePath, line, column })
    })
    .catch(() => {})
}
