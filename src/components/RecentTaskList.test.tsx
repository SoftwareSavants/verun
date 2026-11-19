import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { RecentTaskList } from './RecentTaskList'
afterEach(() => cleanup())

const r = (id: string) => ({ id, name: `Task ${id}`, column: 'idle' as const, lastActive: 0 })

describe('RecentTaskList', () => {
  test('lists tasks in the given order', () => {
    render(() => <RecentTaskList recent={[r('b'), r('c')]} quiet={[]} row={t => <div>{t().name}</div>} />)
    expect(screen.getAllByText(/^Task /).map(e => e.textContent)).toEqual(['Task b', 'Task c'])
  })

  test('quiet tasks stay folded under one line until asked for', () => {
    render(() => <RecentTaskList recent={[r('b')]} quiet={[r('d'), r('e')]} row={t => <div>{t().name}</div>} />)
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

  // The rows are rebuilt as new objects whenever any task's status or activity
  // changes (several times a second with agents running). Keyed by object, every
  // row's element was replaced each time, and a click whose press and release
  // straddled that landed on no row: clicking a task "sometimes did nothing".
  test('a task keeps its element when the rows are recomputed, and shows the new data', () => {
    const [rows, setRows] = createSignal([{ ...r('b'), lastActive: 1 }, r('c')])
    const picked = vi.fn()
    render(() => <RecentTaskList recent={rows()} quiet={[]} row={t => <button onClick={() => picked(t().id)}>{t().name} {t().lastActive}</button>} />)
    const before = screen.getByText('Task b 1')
    setRows([{ ...r('b'), lastActive: 2 }, r('c')])
    const after = screen.getByText('Task b 2')
    expect(after).toBe(before)
    fireEvent.click(after)
    expect(picked).toHaveBeenCalledWith('b')
  })

  test('reordered rows move with their task', () => {
    const [rows, setRows] = createSignal([r('b'), r('c')])
    render(() => <RecentTaskList recent={rows()} quiet={[]} row={t => <div>{t().name}</div>} />)
    const c = screen.getByText('Task c')
    setRows([r('c'), r('b')])
    expect(screen.getAllByText(/^Task /).map(e => e.textContent)).toEqual(['Task c', 'Task b'])
    expect(screen.getByText('Task c')).toBe(c)
  })
})
