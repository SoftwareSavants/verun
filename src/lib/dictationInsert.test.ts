import { expect, test } from 'vitest'
import { insertDictation, dictationInsertText } from './dictationInsert'

test('append to empty gives the take', () => {
  expect(insertDictation('', 'hello', null)).toEqual({ text: 'hello', cursor: 5 })
})

test('append pads one space after non-whitespace', () => {
  expect(insertDictation('hello', 'world', null)).toEqual({ text: 'hello world', cursor: 11 })
})

test('no extra space after trailing space or newline', () => {
  expect(insertDictation('hello ', 'world', null).text).toBe('hello world')
  expect(insertDictation('hello\n', 'world', null).text).toBe('hello\nworld')
})

test('trims the take', () => {
  expect(insertDictation('', '  hi there \n', null).text).toBe('hi there')
})

test('empty take leaves text and cursor alone', () => {
  expect(insertDictation('abc', '  ', null)).toEqual({ text: 'abc', cursor: 3 })
  expect(insertDictation('abc', '', { start: 1, end: 1 })).toEqual({ text: 'abc', cursor: 1 })
})

test('insert mid-text pads both sides where needed', () => {
  expect(insertDictation('ab', 'X', { start: 1, end: 1 })).toEqual({ text: 'a X b', cursor: 3 })
  expect(insertDictation('a b', 'X', { start: 2, end: 2 })).toEqual({ text: 'a X b', cursor: 3 })
  expect(insertDictation('a  b', 'X', { start: 2, end: 2 }).text).toBe('a X b')
})

test('insert at start pads only after', () => {
  expect(insertDictation('abc', 'X', { start: 0, end: 0 })).toEqual({ text: 'X abc', cursor: 1 })
})

test('insert before whitespace adds no trailing space', () => {
  expect(insertDictation('a b', 'X', { start: 1, end: 1 }).text).toBe('a X b')
  expect(insertDictation('a\nb', 'X', { start: 1, end: 1 }).text).toBe('a X\nb')
})

test('non-collapsed selection is replaced', () => {
  expect(insertDictation('one two three', 'X', { start: 4, end: 7 })).toEqual({ text: 'one X three', cursor: 5 })
})

test('cursor sits after the take, before any trailing pad', () => {
  const r = insertDictation('ab', 'X', { start: 1, end: 1 })
  expect(r.text.slice(0, r.cursor)).toBe('a X')
})

test('dictationInsertText is exactly the string insertDictation puts in, spaces included', () => {
  expect(dictationInsertText('ab', ' X ', { start: 1, end: 1 })).toBe(' X ')
  expect(dictationInsertText('a b', 'X', { start: 2, end: 2 })).toBe('X ')
  expect(dictationInsertText('hello', 'world', null)).toBe(' world')
  expect(dictationInsertText('', 'hi', null)).toBe('hi')
  expect(dictationInsertText('fix the bug', 'a', { start: 4, end: 7 })).toBe('a')
  expect(dictationInsertText('abc', '  ', null)).toBe('')
})
