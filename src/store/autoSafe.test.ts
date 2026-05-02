import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../lib/ipc', () => ({
  getAutoSafePolicy: vi.fn(),
  setAutoSafePolicy: vi.fn(),
  getProjectAutoSafeOverride: vi.fn(),
  setProjectAutoSafeOverride: vi.fn(),
}))

import * as ipc from '../lib/ipc'
import { autoSafe, hydrateAutoSafe, updateGlobal, updateProjectOverride } from './autoSafe'
import type { AutoSafePolicy } from '../types'

const baseGlobal: AutoSafePolicy = {
  version: 1,
  read: { scope: 'repo' },
  write: { scope: 'worktree' },
  websearch: { mode: 'ask' },
  webfetch: { mode: 'ask', domains: [] },
  mcp: { mode: 'ask', servers: [] },
  bash: { patterns: [] },
}

describe('autoSafe store', () => {
  beforeEach(async () => {
    // Deep-clone so previous test mutations to the proxied object can't
    // leak into the next mock return value.
    const fresh = () => JSON.parse(JSON.stringify(baseGlobal)) as AutoSafePolicy
    ;(ipc.getAutoSafePolicy as any).mockImplementation(async () => ({ global: fresh(), defaults: fresh() }))
    ;(ipc.setAutoSafePolicy as any).mockResolvedValue(undefined)
    ;(ipc.setProjectAutoSafeOverride as any).mockResolvedValue(undefined)
    await hydrateAutoSafe()
    for (const k of Object.keys(autoSafe.overrides)) {
      // eslint-disable-next-line no-await-in-loop
      await updateProjectOverride(k, null)
    }
  })

  it('hydrate populates global', async () => {
    await hydrateAutoSafe()
    expect(autoSafe.global).toEqual(baseGlobal)
    expect(autoSafe.hydrated).toBe(true)
  })

  it('updateGlobal optimistically swaps state and calls ipc', async () => {
    await hydrateAutoSafe()
    const next: AutoSafePolicy = { ...baseGlobal, websearch: { mode: 'allow' } }
    await updateGlobal(next)
    expect(autoSafe.global.websearch.mode).toBe('allow')
    expect(ipc.setAutoSafePolicy).toHaveBeenCalledWith(next)
  })

  it('updateGlobal rolls back on ipc failure', async () => {
    await hydrateAutoSafe()
    ;(ipc.setAutoSafePolicy as any).mockRejectedValueOnce(new Error('boom'))
    const next: AutoSafePolicy = { ...baseGlobal, websearch: { mode: 'allow' } }
    await expect(updateGlobal(next)).rejects.toThrow('boom')
    expect(autoSafe.global.websearch.mode).toBe('ask')
  })

  it('updateProjectOverride stores per-project override locally', async () => {
    await updateProjectOverride('p-1', {
      version: 1,
      websearch: { mode: 'allow' },
    })
    expect(autoSafe.overrides['p-1']?.websearch?.mode).toBe('allow')
    expect(ipc.setProjectAutoSafeOverride).toHaveBeenCalledWith('p-1', expect.any(Object))
  })

  it('updateProjectOverride with null clears entry', async () => {
    await updateProjectOverride('p-1', { version: 1, websearch: { mode: 'allow' } })
    await updateProjectOverride('p-1', null)
    expect(autoSafe.overrides['p-1']).toBeUndefined()
  })
})
