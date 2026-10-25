import { describe, test, expect } from 'vitest'
import { parseMentions, extractMentionedFiles, formatMention } from './mentions'

describe('formatMention', () => {
  test('plain paths stay bare', () => {
    expect(formatMention('src/a.ts')).toBe('@src/a.ts')
  })
  test('paths with whitespace are quoted', () => {
    expect(formatMention('/Users/me/My Doc.pdf')).toBe('@"/Users/me/My Doc.pdf"')
  })
})

describe('parseMentions', () => {
  test('round-trips quoted mentions with spaces', () => {
    const text = `see ${formatMention('/Users/me/My Doc.pdf')} and ${formatMention('src/a.ts')} ok`
    expect(parseMentions(text)).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'mention', value: '/Users/me/My Doc.pdf' },
      { type: 'text', value: ' and ' },
      { type: 'mention', value: 'src/a.ts' },
      { type: 'text', value: ' ok' },
    ])
  })

  test('extractMentionedFiles reads quoted and bare mentions', () => {
    expect(extractMentionedFiles('@"a b.txt" @c.ts @"a b.txt"')).toEqual(['a b.txt', 'c.ts'])
  })
})
