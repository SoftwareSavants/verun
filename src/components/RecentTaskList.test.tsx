import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { RecentTaskList } from './RecentTaskList'
afterEach(() => cleanup())

const r = (id: string) => ({ id, name: `Task ${id}`, column: 'idle' as const, lastActive: 0 })

describe('RecentTaskList', () => {
  test('lists tasks in the given order', () => {
    render(() => <RecentTaskList recent={[r('b'), r('c')]} quiet={[]} row={t => <div>{t.name}</div>} />)
    expect(screen.getAllByText(/^Task /).map(e => e.textContent)).toEqual(['Task b', 'Task c'])
  })

  test('quiet tasks stay folded under one line until asked for', () => {
    render(() => <RecentTaskList recent={[r('b')]} quiet={[r('d'), r('e')]} row={t => <div>{t.name}</div>} />)
    expect(screen.queryByText('Task d')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2 quiet for 3+ days' }))
    expect(screen.getByText('Task d')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide quiet tasks' }))
    expect(screen.queryByText('Task d')).toBeNull()
  })

  test('nothing to list says so', () => {
    render(() => <RecentTaskList recent={[]} quiet={[]} row={() => null} />)
    expect(screen.getByText('No other tasks.')).toBeTruthy()
  })
})
