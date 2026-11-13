import { describe, test, expect, beforeEach } from 'vitest'
import { serializeComposer, composerSelection } from './composerText'

const ZWS = '​'

/** A composer as MessageInput builds it: text, then badges padded by zero-width spaces. */
function composer(...parts: Array<string | { mention: string }>): HTMLDivElement {
  const root = document.createElement('div')
  for (const p of parts) {
    if (typeof p === 'string') { root.appendChild(document.createTextNode(p)); continue }
    root.appendChild(document.createTextNode(ZWS))
    const badge = document.createElement('span')
    badge.dataset.mention = p.mention
    badge.contentEditable = 'false'
    badge.textContent = p.mention.split('/').pop()!
    root.appendChild(badge)
    root.appendChild(document.createTextNode(ZWS))
  }
  document.body.appendChild(root)
  return root
}

function select(startNode: Node, startOffset: number, endNode = startNode, endOffset = startOffset) {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('serializeComposer', () => {
  test('text and badges become plain text with @mentions; zero-width spaces are dropped', () => {
    const root = composer('look at ', { mention: 'src/a.ts' }, ' and ', { mention: 'my dir/b.ts' })
    expect(serializeComposer(root)).toBe('look at @src/a.ts and @"my dir/b.ts"')
  })

  test('line breaks and block elements become newlines; a lone trailing break is empty', () => {
    const root = document.createElement('div')
    root.innerHTML = 'one<br>two<div>three</div>'
    expect(serializeComposer(root)).toBe('one\ntwo\nthree')
    root.innerHTML = '<br>'
    expect(serializeComposer(root)).toBe('')
  })
})

describe('composerSelection', () => {
  test('a caret after a badge is counted in serialized text', () => {
    const root = composer('a ', { mention: 'x.ts' }, ' bc')
    const last = root.lastChild!
    select(last, 2) // 'a ' + ZWS + badge + ZWS + ' b|c'
    expect(composerSelection(root)).toEqual({ start: 'a @x.ts b'.length, end: 'a @x.ts b'.length })
  })

  test('a range gives both ends', () => {
    const root = composer('hello world')
    select(root.firstChild!, 6, root.firstChild!, 11)
    expect(composerSelection(root)).toEqual({ start: 6, end: 11 })
  })

  test('null when the selection is outside the composer or there is none', () => {
    const root = composer('hello')
    expect(composerSelection(root)).toBeNull()
    const other = composer('elsewhere')
    select(other.firstChild!, 2)
    expect(composerSelection(root)).toBeNull()
  })
})
