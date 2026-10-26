import { describe, test, expect, vi, afterEach } from 'vitest'
import { createRoot, createSignal } from 'solid-js'
import { useDismissable } from './dismissable'

// Settings closes on Escape. An overlay opened in it has to be what Escape closes.
function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  return event
}

const disposers: Array<() => void> = []
const listeners: Array<(e: KeyboardEvent) => void> = []

/** An overlay whose open state the test drives. */
function overlay(close: () => void, initiallyOpen = true) {
  return createRoot((dispose) => {
    disposers.push(dispose)
    const [open, setOpen] = createSignal(initiallyOpen)
    useDismissable(open, close)
    return { setOpen, dispose }
  })
}

/** What Settings does: listens for Escape on the window, behind the overlay. */
function behind() {
  const handler = vi.fn()
  window.addEventListener('keydown', handler)
  listeners.push(handler)
  return handler
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const handler of listeners.splice(0)) window.removeEventListener('keydown', handler)
})

describe('useDismissable', () => {
  test('Escape closes the open overlay, and the handlers behind it never see the key', () => {
    const handler = behind()
    const close = vi.fn()
    overlay(close)

    const event = press('Escape')

    expect(close).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  test('other keys are left alone', () => {
    const handler = behind()
    const close = vi.fn()
    overlay(close)

    press('Enter')

    expect(close).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('does nothing while the overlay is closed, and starts once it opens', () => {
    const handler = behind()
    const close = vi.fn()
    const { setOpen } = overlay(close, false)

    press('Escape')
    expect(close).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledOnce()

    setOpen(true)
    press('Escape')
    expect(close).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('stops once the overlay closes', () => {
    const close = vi.fn()
    const { setOpen } = overlay(close)

    setOpen(false)
    press('Escape')

    expect(close).not.toHaveBeenCalled()
  })

  test('stops once the overlay is taken away', () => {
    const close = vi.fn()
    const { dispose } = overlay(close)

    dispose()
    press('Escape')

    expect(close).not.toHaveBeenCalled()
  })

  test('the overlay opened last closes first', () => {
    const closeFirst = vi.fn()
    const closeSecond = vi.fn()
    overlay(closeFirst)
    overlay(closeSecond)

    press('Escape')
    expect(closeSecond).toHaveBeenCalledOnce()
    expect(closeFirst).not.toHaveBeenCalled()
  })
})
