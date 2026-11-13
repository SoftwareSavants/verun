import { test, expect } from 'vitest'
import { holdKeyName } from './holdKeyName'

test('each hold key has the name a Mac keyboard uses', () => {
  expect(holdKeyName('fn')).toBe('Fn')
  expect(holdKeyName('right-option')).toBe('Right Option')
  expect(holdKeyName('right-command')).toBe('Right Command')
})
