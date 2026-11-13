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

/** The offset into `serializeComposer(root)` of the DOM position (`node`, `offset`) inside `root`. */
export function composerOffset(root: Node, node: Node, offset: number): number {
  const doc = root.ownerDocument ?? document
  const pre = doc.createRange()
  pre.setStart(root, 0)
  pre.setEnd(node, offset)
  const tmp = doc.createElement('div')
  tmp.appendChild(pre.cloneContents())
  return serializeChildren(tmp).length
}

/** `range` as offsets into `serializeComposer(root)`. */
export function composerRangeOffsets(root: Node, range: Range): Selection {
  return { start: composerOffset(root, range.startContainer, range.startOffset), end: composerOffset(root, range.endContainer, range.endOffset) }
}

/** The document selection as offsets into `serializeComposer(root)`, or null when it is not inside `root`. */
export function composerSelection(root: HTMLElement): Selection | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  return composerRangeOffsets(root, range)
}

const isBlock = (node: Node | null): node is HTMLElement =>
  node instanceof HTMLElement && !node.dataset.mention && BLOCK_TAGS.has(node.tagName)

/**
 * A collapsed range at the end of what the composer shows: inside its deepest
 * last block (a line of its own), and before a trailing placeholder <br>, so
 * text put there joins the last line as typing at the end would.
 */
export function composerEndRange(root: HTMLElement): Range {
  let line: HTMLElement = root
  while (isBlock(line.lastChild)) line = line.lastChild
  const range = root.ownerDocument.createRange()
  const last = line.lastChild
  if (last instanceof HTMLElement && last.tagName === 'BR') {
    range.setStartBefore(last)
    range.collapse(true)
  } else {
    range.selectNodeContents(line)
    range.collapse(false)
  }
  return range
}

/** Moves each edge of `range` that is inside a `data-mention` badge in `root` to just after that badge. */
export function moveOutOfMentions(range: Range, root: HTMLElement): void {
  const badgeOf = (node: Node): HTMLElement | null => {
    for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
      if (n instanceof HTMLElement && n.dataset.mention) return n
    }
    return null
  }
  const startBadge = badgeOf(range.startContainer)
  const endBadge = badgeOf(range.endContainer)
  if (endBadge) range.setEndAfter(endBadge)
  if (startBadge) range.setStartAfter(startBadge)
}
