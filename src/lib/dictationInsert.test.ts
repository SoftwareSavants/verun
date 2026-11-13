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

test('no joining space next to CJK text on either side', () => {
  expect(insertDictation('你好', '世界', null).text).toBe('你好世界')
  expect(insertDictation('hello', '世界', null).text).toBe('hello世界')
  expect(insertDictation('世界', 'hello', null).text).toBe('世界hello')
  expect(insertDictation('こんにちは', 'カタカナ', null).text).toBe('こんにちはカタカナ')
  expect(insertDictation('文。', 'next', null).text).toBe('文。next')
  expect(insertDictation('ａｂ', 'x', null).text).toBe('ａｂx')
  // Before following text too.
  expect(insertDictation('ab日本', '中文', { start: 2, end: 2 }).text).toBe('ab中文日本')
  expect(dictationInsertText('日本語', 'x', { start: 1, end: 1 })).toBe('x')
})

test('no space before closing punctuation', () => {
  for (const p of [',', '.', ';', ':', '!', '?', ')', ']', '}', '،', '؛', '؟']) {
    expect(insertDictation('hello', p + ' more', null).text).toBe('hello' + p + ' more')
    expect(insertDictation('a' + p, 'X', { start: 1, end: 1 }).text).toBe('a X' + p)
  }
})

test('no space after an opening bracket or quote', () => {
  for (const o of ['(', '[', '{', '“', '‘', '«']) {
    expect(insertDictation('see ' + o, 'this', null).text).toBe('see ' + o + 'this')
  }
  expect(insertDictation('say "', 'hi', null).text).toBe('say "hi')
  expect(insertDictation("'", 'hi', null).text).toBe("'hi")
  // A closing straight quote still gets the space.
  expect(insertDictation('he said "hi"', 'then', null).text).toBe('he said "hi" then')
  // A take that ends with an opening bracket gets no space before what follows.
  expect(insertDictation('ab', 'call(', { start: 1, end: 1 }).text).toBe('a call(b')
})

test('Latin spacing is unchanged', () => {
  expect(insertDictation('hello', 'world', null).text).toBe('hello world')
  expect(insertDictation('ab', 'X', { start: 1, end: 1 }).text).toBe('a X b')
  expect(insertDictation('مرحبا', 'بكم', null).text).toBe('مرحبا بكم')
})
