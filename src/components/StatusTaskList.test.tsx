import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
afterEach(() => cleanup())
import { StatusTaskList } from './StatusTaskList'
import type { StatusSection, StatusRow } from '../lib/statusView'

type Row = StatusRow & { name: string }
const r = (id: string, column: string): Row => ({ id, name: `Task ${id}`, column: column as never, lastActive: 0 })
const sections: StatusSection<Row>[] = [
  { id: 'attention', name: 'Needs you', recent: [r('a', 'attention')], quiet: [] },
  { id: 'idle', name: 'Idle', recent: [r('b', 'idle'), r('c', 'idle')], quiet: [r('d', 'idle'), r('e', 'idle')] },
]

describe('StatusTaskList', () => {
  test('one labelled group per status, its tasks in the given order, with a count', () => {
    render(() => <StatusTaskList sections={sections} row={t => <div>{t.name}</div>} />)
    const idle = screen.getByRole('region', { name: 'Idle' })
    expect(within(idle).getAllByText(/^Task /).map(e => e.textContent)).toEqual(['Task b', 'Task c'])
    expect(within(idle).getByText('4')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Needs you' })).getByText('Task a')).toBeTruthy()
  })

  test('quiet tasks stay folded under one line until asked for', () => {
    render(() => <StatusTaskList sections={sections} row={t => <div>{t.name}</div>} />)
    expect(screen.queryByText('Task d')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2 quiet for 3+ days' }))
    expect(screen.getByText('Task d')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide quiet tasks' }))
    expect(screen.queryByText('Task d')).toBeNull()
  })

  test('nothing to list says so', () => {
    render(() => <StatusTaskList sections={[]} row={() => null} />)
    expect(screen.getByText('No tasks yet.')).toBeTruthy()
  })
})
