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
