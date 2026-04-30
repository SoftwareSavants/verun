import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import type { Session } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { ClaudeViewToggle } from './ClaudeViewToggle'
import { setSessionViewMode } from '../store/sessionViewMode'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  setSessionViewMode('s-1', null)
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
      <ClaudeViewToggle session={session({ agentType: 'codex' })} sessionId="s-1" />
    ))
    expect(queryByTestId('claude-view-toggle')).toBeNull()
  })

  test('renders nothing when sessionId is null', () => {
    const { queryByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId={null} />
    ))
    expect(queryByTestId('claude-view-toggle')).toBeNull()
  })

  test('renders nothing when the session has no resume id (first turn not yet reached)', () => {
    const { queryByTestId } = render(() => (
      <ClaudeViewToggle session={session({ resumeSessionId: null })} sessionId="s-1" />
    ))
    expect(queryByTestId('claude-view-toggle')).toBeNull()
  })

  test('renders the icon button when the session can use terminal view', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle')).toBeTruthy()
  })

  test('shows the terminal-target tooltip and Terminal icon when in UI mode', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    const btn = getByTestId('claude-view-toggle')
    expect(btn.getAttribute('title')).toMatch(/switch to terminal/i)
  })

  test('shows the ui-target tooltip when in terminal mode', () => {
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle').getAttribute('title')).toMatch(/switch to ui/i)
  })

  test('clicking flips ui → terminal and persists to localStorage', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(sessionViewMode('s-1')).toBe('ui')

    fireEvent.click(getByTestId('claude-view-toggle'))
    expect(sessionViewMode('s-1')).toBe('terminal')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('terminal')
  })

  test('clicking again flips terminal → ui', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    fireEvent.click(getByTestId('claude-view-toggle'))
    expect(sessionViewMode('s-1')).toBe('ui')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('ui')
  })

  test('click does not bubble (so the parent tab handler does not fire)', () => {
    const onParentClick = vi.fn()
    const { getByTestId } = render(() => (
      <div onClick={onParentClick}>
        <ClaudeViewToggle session={session()} sessionId="s-1" />
      </div>
    ))
    fireEvent.click(getByTestId('claude-view-toggle'))
    expect(onParentClick).not.toHaveBeenCalled()
  })
})
