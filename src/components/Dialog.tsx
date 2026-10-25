import { Component, JSX, Show, createEffect, onCleanup } from 'solid-js'

/**
 * Enter on a focused button presses that button, so the dialog's own Enter is
 * not for it. The one exception is the button that confirms, which DialogFooter
 * marks with `data-dialog-confirm`.
 */
const onOtherButton = (target: EventTarget | null) =>
  target instanceof Element && target.closest('button:not([data-dialog-confirm])') !== null

interface Props {
  open: boolean
  onClose: () => void
  onConfirm?: () => void
  width?: string
  /** Appended to the content container. When omitted, default `p-5` is applied; include your own `p-*` when passing a class. */
  class?: string
  children: JSX.Element
}

export const Dialog: Component<Props> = (props) => {
  let mouseDownOnBackdrop = false

  createEffect(() => {
    if (!props.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
      if (e.key === 'Enter' && props.onConfirm) {
        // Native selects use Enter to commit their choice, not the dialog.
        if (e.target instanceof HTMLSelectElement) return
        // So do buttons: a Cancel the user tabbed to must not read as "confirm".
        if (onOtherButton(e.target)) return
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
        onMouseDown={(e) => { mouseDownOnBackdrop = e.target === e.currentTarget }}
        onClick={(e) => {
          if (e.target === e.currentTarget && mouseDownOnBackdrop) props.onClose()
          mouseDownOnBackdrop = false
        }}
      >
        <div
          class={`bg-surface-2 border border-border rounded-xl shadow-2xl animate-in overflow-y-auto ${props.class ?? 'p-5'}`}
          style={{ width: props.width || '20rem', 'max-height': 'calc(100vh - 6rem)' }}
        >
          {props.children}
        </div>
      </div>
    </Show>
  )
}
