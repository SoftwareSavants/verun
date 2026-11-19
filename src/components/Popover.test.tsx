import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@solidjs/testing-library'
import { Popover } from './Popover'

afterEach(cleanup)

// A pane that clips (overflow, clip-path) clips fixed children too: an anchored
// popover renders at the top of the document so nothing around it cuts it off.
test('an anchored popover renders outside the element that opened it', () => {
  const { container } = render(() => (
    <div style="clip-path: inset(0)"><Popover open pos={{ x: 10, y: 20 }} onClose={() => {}}><span>menu</span></Popover></div>
  ))
  const menu = screen.getByText('menu').parentElement!
  expect(container.contains(menu)).toBe(false)
  expect(menu.classList.contains('fixed')).toBe(true)
})

test('an unanchored popover stays where it is placed', () => {
  const { container } = render(() => <div><Popover open onClose={() => {}}><span>menu</span></Popover></div>)
  expect(container.contains(screen.getByText('menu'))).toBe(true)
})
