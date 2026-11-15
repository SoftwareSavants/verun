import { createSignal, type Accessor } from 'solid-js'

/**
 * Dragging files from inside Verun (the file tree) to a drop target (the chat).
 *
 * Not HTML5 drag and drop: on macOS Tauri's native drop handler takes every
 * drop on the webview, so WebKit never delivers `drop` for a drag that starts
 * in the page. Pointer events are ours end to end.
 */
export interface FileDrag {
  paths: string[]
  /** Pointer position, client coordinates. */
  x: number
  y: number
}

/** Takes the drop when it is over it; `false` lets an older target try. */
export type FileDropHandler = (paths: string[], x: number, y: number) => boolean

/** Movement before a press becomes a drag, so a plain click stays a click. */
const DRAG_THRESHOLD = 4

const [drag, setDrag] = createSignal<FileDrag | null>(null)
export const fileDrag: Accessor<FileDrag | null> = drag

const handlers: FileDropHandler[] = []

export function onFileDrop(handler: FileDropHandler): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i >= 0) handlers.splice(i, 1)
  }
}

let end: (() => void) | null = null

/** Call from a pointerdown on something that holds `paths`. */
export function beginFileDrag(e: Pick<PointerEvent, 'button' | 'clientX' | 'clientY'>, paths: string[]): void {
  if (e.button !== 0 || paths.length === 0) return
  end?.()
  const startX = e.clientX
  const startY = e.clientY
  let active = false

  const onMove = (ev: MouseEvent) => {
    if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
    active = true
    ev.preventDefault()
    window.getSelection()?.removeAllRanges()
    setDrag({ paths, x: ev.clientX, y: ev.clientY })
  }
  const onUp = (ev: MouseEvent) => {
    const dropped = active
    stop()
    if (!dropped) return
    // The release must not also click whatever is under it (or the row it started on).
    const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    for (const h of [...handlers].reverse()) {
      if (h(paths, ev.clientX, ev.clientY)) break
    }
  }
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && active) stop() }
  const stop = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('keydown', onKey)
    setDrag(null)
    end = null
  }
  end = stop
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', stop)
  window.addEventListener('keydown', onKey)
}

export function __resetFileDragForTests(): void {
  end?.()
  handlers.length = 0
}
