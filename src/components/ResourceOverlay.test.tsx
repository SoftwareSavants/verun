import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

const sampleSig = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../store/resource-monitor', () => ({
  resourceSample: () => sampleSig.current,
  setResourceSample: vi.fn(),
}))

const ipcMocks = vi.hoisted(() => ({
  setResourceMonitorOverlayOpen: vi.fn().mockResolvedValue(undefined),
  getResourceUsageNow: vi.fn().mockResolvedValue({
    total: { rssBytes: 0, cpuPct: 0 },
    app: { rssBytes: 0, cpuPct: 0 },
    tasks: [],
    sampledAtMs: 0,
  }),
}))
vi.mock('../lib/ipc', () => ipcMocks)

import { ResourceOverlay } from './ResourceOverlay'

describe('ResourceOverlay', () => {
  afterEach(() => {
    cleanup()
    sampleSig.current = null
    vi.clearAllMocks()
  })

  it('renders nothing when closed', () => {
    const { container } = render(() => <ResourceOverlay open={false} onClose={() => {}} />)
    expect(container.querySelector('[data-testid="resource-overlay"]')).toBeNull()
  })

  it('on open: calls setResourceMonitorOverlayOpen(true) and getResourceUsageNow', () => {
    render(() => <ResourceOverlay open={true} onClose={() => {}} />)
    expect(ipcMocks.setResourceMonitorOverlayOpen).toHaveBeenCalledWith(true)
    expect(ipcMocks.getResourceUsageNow).toHaveBeenCalled()
  })

  it('renders task rows with name + branch stacked, in arrival order', () => {
    sampleSig.current = {
      total: { rssBytes: 1_500_000_000, cpuPct: 50 },
      app: { rssBytes: 200_000_000, cpuPct: 5 },
      tasks: [
        { taskId: 'b', taskName: 'Big', branch: 'big-branch', pid: 2, rssBytes: 800_000_000, cpuPct: 30 },
        { taskId: 'c', taskName: 'Mid', branch: 'mid-branch', pid: 3, rssBytes: 400_000_000, cpuPct: 14 },
        { taskId: 'a', taskName: 'Small', branch: 'small-branch', pid: 1, rssBytes: 100_000_000, cpuPct: 1 },
      ],
      sampledAtMs: 0,
    }
    const { getAllByTestId } = render(() => <ResourceOverlay open={true} onClose={() => {}} />)
    const rows = getAllByTestId('resource-task-row')
    expect(rows.length).toBe(3)
    expect(rows[0].textContent).toContain('Big')
    expect(rows[0].textContent).toContain('big-branch')
    expect(rows[1].textContent).toContain('Mid')
    expect(rows[1].textContent).toContain('mid-branch')
    expect(rows[2].textContent).toContain('Small')
    expect(rows[2].textContent).toContain('small-branch')
  })

  it('does not render a branch line when branch is empty', () => {
    sampleSig.current = {
      total: { rssBytes: 100, cpuPct: 0 },
      app: { rssBytes: 0, cpuPct: 0 },
      tasks: [
        { taskId: 'a', taskName: 'New task', branch: '', pid: 1, rssBytes: 100, cpuPct: 0 },
      ],
      sampledAtMs: 0,
    }
    const { getAllByTestId } = render(() => <ResourceOverlay open={true} onClose={() => {}} />)
    const row = getAllByTestId('resource-task-row')[0]
    expect(row.textContent).toContain('New task')
    const nameCell = row.firstElementChild as HTMLElement
    expect(nameCell.children.length).toBe(1)
  })

  it('renders the app row separately with formatted bytes', () => {
    sampleSig.current = {
      total: { rssBytes: 500_000_000, cpuPct: 5 },
      app: { rssBytes: 200_000_000, cpuPct: 2.5 },
      tasks: [],
      sampledAtMs: 0,
    }
    const { getByTestId } = render(() => <ResourceOverlay open={true} onClose={() => {}} />)
    const overlay = getByTestId('resource-overlay')
    expect(overlay.textContent).toMatch(/Verun \(app\)/)
    expect(overlay.textContent).toMatch(/191 MB/)
  })
})
