import { describe, test, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { UnseenDivider, TurnOutline } from './ChatCatchUp'

afterEach(() => cleanup())

const at = (h: number, m: number) => new Date(2026, 10, 10, h, m).getTime()

describe('UnseenDivider', () => {
  test('says how many turns finished since when', () => {
    const { container } = render(() => <UnseenDivider anchor={{ index: 3, turns: 2, since: at(14, 2) }} now={at(18, 0)} />)
    expect(container.textContent).toContain('New')
    expect(container.textContent).toContain('2 turns since 14:02')
    expect(container.querySelector('[data-unseen-divider]')).not.toBeNull()
  })
  test('one turn reads singular', () => {
    const { container } = render(() => <UnseenDivider anchor={{ index: 3, turns: 1, since: at(14, 2) }} now={at(18, 0)} />)
    expect(container.textContent).toContain('1 turn since')
  })
})

describe('TurnOutline', () => {
  const turns = [
    { index: 0, text: 'Fix the code blocks', at: at(9, 0), endedAt: at(9, 5) },
    { index: 4, text: 'Add line numbers', at: at(10, 0), endedAt: at(10, 5) },
    { index: 8, text: 'Open a PR', at: at(15, 0), endedAt: at(15, 5) },
  ]

  test('hidden for short sessions', () => {
    const { container } = render(() => <TurnOutline turns={turns.slice(0, 2)} active={0} onJump={() => {}} />)
    expect(container.querySelector('nav')).toBeNull()
  })

  test('one entry per prompt; clicking jumps to that turn', () => {
    const onJump = vi.fn()
    const { getAllByRole, getByRole } = render(() => <TurnOutline turns={turns} active={4} newFrom={8} onJump={onJump} />)
    expect(getAllByRole('button')).toHaveLength(3)
    fireEvent.click(getByRole('button', { name: /Add line numbers/ }))
    expect(onJump).toHaveBeenCalledWith(4)
  })

  test('marks the turn in view and the new ones', () => {
    const { getByRole } = render(() => <TurnOutline turns={turns} active={4} newFrom={8} onJump={() => {}} />)
    expect(getByRole('button', { name: /Add line numbers/ }).getAttribute('aria-current')).toBe('true')
    expect(getByRole('button', { name: /Open a PR/ }).hasAttribute('data-new')).toBe(true)
    expect(getByRole('button', { name: /Fix the code/ }).hasAttribute('data-new')).toBe(false)
  })

  test('a failed turn says so in the outline', () => {
    const failing = [...turns.slice(0, 2), { ...turns[2], failed: true }]
    const { getByRole } = render(() => <TurnOutline turns={failing} active={0} onJump={() => {}} />)
    expect(getByRole('button', { name: /Open a PR \(failed\)/ })).toBeTruthy()
  })

  test('new turns sit under a "New" label in the list, not just a colored dot', () => {
    const { container } = render(() => <TurnOutline turns={turns} active={0} newFrom={8} onJump={() => {}} />)
    const t = container.textContent ?? ''
    expect(t.indexOf('Add line numbers')).toBeLessThan(t.indexOf('New'))
    expect(t.indexOf('New')).toBeLessThan(t.indexOf('Open a PR'))
  })
})
