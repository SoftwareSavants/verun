import { describe, test, expect } from 'vitest'
import { newTaskIds } from './taskDiff'

describe('newTaskIds', () => {
  test('first mount — processes every id when prev is undefined', () => {
    expect(newTaskIds(undefined, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  test('no change — returns empty', () => {
    expect(newTaskIds(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  test('one added — returns only the added id', () => {
    expect(newTaskIds(['a', 'b'], ['c', 'a', 'b'])).toEqual(['c'])
  })

  test('multiple added — returns all newcomers in current order', () => {
    expect(newTaskIds(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c'])
  })

  test('removal only — returns empty', () => {
    expect(newTaskIds(['a', 'b', 'c'], ['a', 'b'])).toEqual([])
  })

  test('swap (placeholder id → real id) — returns only the real id', () => {
    expect(newTaskIds(['placeholder'], ['real'])).toEqual(['real'])
  })

  test('reorder only — returns empty', () => {
    expect(newTaskIds(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([])
  })
})
