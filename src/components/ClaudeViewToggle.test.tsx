import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import type { Session } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { ClaudeViewToggle } from './ClaudeViewToggle'
import { setSessionViewMode } from '../store/sessionViewMode'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  // Clear any per-session override so each test starts at the app default ('ui').
  // We can't use vi.resetModules() here because the component's static import
  // would point to a different module instance than the test's, desyncing the
  // signal store.
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

  test('renders both pills for a claude session with a resume id', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    expect(getByTestId('claude-view-toggle-ui')).toBeTruthy()
    expect(getByTestId('claude-view-toggle-terminal')).toBeTruthy()
  })

  test('terminal pill is disabled when resume id is missing', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session({ resumeSessionId: null })} sessionId="s-1" />
    ))
    const terminalBtn = getByTestId('claude-view-toggle-terminal') as HTMLButtonElement
    expect(terminalBtn.disabled).toBe(true)
    expect(terminalBtn.getAttribute('title')).toMatch(/send a message first/i)
  })

  test('terminal pill is enabled and has the run-claude tooltip when resume id is present', () => {
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    const terminalBtn = getByTestId('claude-view-toggle-terminal') as HTMLButtonElement
    expect(terminalBtn.disabled).toBe(false)
    expect(terminalBtn.getAttribute('title')).toMatch(/claude --resume/)
  })

  test('clicking Terminal switches the stored mode and updates the active class', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    const terminalBtn = getByTestId('claude-view-toggle-terminal') as HTMLButtonElement
    expect(sessionViewMode('s-1')).toBe('ui')

    fireEvent.click(terminalBtn)
    expect(sessionViewMode('s-1')).toBe('terminal')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('terminal')
    // Active state class flips to the terminal pill
    expect(terminalBtn.className).toMatch(/bg-accent\/20/)
  })

  test('clicking Terminal does nothing while disabled (no resume id)', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session({ resumeSessionId: null })} sessionId="s-1" />
    ))
    const terminalBtn = getByTestId('claude-view-toggle-terminal') as HTMLButtonElement
    fireEvent.click(terminalBtn)
    expect(sessionViewMode('s-1')).toBe('ui')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBeNull()
  })

  test('clicking UI restores the ui mode', async () => {
    const { sessionViewMode } = await import('../store/sessionViewMode')
    setSessionViewMode('s-1', 'terminal')
    const { getByTestId } = render(() => (
      <ClaudeViewToggle session={session()} sessionId="s-1" />
    ))
    fireEvent.click(getByTestId('claude-view-toggle-ui'))
    expect(sessionViewMode('s-1')).toBe('ui')
    expect(localStorage.getItem('verun:claudeViewMode:s-1')).toBe('ui')
  })
})
