/**
 * Collapse an expanded transcript block without losing your place.
 *
 * An expanded block's header stays pinned to the top of the chat while you
 * scroll through its body (`position: sticky`). Collapsing it there would
 * leave you far below it, somewhere in the following messages. Instead the
 * collapsed block comes back to where its header was pinned. A block whose
 * top is still on screen collapses without scrolling.
 */
export function collapseInPlace(block: HTMLElement | undefined, header: HTMLElement | undefined, collapse: () => void) {
  const scroller = block?.closest<HTMLElement>('[data-chat-scroll]')
  if (!block || !header || !scroller) {
    collapse()
    return
  }
  // Where the header rests when pinned: 0, or just under a parent's pinned header.
  const pinnedAt = parseFloat(getComputedStyle(header).top) || 0
  const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const from = scroller.scrollTop
  collapse()
  // Content above the block is unchanged, so its offset still holds. Set an
  // absolute target: collapsing near the end may already have clamped scrollTop.
  if (top < pinnedAt) scroller.scrollTop = from + top - pinnedAt
}
