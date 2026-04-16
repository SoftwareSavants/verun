import { marked } from 'marked'
import { convertFileSrc } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openFile } from '../store/editorView'
import { tasks } from '../store/tasks'
import { resolveWorktreeFilePath } from './ipc'

marked.setOptions({ breaks: true, gfm: true })

const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|swift|c|cpp|h|hpp|cs|css|scss|less|html|htm|vue|svelte|astro|json|jsonc|yaml|yml|toml|xml|sql|sh|bash|zsh|md|mdx|txt|cfg|conf|ini|env|makefile|proto|graphql|gql|lock)$/i

function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (t.includes(' ') || t.includes('\n')) return false
  const withoutLineNum = t.replace(/:\d+$/, '')
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

function linkifyFilePaths(doc: Document) {
  doc.querySelectorAll('code').forEach(code => {
    if (code.closest('pre') || code.closest('a')) return
    const text = code.textContent
    if (!text || !looksLikeFilePath(text)) return
    const link = doc.createElement('a')
    link.setAttribute('href', text.trim().replace(/:\d+$/, ''))
    link.setAttribute('data-file-link', '')
    code.parentNode!.replaceChild(link, code)
    link.appendChild(code)
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

export function renderMarkdown(text: string, opts?: string | RenderOptions): string {
  const options: RenderOptions = typeof opts === 'string' ? { worktreePath: opts } : (opts ?? {})
  const raw = marked.parse(text, { async: false }) as string

  const parser = new DOMParser()
  const doc = parser.parseFromString(raw, 'text/html')

  if (options.worktreePath) {
    resolveLocalImages(doc, options.worktreePath, options.fileDir)
  }
  linkifyFilePaths(doc)

  return doc.body.innerHTML
}

function isFileLinkHref(href: string): boolean {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.startsWith('mailto:')) return false
  return true
}

export function handleMarkdownLinkClick(e: MouseEvent, taskId?: string) {
  const anchor = (e.target as HTMLElement).closest('a')
  if (!anchor) return

  e.preventDefault()

  const rawHref = anchor.getAttribute('href')
  if (!rawHref) return

  if (!isFileLinkHref(rawHref)) {
    openUrl(anchor.href)
    return
  }

  if (taskId) {
    const filePath = rawHref.replace(/^\.\//, '')
    resolveWorktreeFilePath(taskId, filePath)
      .then(() => {
        const name = filePath.split('/').pop() || filePath
        openFile(taskId, filePath, name)
      })
      .catch(() => {})
    return
  }

  openUrl(anchor.href)
}
