import { describe, test, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMcpStatus: vi.fn(),
  authenticateMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
}))

vi.mock('../lib/ipc', () => mocks)

import { mcpServers, setSessionMcpServers, refreshMcpStatus, authenticateMcpServer, reconnectMcpServer, mcpActionPending } from './mcpServers'

describe('mcpServers store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('stores servers per session from init events', () => {
    setSessionMcpServers('s1', [{ name: 'linear', status: 'needs-auth' }])
    expect(mcpServers['s1']).toEqual([{ name: 'linear', status: 'needs-auth' }])
  })

  test('refresh replaces with live status', async () => {
    mocks.getMcpStatus.mockResolvedValue([{ name: 'linear', status: 'connected' }])
    await refreshMcpStatus('s1')
    expect(mocks.getMcpStatus).toHaveBeenCalledWith('s1')
    expect(mcpServers['s1']).toEqual([{ name: 'linear', status: 'connected' }])
  })

  test('refresh keeps the last known list when the session is not running', async () => {
    setSessionMcpServers('s2', [{ name: 'x', status: 'failed' }])
    mocks.getMcpStatus.mockRejectedValue('No active session')
    await refreshMcpStatus('s2')
    expect(mcpServers['s2']).toEqual([{ name: 'x', status: 'failed' }])
  })

  test('reconnect refreshes afterwards and tracks pending', async () => {
    let resolve!: () => void
    mocks.reconnectMcpServer.mockReturnValue(new Promise<void>(r => { resolve = r }))
    mocks.getMcpStatus.mockResolvedValue([{ name: 'x', status: 'connected' }])
    const p = reconnectMcpServer('s3', 'x')
    expect(mcpActionPending('s3', 'x')).toBe(true)
    resolve()
    await p
    expect(mcpActionPending('s3', 'x')).toBe(false)
    expect(mcpServers['s3']).toEqual([{ name: 'x', status: 'connected' }])
  })

  test('authenticate surfaces errors', async () => {
    mocks.authenticateMcpServer.mockRejectedValue('Server not found')
    await expect(authenticateMcpServer('s4', 'x')).resolves.toBe('Server not found')
    expect(mcpActionPending('s4', 'x')).toBe(false)
  })
})
