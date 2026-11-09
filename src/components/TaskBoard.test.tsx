import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskBoard, type BoardCard } from './TaskBoard'
afterEach(cleanup)
const cards: BoardCard[] = [
  { id: 'a', name: 'Fix login', projectId: 'p', projectName: 'Verun', groupId: 'g', column: 'running', kind: 'running', label: 'Running', branch: 'fix-login' },
  { id: 'b', name: 'Review billing', projectId: 'q', projectName: 'Billing', groupId: 'ungrouped', column: 'attention', kind: 'input', label: 'Needs input', branch: 'billing' },
  { id: 'c', name: 'Old task', projectId: 'p', projectName: 'Verun', groupId: 'g', column: 'archived', kind: 'archived', label: 'Archived', branch: 'old' },
]
test('moves cards reactively, opens tasks, and hides archives by default', async () => {
  const [rows, setRows] = createSignal(cards)
  const open = vi.fn()
  render(() => <TaskBoard cards={rows()} groups={[{ id: 'g', name: 'Products' }]} onOpen={open} onClose={() => {}} />)
  expect(screen.queryByText('Old task')).toBeNull()
  await fireEvent.click(screen.getByText('Fix login'))
  expect(open).toHaveBeenCalledWith('a')
  setRows(cards.map(c => c.id === 'a' ? { ...c, column: 'idle', kind: 'idle', label: 'Idle' } : c))
  expect(within(screen.getByRole('region', { name: 'Idle' })).getByText('Fix login')).toBeTruthy()
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
test('leads with what needs you, with the reason as text and an icon, never color alone', () => {
  render(() => <TaskBoard cards={cards} groups={[]} onOpen={() => {}} onClose={() => {}} />)
  const regions = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))
  expect(regions).toEqual(['Needs you', 'Running', 'Idle', 'In review', 'Done'])
  const needsYou = within(screen.getByRole('region', { name: 'Needs you' }))
  expect(needsYou.getByText('Needs input')).toBeTruthy()
  expect(needsYou.getByRole('img', { name: 'Needs input' })).toBeTruthy()
  expect(screen.getByText('1 needs you').className).toContain('text-status-waiting')
  expect(screen.getByText('1 running').className).not.toContain('text-status-waiting')
  expect(screen.getByText('0 idle')).toBeTruthy()
  expect(screen.getByText('0 in review')).toBeTruthy()
  expect(screen.getByText('0 done')).toBeTruthy()
})
test('keeps the branch available without spending a line on it', () => {
  render(() => <TaskBoard cards={cards} groups={[]} onOpen={() => {}} onClose={() => {}} />)
  expect(screen.queryByText('fix-login')).toBeNull()
  expect(screen.getByRole('button', { name: /Fix login/ }).getAttribute('title')).toContain('fix-login')
})
test('empty columns shrink so space follows the work', () => {
  render(() => <TaskBoard cards={cards} groups={[]} onOpen={() => {}} onClose={() => {}} />)
  const many = [cards[0], { ...cards[0], id: 'a2', name: 'Fix signup' }]
  render(() => <TaskBoard cards={many} groups={[]} onOpen={() => {}} onClose={() => {}} />)
  expect(screen.getAllByRole('region', { name: 'Done' })[0].className).toContain('flex-none')
  expect(screen.getAllByRole('region', { name: 'Running' })[1].className).not.toContain('flex-none')
})
