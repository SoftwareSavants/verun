import { afterEach, expect, test } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { TurnFoldRow } from './Steps'
import type { FoldRow } from '../lib/workLog'

afterEach(() => cleanup())
type TurnRow = Extract<FoldRow, { kind: 'turn' }>
const row = (over: Partial<TurnRow> = {}): TurnRow => ({ kind: 'turn', key: 'turn:1', open: false, live: false, steps: 5, agents: 0, failed: 0, retried: [], running: 0, edits: 1, durationMs: 125_000, ...over })
const text = (r: TurnRow) => render(() => <TurnFoldRow row={r} onToggle={() => {}} />).container.textContent ?? ''

test('a finished turn says how long it worked and what it did', () => {
  expect(text(row())).toBe('Worked for 2m 5s  ·  5 steps  ·  1 edit')
})

test('a failure a retry fixed names what failed, apart from one nothing fixed, each with an icon', () => {
  const { container } = render(() => <TurnFoldRow row={row({ retried: ['pnpm lint'], failed: 2 })} onToggle={() => {}} />)
  expect(container.textContent).toContain('pnpm lint failed, then passed')
  expect(container.textContent).toContain('2 failed')
  expect(container.querySelector('[aria-label="Fixed on retry"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Failed"]')).not.toBeNull()
  cleanup()
  expect(text(row({ retried: ['pnpm lint', 'cargo test'] }))).toContain('2 steps failed, then passed')
})

test('a turn whose subagents still run counts them, and says what still runs', () => {
  const t = text(row({ steps: 0, edits: 0, agents: 3, running: 1 }))
  expect(t).toBe('Worked for 2m 5s  ·  3 agents  ·  1 still running')
})
