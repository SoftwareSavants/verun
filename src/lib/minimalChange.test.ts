import { test, expect } from 'vitest'
import { minimalChange } from './minimalChange'

const apply = (s: string, c: { from: number; to: number; insert: string }) => s.slice(0, c.from) + c.insert + s.slice(c.to)

test('replaces only the span that differs', () => {
  const a = 'line 1\nline 2\nline 3\n'
  const b = 'line 1\nline two\nline 3\n'
  const c = minimalChange(a, b)
  expect(c).toEqual({ from: 12, to: 13, insert: 'two' })
  expect(apply(a, c)).toBe(b)
})

test('handles appends, deletions and repeated text', () => {
  for (const [a, b] of [['abc', 'abcdef'], ['abcdef', 'abc'], ['aaaa', 'aaaaaa'], ['', 'x'], ['x', ''], ['same', 'same']]) {
    expect(apply(a, minimalChange(a, b))).toBe(b)
  }
  expect(minimalChange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' })
})
