import { expect, test } from 'vitest'
import { clampToViewport } from './clampToViewport'

const viewport = { width: 1000, height: 800 }
test('leaves a menu that fits where it was asked to open', () => {
  expect(clampToViewport({ x: 100, y: 100 }, { width: 200, height: 300 }, viewport)).toEqual({ x: 100, y: 100 })
})
test('pulls a menu opened near the bottom-right edge back inside the window', () => {
  expect(clampToViewport({ x: 950, y: 780 }, { width: 200, height: 300 }, viewport)).toEqual({ x: 792, y: 492 })
})
test('never pushes a menu past the top-left margin', () => {
  expect(clampToViewport({ x: 0, y: 700 }, { width: 200, height: 2000 }, viewport)).toEqual({ x: 8, y: 8 })
})
