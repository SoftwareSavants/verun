import { Component, JSX, Show } from 'solid-js'

interface Props {
  open: boolean
  onClose: () => void
  pos?: { x: number; y: number }
  class?: string
  children: JSX.Element
}

export const Popover: Component<Props> = (props) => {
  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40"
        onClick={props.onClose}
        onContextMenu={(e) => { e.preventDefault(); props.onClose() }}
      />
      <div
        class={`${props.pos ? 'fixed' : ''} z-50 bg-surface-3 border border-border-active rounded-lg shadow-xl animate-in ${props.class || ''}`}
        style={props.pos ? { left: `${props.pos.x}px`, top: `${props.pos.y}px` } : undefined}
      >
        {props.children}
      </div>
    </Show>
  )
}
