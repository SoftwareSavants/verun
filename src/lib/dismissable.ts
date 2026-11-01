import { createEffect, onCleanup } from 'solid-js'

const stack: Array<() => void> = []
let installed = false

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || stack.length === 0) return
  e.stopPropagation()
  e.preventDefault()
  const close = stack.pop()!
  close()
}

export function registerDismissable(close: () => void): () => void {
  if (!installed) {
    window.addEventListener('keydown', onKey, true)
    installed = true
  }
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i >= 0) stack.splice(i, 1)
  }
}

/**
 * Makes Escape close an overlay while it is open, ahead of whatever else listens
 * for Escape behind it (Settings and the other pages close on it). Overlays
 * stack: the one opened last closes first.
 */
export function useDismissable(isOpen: () => boolean, close: () => void): void {
  createEffect(() => {
    if (isOpen()) onCleanup(registerDismissable(close))
  })
}
