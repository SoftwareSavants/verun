import { describe, test, expect } from 'vitest'
import { collapseInPlace } from './collapseInPlace'

function setup(blockTop: number, headerStickyTop = 0) {
  const scroller = document.createElement('div')
  scroller.setAttribute('data-chat-scroll', '')
  const block = document.createElement('div')
  const header = document.createElement('div')
  header.style.top = `${headerStickyTop}px`
  block.appendChild(header)
  scroller.appendChild(block)
  document.body.appendChild(scroller)
  scroller.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
  block.getBoundingClientRect = () => ({ top: 100 + blockTop } as DOMRect)
  scroller.scrollTop = 1000
  // jsdom has no layout: let scrollTop be set freely.
  let st = 1000
  Object.defineProperty(scroller, 'scrollTop', { get: () => st, set: (v: number) => { st = v } })
  return { scroller, block, header }
}

describe('collapseInPlace', () => {
  test('a block whose header is pinned (top scrolled away) comes back with its header where it was', () => {
    const { scroller, block, header } = setup(-800)
    let collapsed = false
    collapseInPlace(block, header, () => { collapsed = true })
    expect(collapsed).toBe(true)
    expect(scroller.scrollTop).toBe(200)
  })

  test('a nested header pinned under its parent lands under the parent header', () => {
    const { scroller, block, header } = setup(-300, 40)
    collapseInPlace(block, header, () => {})
    expect(scroller.scrollTop).toBe(1000 - 300 - 40)
  })

  test('lands on the block even when collapsing near the end already clamped the scroll', () => {
    const { scroller, block, header } = setup(-200)
    collapseInPlace(block, header, () => { scroller.scrollTop = 700 })
    expect(scroller.scrollTop).toBe(800)
  })

  test('a block whose top is on screen collapses without scrolling', () => {
    const { scroller, block, header } = setup(250)
    collapseInPlace(block, header, () => {})
    expect(scroller.scrollTop).toBe(1000)
  })

  test('outside a chat scroller it just collapses', () => {
    const block = document.createElement('div')
    let collapsed = false
    collapseInPlace(block, undefined, () => { collapsed = true })
    expect(collapsed).toBe(true)
  })
})
