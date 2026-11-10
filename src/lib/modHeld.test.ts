import { test, expect } from 'vitest'
import { initModHeld } from './modHeld'

test('marks the document while Cmd/Ctrl is held, and clears it on release or blur', () => {
  const stop = initModHeld()
  const root = document.documentElement
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, ctrlKey: true }))
  expect(root.hasAttribute('data-mod-held')).toBe(true)
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }))
  expect(root.hasAttribute('data-mod-held')).toBe(false)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', metaKey: true, ctrlKey: true }))
  window.dispatchEvent(new Event('blur'))
  expect(root.hasAttribute('data-mod-held')).toBe(false)
  stop()
})
