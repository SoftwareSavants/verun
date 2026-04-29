import { describe, test, expect } from 'vitest'
import { canUseTerminalView, formatDroppedPathsForTerminal, estimatePtyDimensions } from './terminalMode'
import type { Session } from '../types'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    taskId: 't1',
    name: null,
    resumeSessionId: 'resume-uuid',
    status: 'idle',
    startedAt: 0,
    endedAt: null,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    parentSessionId: null,
    forkedAtMessageUuid: null,
    agentType: 'claude',
    model: null,
    closedAt: null,
    ...overrides,
  }
}

describe('canUseTerminalView', () => {
  test('true for a claude session with a resume id', () => {
    expect(canUseTerminalView(session())).toBe(true)
  })

  test('false when resumeSessionId is missing (first turn not yet reached)', () => {
    expect(canUseTerminalView(session({ resumeSessionId: null }))).toBe(false)
  })

  test('false for non-claude agents', () => {
    expect(canUseTerminalView(session({ agentType: 'codex' }))).toBe(false)
    expect(canUseTerminalView(session({ agentType: 'gemini' }))).toBe(false)
  })

  test('false for null / undefined session', () => {
    expect(canUseTerminalView(null)).toBe(false)
    expect(canUseTerminalView(undefined)).toBe(false)
  })
})

describe('formatDroppedPathsForTerminal', () => {
  test('single path with no special chars', () => {
    expect(formatDroppedPathsForTerminal(['/tmp/img.png'])).toBe("'/tmp/img.png' ")
  })

  test('path with spaces is single-quoted', () => {
    expect(formatDroppedPathsForTerminal(['/tmp/My Pictures/a b.png'])).toBe(
      "'/tmp/My Pictures/a b.png' ",
    )
  })

  test("embedded single quote escapes via '\\''", () => {
    expect(formatDroppedPathsForTerminal(["/tmp/it's mine.png"])).toBe(
      "'/tmp/it'\\''s mine.png' ",
    )
  })

  test('multiple paths join with spaces', () => {
    expect(formatDroppedPathsForTerminal(['/a/b.png', '/c d/e.png'])).toBe(
      "'/a/b.png' '/c d/e.png' ",
    )
  })

  test('empty list returns empty string', () => {
    expect(formatDroppedPathsForTerminal([])).toBe('')
  })
})

describe('estimatePtyDimensions', () => {
  test('typical 1200x800 container at 14px font', () => {
    const { rows, cols } = estimatePtyDimensions(1200, 800, 14)
    expect(cols).toBeGreaterThan(120)
    expect(rows).toBeGreaterThan(40)
  })

  test('falls back to 24x80 on zero/negative inputs', () => {
    expect(estimatePtyDimensions(0, 800, 14)).toEqual({ rows: 24, cols: 80 })
    expect(estimatePtyDimensions(1200, 0, 14)).toEqual({ rows: 24, cols: 80 })
    expect(estimatePtyDimensions(1200, 800, 0)).toEqual({ rows: 24, cols: 80 })
  })

  test('clamps to a sensible minimum on tiny containers', () => {
    const { rows, cols } = estimatePtyDimensions(50, 50, 14)
    expect(rows).toBeGreaterThanOrEqual(10)
    expect(cols).toBeGreaterThanOrEqual(20)
  })
})
