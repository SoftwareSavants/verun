import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

vi.mock('../lib/ipc', () => ({}))

import { McpStatusChip } from './McpStatusChip'
import { setSessionMcpServers, unhideAllMcpServers } from '../store/mcpServers'

beforeEach(() => { localStorage.clear(); unhideAllMcpServers() })
afterEach(() => cleanup())

const connectors = ['Apollo.io', 'Attio', 'Google Drive'].map(n => ({ name: `claude.ai ${n}`, status: 'needs-auth' }))

describe('McpStatusChip', () => {
  test('nothing to show when every server is fine', () => {
    setSessionMcpServers('m1', [{ name: 'github', status: 'connected' }])
    const { container } = render(() => <McpStatusChip sessionId="m1" />)
    expect(container.textContent).toBe('')
  })

  test('a failed server leads; servers only waiting for sign-in stay quiet', () => {
    setSessionMcpServers('m2', [{ name: 'moyasar', status: 'failed', error: 'No endpoint' }, ...connectors])
    const { getByRole } = render(() => <McpStatusChip sessionId="m2" />)
    expect(getByRole('button', { name: /MCP/ }).textContent).toContain('1 MCP failed')
    cleanup()
    setSessionMcpServers('m3', connectors)
    const quiet = render(() => <McpStatusChip sessionId="m3" />)
    expect(quiet.getByRole('button', { name: /MCP/ }).textContent).toContain('3 MCP sign-ins')
  })

  test('the list separates failed from not signed in, with connector names', () => {
    setSessionMcpServers('m4', [{ name: 'moyasar', status: 'failed', error: 'No endpoint' }, ...connectors])
    const { getByRole, container } = render(() => <McpStatusChip sessionId="m4" />)
    fireEvent.click(getByRole('button', { name: /MCP/ }))
    const t = container.textContent ?? ''
    expect(t).toContain('Failed')
    expect(t).toContain('No endpoint')
    expect(getByRole('button', { name: 'Reconnect moyasar' })).toBeTruthy()
    // Optional connectors fold into one line until asked for.
    expect(t).toContain('Not signed in')
    expect(t).toContain('3 servers')
    expect(t).not.toContain('Google Drive')
    fireEvent.click(getByRole('button', { name: 'Show servers not signed in' }))
    expect(container.textContent).toContain('Google Drive')
    expect(getByRole('button', { name: 'Sign in to Attio' })).toBeTruthy()
  })

  test('hiding servers is remembered and can be undone', () => {
    setSessionMcpServers('m5', connectors)
    const { getByRole, container } = render(() => <McpStatusChip sessionId="m5" />)
    fireEvent.click(getByRole('button', { name: /MCP/ }))
    fireEvent.click(getByRole('button', { name: 'Hide all not signed in' }))
    // Down to a bare icon, still there to bring them back.
    expect(getByRole('button', { name: /MCP/ }).textContent).toBe('')
    expect(container.textContent).toContain('3 hidden')
    expect(JSON.parse(localStorage.getItem('verun:mcpHidden') ?? '[]')).toHaveLength(3)
    fireEvent.click(getByRole('button', { name: 'Show hidden' }))
    expect(getByRole('button', { name: /MCP/ }).textContent).toContain('3 MCP sign-ins')
  })
})
