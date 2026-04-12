import { Component, JSX, Show, createEffect, onCleanup } from 'solid-js'
import { registerDismissable } from '../lib/dismissable'

interface Props {
  open: boolean
  onClose: () => void
  pos?: { x: number; y: number }
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
        class={`${props.pos ? 'fixed' : ''} z-50 bg-surface-2 ring-1 ring-white/8 rounded-md shadow-xl animate-in ${props.class || ''}`}
        style={props.pos ? { left: `${props.pos.x}px`, top: `${props.pos.y}px` } : undefined}
        onMouseDown={(e) => e.preventDefault()}
      >
        {props.children}
      </div>
    </Show>
  )
}
