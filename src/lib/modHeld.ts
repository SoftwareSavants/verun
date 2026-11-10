import { modPressed } from './platform'

/**
 * Mark the document while Cmd (Ctrl elsewhere) is held, so links and file
 * paths show they are clickable only when a click would open them.
 */
export function initModHeld(): () => void {
  const root = document.documentElement
  const sync = (e: KeyboardEvent | MouseEvent) => root.toggleAttribute('data-mod-held', modPressed(e))
  const clear = () => root.removeAttribute('data-mod-held')
  window.addEventListener('keydown', sync)
  window.addEventListener('keyup', sync)
  // Holding the key before the pointer arrives still counts.
  window.addEventListener('mousemove', sync, { passive: true })
  window.addEventListener('blur', clear)
  return () => {
    window.removeEventListener('keydown', sync)
    window.removeEventListener('keyup', sync)
    window.removeEventListener('mousemove', sync)
    window.removeEventListener('blur', clear)
    clear()
  }
}
