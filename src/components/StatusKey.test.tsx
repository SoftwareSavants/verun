import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { StatusKey } from './StatusKey'
import { STATUS_GUIDE } from '../lib/taskBoard'
afterEach(() => cleanup())

describe('StatusKey', () => {
  test('explains every status icon, telling background work apart from idle', () => {
    render(() => <StatusKey />)
    expect(screen.queryByText('Idle')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Status key' }))
    for (const entry of STATUS_GUIDE) expect(screen.getByText(entry.name)).toBeTruthy()
    expect(screen.getByText('Your turn, work still running')).toBeTruthy()
    expect(screen.getByText(/Subagents, shells or watchers Claude started/)).toBeTruthy()
  })
})
