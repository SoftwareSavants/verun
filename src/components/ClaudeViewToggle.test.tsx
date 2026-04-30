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

  test('renders both segments when the session can use terminal view', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle-ui')).toBeTruthy()
    expect(getByTestId('claude-view-toggle-terminal')).toBeTruthy()
  })

  test('UI segment is highlighted when in UI mode', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle-ui').className).toMatch(/bg-accent/)
    expect(getByTestId('claude-view-toggle-terminal').className).not.toMatch(/bg-accent/)
  })

  test('terminal segment is highlighted when in terminal mode', () => {
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle-terminal').className).toMatch(/bg-accent/)
    expect(getByTestId('claude-view-toggle-ui').className).not.toMatch(/bg-accent/)
  })

  test('clicking the terminal segment switches to terminal mode and persists', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))
    expect(sessionViewMode('s-1')).toBe('terminal')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('terminal')
  })

  test('clicking the UI segment switches back to UI mode and persists', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    expect(sessionViewMode('s-1')).toBe('ui')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('ui')
  })

  test('tooltips are short and free of CLI jargon', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle-ui').getAttribute('title')).toBe('UI view')
    expect(getByTestId('claude-view-toggle-terminal').getAttribute('title')).toBe('Terminal view')
  })

  test('clicks do not bubble to the parent tab handler', () => {
    const onParentClick = vi.fn()
    const { getByTestId } = render(() => (
      <div onClick={onParentClick}>
        <ClaudeViewToggle session={session()} sessionId="s-1" />
      </div>
    ))
    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    fireEvent.click(getByTestId('claude-view-toggle-terminal'))
    expect(onParentClick).not.toHaveBeenCalled()
  })
})
