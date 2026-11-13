import { formatMention } from './mentions'
import type { Selection } from './dictationInsert'

// The chat composer is a contenteditable of text nodes and `data-mention` badge
// spans padded by zero-width spaces. These map it to and from its plain text
// (badges as @path tokens), the form drafts and sends use.

const ZWS = /​/g
const BLOCK_TAGS = new Set(['DIV', 'P', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function serializeChildren(root: Node): string {
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? '').replace(ZWS, '')
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mention) {
        text += formatMention(node.dataset.mention)
      } else if (node.tagName === 'BR') {
        text += '\n'
      } else {
        // Block elements (div, p) represent line breaks in contenteditable
        if (BLOCK_TAGS.has(node.tagName) && text.length > 0 && !text.endsWith('\n')) text += '\n'
        for (const child of node.childNodes) walk(child)
      }
    }
  }
  for (const child of root.childNodes) walk(child)
  return text
}

/** The composer's plain text. */
export function serializeComposer(root: Node): string {
  const text = serializeChildren(root)
  // Browser may leave a trailing <br> -> lone '\n'; treat as empty
  return text === '\n' ? '' : text
}

/** The document selection as offsets into `serializeComposer(root)`, or null when it is not inside `root`. */
export function composerSelection(root: HTMLElement): Selection | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const offsetOf = (node: Node, offset: number) => {
    const pre = root.ownerDocument.createRange()
    pre.setStart(root, 0)
    pre.setEnd(node, offset)
    const tmp = root.ownerDocument.createElement('div')
    tmp.appendChild(pre.cloneContents())
    return serializeChildren(tmp).length
  }
  return { start: offsetOf(range.startContainer, range.startOffset), end: offsetOf(range.endContainer, range.endOffset) }
}
