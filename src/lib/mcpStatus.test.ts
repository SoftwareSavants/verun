import { describe, test, expect } from 'vitest'
import { mcpServersNeedingAttention, mcpServerAction, mcpProblemGroups, mcpDisplayName } from './mcpStatus'

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

  test('groups problems into failed and not signed in, leaving hidden ones out', () => {
    const g = mcpProblemGroups(servers, new Set(['linear']))
    expect(g.failed.map(s => s.name)).toEqual(['broken'])
    expect(g.signIn).toEqual([])
    expect(g.hidden).toBe(1)
    expect(mcpProblemGroups(servers, new Set()).signIn.map(s => s.name)).toEqual(['linear'])
  })

  test('claude.ai connectors read by their own name', () => {
    expect(mcpDisplayName('claude.ai Google Drive')).toEqual({ name: 'Google Drive', source: 'claude.ai' })
    expect(mcpDisplayName('github')).toEqual({ name: 'github', source: undefined })
  })
})
