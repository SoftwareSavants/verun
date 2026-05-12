import { describe, it, expect, vi, beforeEach } from 'vitest'

interface ListenEntry {
  event: string
  cb: (e: { payload: unknown }) => void
}

const captured: ListenEntry[] = []
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    captured.push({ event, cb })
    return Promise.resolve(() => {})
  }),
}))

describe('resource-monitor store', () => {
  beforeEach(() => {
    captured.length = 0
    vi.resetModules()
  })

  it('starts with a null signal', async () => {
    const { resourceSample } = await import('./resource-monitor')
    expect(resourceSample()).toBeNull()
  })

  it('subscribes to resource_usage events on init and updates the signal', async () => {
    const { resourceSample, initResourceMonitor } = await import('./resource-monitor')
    await initResourceMonitor()
    const entry = captured.find(c => c.event === 'resource_usage')
    expect(entry).toBeDefined()
    entry!.cb({ payload: {
      total: { rssBytes: 1000, cpuPct: 2.5 },
      app: { rssBytes: 200, cpuPct: 0.5 },
      tasks: [],
      sampledAtMs: 42,
    } })
    expect(resourceSample()?.total.rssBytes).toBe(1000)
    expect(resourceSample()?.sampledAtMs).toBe(42)
  })

  it('initResourceMonitor is idempotent', async () => {
    const { initResourceMonitor } = await import('./resource-monitor')
    await initResourceMonitor()
    await initResourceMonitor()
    const matches = captured.filter(c => c.event === 'resource_usage')
    expect(matches.length).toBe(1)
  })
})
