import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskBoard, type BoardCard } from './TaskBoard'
afterEach(cleanup)
const cards: BoardCard[] = [
  { id: 'a', name: 'Fix login', projectId: 'p', projectName: 'Verun', groupId: 'g', column: 'running', label: 'Running', branch: 'fix-login' },
  { id: 'b', name: 'Review billing', projectId: 'q', projectName: 'Billing', groupId: 'ungrouped', column: 'attention', label: 'Approval needed', branch: 'billing' },
  { id: 'c', name: 'Old task', projectId: 'p', projectName: 'Verun', groupId: 'g', column: 'archived', label: 'Archived', branch: 'old' },
]
test('moves cards reactively, opens tasks, and hides archives by default', async () => {
  const [rows, setRows] = createSignal(cards)
  const open = vi.fn()
  render(() => <TaskBoard cards={rows()} groups={[{ id: 'g', name: 'Products' }]} onOpen={open} onClose={() => {}} />)
  expect(screen.queryByText('Old task')).toBeNull()
  await fireEvent.click(screen.getByText('Fix login'))
  expect(open).toHaveBeenCalledWith('a')
  setRows(cards.map(c => c.id === 'a' ? { ...c, column: 'ready', label: 'Ready to continue' } : c))
  expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('Fix login')).toBeTruthy()
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }))
  expect(screen.getByText('Old task')).toBeTruthy()
})
test('filters by group and project without mixing unrelated tasks', async () => {
  render(() => <TaskBoard cards={cards} groups={[{ id: 'g', name: 'Products' }]} onOpen={() => {}} onClose={() => {}} />)
  await fireEvent.click(screen.getByRole('combobox', { name: 'Group' }))
  await fireEvent.click(screen.getByRole('option', { name: 'Products' }))
  expect(screen.queryByText('Review billing')).toBeNull()
  expect(screen.getByText('Fix login')).toBeTruthy()
  await fireEvent.click(screen.getByRole('combobox', { name: 'Group' }))
  await fireEvent.click(screen.getByRole('option', { name: 'All groups' }))
  await fireEvent.click(screen.getByRole('combobox', { name: 'Project' }))
  await fireEvent.click(screen.getByRole('option', { name: 'Billing' }))
  expect(screen.queryByText('Fix login')).toBeNull()
  expect(screen.getByText('Review billing')).toBeTruthy()
})
