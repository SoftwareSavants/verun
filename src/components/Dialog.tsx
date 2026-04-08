import { Component, JSX, Show, createEffect, onCleanup } from 'solid-js'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm?: () => void
  width?: string
  children: JSX.Element
}

export const Dialog: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
      if (e.key === 'Enter' && props.onConfirm) {
        e.preventDefault()
        props.onConfirm()
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
      >
        <div
          class="bg-surface-2 border border-border rounded-xl shadow-2xl p-5 animate-in"
          style={{ width: props.width || '20rem' }}
        >
          {props.children}
        </div>
      </div>
    </Show>
  )
}
