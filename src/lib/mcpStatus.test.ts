import { describe, test, expect } from 'vitest'
import { mcpServersNeedingAttention, mcpServerAction } from './mcpStatus'

describe('mcpStatus', () => {
  const servers = [
    { name: 'github', status: 'connected' },
    { name: 'linear', status: 'needs-auth' },
    { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
    { name: 'off', status: 'disabled' },
    { name: 'slow', status: 'pending' },
  ]

  test('only failed and needs-auth servers need attention', () => {
    expect(mcpServersNeedingAttention(servers).map(s => s.name)).toEqual(['linear', 'broken'])
    expect(mcpServersNeedingAttention(undefined)).toEqual([])
  })

  test('picks the action for each status', () => {
    expect(mcpServerAction('needs-auth')).toBe('authenticate')
    expect(mcpServerAction('failed')).toBe('reconnect')
    expect(mcpServerAction('connected')).toBe(null)
  })
})
