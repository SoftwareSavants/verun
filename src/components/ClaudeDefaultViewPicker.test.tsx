import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { ClaudeDefaultViewPicker } from './ClaudeDefaultViewPicker'
import { setClaudeDefaultViewMode } from '../store/sessionViewMode'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  // Reset the in-memory signal back to the default state so each test starts
  // from 'ui' regardless of the order they run.
  setClaudeDefaultViewMode('ui')
  localStorage.removeItem('verun:claudeDefaultViewMode')
})

describe('ClaudeDefaultViewPicker', () => {
  test('renders both pills with UI active by default', () => {
    const { getByTestId } = render(() => <ClaudeDefaultViewPicker />)
    const ui = getByTestId('claude-default-view-picker-ui')
    const terminal = getByTestId('claude-default-view-picker-terminal')
    expect(ui.className).toMatch(/bg-accent\/20/)
    expect(terminal.className).not.toMatch(/bg-accent\/20/)
  })

  test('clicking Terminal flips the active pill and persists to localStorage', async () => {
    const { getByTestId } = render(() => <ClaudeDefaultViewPicker />)
    fireEvent.click(getByTestId('claude-default-view-picker-terminal'))

    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('terminal')
    const ui = getByTestId('claude-default-view-picker-ui')
    const terminal = getByTestId('claude-default-view-picker-terminal')
    expect(terminal.className).toMatch(/bg-accent\/20/)
    expect(ui.className).not.toMatch(/bg-accent\/20/)
  })

  test('clicking UI flips back from terminal and persists', async () => {
    setClaudeDefaultViewMode('terminal')
    const { getByTestId } = render(() => <ClaudeDefaultViewPicker />)

    fireEvent.click(getByTestId('claude-default-view-picker-ui'))
    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('ui')
    const ui = getByTestId('claude-default-view-picker-ui')
    const terminal = getByTestId('claude-default-view-picker-terminal')
    expect(ui.className).toMatch(/bg-accent\/20/)
    expect(terminal.className).not.toMatch(/bg-accent\/20/)
  })

  test('reflects the persisted default on mount when terminal is the saved mode', () => {
    setClaudeDefaultViewMode('terminal')
    const { getByTestId } = render(() => <ClaudeDefaultViewPicker />)
    const terminal = getByTestId('claude-default-view-picker-terminal')
    expect(terminal.className).toMatch(/bg-accent\/20/)
  })

  test('clicking the already-active pill is idempotent', () => {
    const { getByTestId } = render(() => <ClaudeDefaultViewPicker />)
    fireEvent.click(getByTestId('claude-default-view-picker-ui'))
    fireEvent.click(getByTestId('claude-default-view-picker-ui'))
    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('ui')
    const ui = getByTestId('claude-default-view-picker-ui')
    expect(ui.className).toMatch(/bg-accent\/20/)
  })
})
