import { describe, test, expect } from 'vitest'
import { firstErrorIndex, countLevel } from './ActionsPanel'
import { parseGhLogs } from '../lib/ghLogs'

function L(step: string | null, content: string, ts = '2026-04-22T13:15:11Z', job = 'typecheck'): string {
  return `${job}\t${step ?? 'UNKNOWN STEP'}\t${ts} ${content}`
}
const raw = (...lines: string[]) => lines.join('\n')

describe('firstErrorIndex', () => {
  test('returns -1 when no errors', () => {
    const r = raw(L('A', 'ok'), L('B', 'also ok'))
    expect(firstErrorIndex(parseGhLogs(r))).toBe(-1)
  })

  test('returns the index of the first ##[error] line', () => {
    const r = raw(
      L('A', 'ok'),
      L('A', 'still ok'),
      L('A', '##[error]boom'),
      L('A', '##[error]second'),
    )
    expect(firstErrorIndex(parseGhLogs(r))).toBe(2)
  })

  test('picks up heuristic rustc/cargo error lines', () => {
    const r = raw(
      L('Build', '   Compiling serde'),
      L('Build', 'error[E0425]: cannot find function `kill`'),
    )
    expect(firstErrorIndex(parseGhLogs(r))).toBe(1)
  })
})

describe('countLevel', () => {
  test('tallies errors and warnings independently', () => {
    const r = raw(
      L('A', '##[error]one'),
      L('A', '##[warning]w'),
      L('A', '##[error]two'),
      L('A', 'info line'),
    )
    const lines = parseGhLogs(r)
    expect(countLevel(lines, 'error')).toBe(2)
    expect(countLevel(lines, 'warning')).toBe(1)
    expect(countLevel(lines, 'info')).toBe(1)
  })
})
