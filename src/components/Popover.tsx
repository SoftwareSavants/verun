import { Component, JSX, Show, createEffect, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { registerDismissable } from '../lib/dismissable'
import { clampToViewport } from '../lib/clampToViewport'

interface Props {
  open: boolean
  onClose: () => void
  pos?: { x: number; y: number }
  /** `above`: `pos.y` is the popover's bottom edge, for anchors near the window bottom. */
  placement?: 'below' | 'above'
  /** `end`: `pos.x` is the popover's right edge, for anchors near the right of a pane. */
  align?: 'start' | 'end'
  class?: string
  children: JSX.Element
}

export const Popover: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    const unregister = registerDismissable(() => props.onClose())
    onCleanup(unregister)
  })
  const content = () => (<>
      <div
        class="fixed inset-0 z-40"
        onMouseDown={(e) => e.preventDefault()}
        onClick={props.onClose}
        onContextMenu={(e) => { e.preventDefault(); props.onClose() }}
      />
      <div
        class={`${props.pos ? 'fixed' : ''} z-50 whitespace-normal bg-surface-2 ring-1 ring-outline/8 rounded-md shadow-xl animate-in ${props.class || ''}`}
        style={props.pos ? {
          ...(props.align === 'end' ? { right: `${window.innerWidth - props.pos.x}px` } : { left: `${props.pos.x}px` }),
          ...(props.placement === 'above' ? { bottom: `${window.innerHeight - props.pos.y}px` } : { top: `${props.pos.y}px` }),
        } : undefined}
        ref={(el) => {
          // Menus opened near an edge (e.g. from the sidebar footer) would
          // otherwise run off-screen: measure once rendered and pull them in.
          if (!props.pos) return
          requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect()
            const next = clampToViewport({ x: rect.left, y: rect.top }, rect, { width: window.innerWidth, height: window.innerHeight })
            el.style.left = `${next.x}px`
            el.style.right = 'auto'
            el.style.top = `${next.y}px`
            el.style.bottom = 'auto'
          })
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {props.children}
      </div>
    </>)
  // Anchored (`pos`): rendered at the top of the document. A pane that clips
  // (overflow, clip-path, like the chat pane) clips fixed children too, and
  // would cut off a menu opened near its edge.
  return (
    <Show when={props.open}>
      <Show when={props.pos} fallback={content()}>
        <Portal>{content()}</Portal>
      </Show>
    </Show>
  )
}
