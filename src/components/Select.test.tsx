import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { Select } from './Select'
import { Dialog } from './Dialog'

afterEach(cleanup)
const options = [{ value: 'local', label: 'Local' }, { value: 'unavailable', label: 'Unavailable', disabled: true }, { value: 'cloud', label: 'Cloud' }]
test('keyboard selection skips disabled options without submitting the dialog', () => {
  const confirm = vi.fn()
  const close = vi.fn()
  const view = render(() => {
    const [value, setValue] = createSignal('local')
    return <Dialog open onClose={close} onConfirm={confirm}><Select label="Source" value={value()} options={options} onChange={setValue} /></Dialog>
  })
  const trigger = view.getByRole('combobox', { name: 'Source' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(trigger.textContent).toContain('Cloud')
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(close).not.toHaveBeenCalled()
})
test('mouse choices update the value; disabled selects cannot open', () => {
  const change = vi.fn()
  const view = render(() => <><Select label="Source" value="local" options={options} onChange={change} /><Select label="Locked" disabled value="local" options={options} onChange={change} /></>)
  fireEvent.click(view.getByRole('combobox', { name: 'Locked' }))
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(view.getByRole('combobox', { name: 'Source' }))
  expect(document.activeElement).toBe(view.getByRole('combobox', { name: 'Source' }))
  fireEvent.click(screen.getByRole('option', { name: 'Unavailable' }))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('option', { name: 'Cloud' }))
  expect(change).toHaveBeenCalledWith('cloud')
  expect(screen.queryByRole('listbox')).toBeNull()
})
