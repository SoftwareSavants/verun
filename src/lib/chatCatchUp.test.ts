import { describe, test, expect, beforeEach } from 'vitest'
import { turnOutline, unseenAnchor, loadSeen, markSeen, type TurnStart } from './chatCatchUp'

const user = (text: string, at?: number, endedAt?: number) => ({ type: 'user' as const, text, at, endedAt })
const reply = { type: 'assistant' as const, text: 'ok' }

describe('turnOutline', () => {
  test('one entry per user or wakeup block, with its block index and times', () => {
    const blocks = [user('first', 10, 20), reply, { type: 'wakeup' as const, prompt: 'check CI', at: 30 }, reply, user('second', 40)]
    expect(turnOutline(blocks)).toEqual([
      { index: 0, text: 'first', at: 10, endedAt: 20 },
      { index: 2, text: 'check CI', at: 30, endedAt: undefined },
      { index: 4, text: 'second', at: 40, endedAt: undefined },
    ])
  })
})

describe('unseenAnchor', () => {
  const turns: TurnStart[] = [
    { index: 0, text: 'a', at: 100, endedAt: 200 },
    { index: 3, text: 'b', at: 300, endedAt: 400 },
    { index: 6, text: 'c', at: 500, endedAt: 600 },
  ]
  const blockCount = 9

  test('nothing new: no anchor', () => {
    expect(unseenAnchor(turns, 600, blockCount)).toBeNull()
  })

  test('never looked at: no anchor (no guessing)', () => {
    expect(unseenAnchor(turns, undefined, blockCount)).toBeNull()
  })

  test('turns that finished after the last look start at the first one, counting them', () => {
    expect(unseenAnchor(turns, 250, blockCount)).toEqual({ index: 3, turns: 2, since: 250 })
  })

  test('a prompt you sent before leaving is already seen: the divider goes after it', () => {
    expect(unseenAnchor(turns, 520, blockCount)).toEqual({ index: 7, turns: 1, since: 520 })
  })

  test('a turn still running is not news on its own', () => {
    const running: TurnStart[] = [...turns.slice(0, 2), { index: 6, text: 'c', at: 500 }]
    expect(unseenAnchor(running, 450, blockCount)).toBeNull()
  })

  test('no blocks after the anchor: nothing to show', () => {
    expect(unseenAnchor([{ index: 0, text: 'a', at: 100, endedAt: 200 }], 150, 1)).toBeNull()
  })
})

describe('seen store', () => {
  beforeEach(() => localStorage.clear())
  test('remembers the last look per session across reloads', () => {
    markSeen('s1', 123)
    markSeen('s2', 456)
    expect(loadSeen('s1')).toBe(123)
    expect(loadSeen('s2')).toBe(456)
    expect(loadSeen('nope')).toBeUndefined()
  })
  test('never moves backwards', () => {
    markSeen('s1', 500)
    markSeen('s1', 100)
    expect(loadSeen('s1')).toBe(500)
  })
})
