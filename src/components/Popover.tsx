import { Component, JSX, Show, createEffect, onCleanup } from 'solid-js'
import { registerDismissable } from '../lib/dismissable'
import { clampToViewport } from '../lib/clampToViewport'

interface Props {
  open: boolean
  onClose: () => void
  pos?: { x: number; y: number }
  /** `above`: `pos.y` is the popover's bottom edge, for anchors near the window bottom. */
  placement?: 'below' | 'above'
  class?: string
  children: JSX.Element
}

export const Popover: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    const unregister = registerDismissable(() => props.onClose())
    onCleanup(unregister)
  })
  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40"
        onMouseDown={(e) => e.preventDefault()}
        onClick={props.onClose}
        onContextMenu={(e) => { e.preventDefault(); props.onClose() }}
      />
      <div
        class={`${props.pos ? 'fixed' : ''} z-50 bg-surface-2 ring-1 ring-outline/8 rounded-md shadow-xl animate-in ${props.class || ''}`}
        style={props.pos ? (props.placement === 'above'
          ? { left: `${props.pos.x}px`, bottom: `${window.innerHeight - props.pos.y}px` }
          : { left: `${props.pos.x}px`, top: `${props.pos.y}px` }) : undefined}
        ref={(el) => {
          // Menus opened near an edge (e.g. from the sidebar footer) would
          // otherwise run off-screen: measure once rendered and pull them in.
          if (!props.pos) return
          requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect()
            const next = clampToViewport({ x: rect.left, y: rect.top }, rect, { width: window.innerWidth, height: window.innerHeight })
            el.style.left = `${next.x}px`
            el.style.top = `${next.y}px`
            el.style.bottom = 'auto'
          })
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {props.children}
      </div>
    </Show>
  )
}
