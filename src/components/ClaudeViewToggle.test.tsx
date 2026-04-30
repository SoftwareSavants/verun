import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import type { Session } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { ClaudeViewToggle } from './ClaudeViewToggle'
import { setSessionViewMode, setClaudeDefaultViewMode } from '../store/sessionViewMode'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  setSessionViewMode('s-1', null)
  // Reset the global default so the sticky-last-used test can't leak across
  // test cases (clicking a segment now bumps the default).
  setClaudeDefaultViewMode('ui')
})

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    taskId: 't-1',
    name: null,
    resumeSessionId: 'r-1',
    status: 'idle',
    startedAt: 0,
    endedAt: null,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    parentSessionId: null,
    forkedAtMessageUuid: null,
    agentType: 'claude',
    model: null,
    closedAt: null,
    ...overrides,
  }
}

describe('ClaudeViewToggle', () => {
  test('renders nothing for non-claude sessions', () => {
    const { queryByTestId } = render(() => (
      <ClaudeViewToggle session={session({ agentType: 'codex' })} sessionId="s-1" active />
    ))
    expect(queryByTestId('claude-view-toggle')).toBeNull()
  })

  test('renders nothing when sessionId is null', () => {
    const { queryByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId={null} active />
    ))
    expect(queryByTestId('claude-view-toggle')).toBeNull()
  })

  test('collapses to zero width on inactive tabs and re-expands when active', () => {
    // The control stays in the DOM so it can animate in/out smoothly, but
    // collapses to zero width + zero opacity + non-interactive when the tab
    // is not selected. Otherwise the tab width would snap when the user
    // changes selection.
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active={false} />
    ))
    const inactive = getByTestId('claude-view-toggle')
    expect(inactive.getAttribute('data-active')).toBe('false')
    expect(inactive.getAttribute('aria-hidden')).toBe('true')
    expect(inactive.className).toMatch(/max-w-0/)
    expect(inactive.className).toMatch(/opacity-0/)
    expect(inactive.className).toMatch(/pointer-events-none/)
    cleanup()

    const { getByTestId: getActive } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    const active = getActive('claude-view-toggle')
    expect(active.getAttribute('data-active')).toBe('true')
    expect(active.getAttribute('aria-hidden')).toBe('false')
    expect(active.className).toMatch(/max-w-12/)
    expect(active.className).toMatch(/opacity-100/)
  })

  test('renders for fresh Claude sessions without a resume id so the user can pre-set their preference', async () => {
    // The actual swap to the terminal view is gated by canUseTerminalView in
    // TaskPanel and only flips on once the first message creates a resume id.
    // The toggle just captures intent until then so a freshly-created task
    // can opt in to terminal mode before sending the first message.
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session({ resumeSessionId: null })} sessionId="s-1" active />
    ))
    expect(getByTestId('claude-view-toggle')).toBeTruthy()
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))
    expect(sessionViewMode('s-1')).toBe('terminal')
  })

  test('renders both segments when the session can use terminal view', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    expect(getByTestId('claude-view-toggle-ui')).toBeTruthy()
    expect(getByTestId('claude-view-toggle-terminal')).toBeTruthy()
  })

  test('UI segment is highlighted when in UI mode', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    expect(getByTestId('claude-view-toggle-ui').className).toMatch(/bg-accent/)
    expect(getByTestId('claude-view-toggle-terminal').className).not.toMatch(/bg-accent/)
  })

  test('terminal segment is highlighted when in terminal mode', () => {
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    expect(getByTestId('claude-view-toggle-terminal').className).toMatch(/bg-accent/)
    expect(getByTestId('claude-view-toggle-ui').className).not.toMatch(/bg-accent/)
  })

  test('clicking the terminal segment switches to terminal mode and persists', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))
    expect(sessionViewMode('s-1')).toBe('terminal')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('terminal')
  })

  test('clicking the UI segment switches back to UI mode and persists', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    expect(sessionViewMode('s-1')).toBe('ui')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('ui')
  })

  test('tooltips are short and free of CLI jargon', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    expect(getByTestId('claude-view-toggle-ui').getAttribute('title')).toBe('UI view')
    expect(getByTestId('claude-view-toggle-terminal').getAttribute('title')).toBe('Terminal view')
  })

  test('clicking a segment updates the global default so new sessions inherit it', async () => {
    // Sticky last-used: the global default is the user's most recent choice
    // so newly-created sessions in any task default to it without anyone
    // hunting for a setting. Settings → General → Claude Code can still pin
    // an explicit default.
    const { sessionViewMode, claudeDefaultViewMode, setClaudeDefaultViewMode } = await import('../store/sessionViewMode')
    setClaudeDefaultViewMode('ui')
    expect(claudeDefaultViewMode()).toBe('ui')

    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" active />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))

    expect(sessionViewMode('s-1')).toBe('terminal')
    expect(claudeDefaultViewMode()).toBe('terminal')
    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('terminal')

    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    expect(claudeDefaultViewMode()).toBe('ui')
    expect(localStorage.getItem('verun:claudeDefaultViewMode')).toBe('ui')
  })

  test('clicks do not bubble to the parent tab handler', () => {
    const onParentClick = vi.fn()
    const { getByTestId } = render(() => (
      <div onClick={onParentClick}>
        <ClaudeViewToggle session={session()} sessionId="s-1" active />
      </div>
    ))
    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))
    expect(onParentClick).not.toHaveBeenCalled()
  })
})
