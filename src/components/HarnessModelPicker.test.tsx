import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../store/agents', () => ({ agents: [
  { id: 'claude', name: 'Claude Code', installed: true, cliVersion: '1.0.0', supportsModelSelection: true, models: [{ id: 'opus', label: 'Opus', description: 'Deep work' }, { id: 'future', label: 'Future', description: '', minVersion: '9.0.0' }] },
  { id: 'codex', name: 'Codex', installed: true, supportsModelSelection: true, models: [{ id: 'gpt', label: 'GPT', description: 'Coding' }] },
  { id: 'gemini', name: 'Gemini', installed: false, models: [] },
  { id: 'cursor', name: 'Cursor', installed: true, supportsModelSelection: false, models: [] },
] }))
import { HarnessModelPicker } from './HarnessModelPicker'
afterEach(cleanup)
test('browsing harnesses only commits a choice when a model is selected', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  expect(pick).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Opus' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
  expect(pick).toHaveBeenCalledWith('codex', 'gpt')
  expect(screen.queryByRole('dialog')).toBeNull()
})
test('uninstalled harnesses and models requiring newer CLIs cannot be selected', () => {
  render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  expect((screen.getByRole('button', { name: /Gemini/ }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: /Future/ }) as HTMLButtonElement).disabled).toBe(true)
})
test('harnesses without model selection use their CLI default', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cursor' }))
  fireEvent.click(screen.getByRole('button', { name: /CLI default/ }))
  expect(pick).toHaveBeenCalledWith('cursor', undefined)
})

test('search filters models and Escape cancels browsing and restores focus', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  const trigger = screen.getByRole('button', { name: 'Choose model: Opus' })
  fireEvent.click(trigger)
  fireEvent.input(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'missing' } })
  expect(screen.getByText('No matching models.')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(pick).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
})
