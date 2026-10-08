import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GroupToolbar, GroupHeading } from './ProjectGroups'
import { addGroup, groupState, resetGroupState, setGroupScope } from '../store/projectGroups'
beforeEach(() => { localStorage.clear(); resetGroupState() })
afterEach(cleanup)
test('creates a named group inline and rejects duplicate names', () => {
  render(() => <GroupToolbar attention={[]} onAttention={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'New group' }))
  fireEvent.input(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Products' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(groupState().groups[0].name).toBe('Products')
  fireEvent.click(screen.getByRole('button', { name: 'New group' }))
  fireEvent.input(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Products' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(screen.getByRole('alert').textContent).toContain('unique')
})
test('flat headings support collapse, inline rename and deleting only the group', () => {
  const id = addGroup('Products')
  render(() => <GroupHeading id={id} name={groupState().groups[0]?.name ?? "Products"} count={2} attention={1} />)
  fireEvent.click(screen.getByRole('button', { name: /Collapse Products/ }))
  expect(groupState().collapsed).toContain(id)
  fireEvent.click(screen.getByRole('button', { name: 'Rename Products' }))
  fireEvent.input(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Work' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
  expect(groupState().groups[0].name).toBe('Work')
  fireEvent.click(screen.getByRole('button', { name: 'Delete Work group; keep projects' }))
  expect(groupState().groups).toHaveLength(0)
})
test('attention outside the current group remains actionable', () => {
  const group = addGroup('Products'); setGroupScope(group)
  const jump = vi.fn()
  render(() => <GroupToolbar attention={[{ id: 'clients', name: 'Clients', count: 2 }]} onAttention={jump} />)
  fireEvent.click(screen.getByRole('button', { name: /Clients.*2 need attention/ }))
  expect(jump).toHaveBeenCalledWith('clients')
})
