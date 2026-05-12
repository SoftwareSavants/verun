import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'

interface MockSample {
  total: { rssBytes: number; cpuPct: number }
  app: { rssBytes: number; cpuPct: number }
  tasks: unknown[]
  sampledAtMs: number
}

const sampleSig = vi.hoisted(() => ({ current: null as MockSample | null }))

vi.mock('../store/resource-monitor', () => ({
  resourceSample: () => sampleSig.current,
}))

import { ResourceChip } from './ResourceChip'

describe('ResourceChip', () => {
  afterEach(() => { cleanup(); sampleSig.current = null })

  it('renders a dim placeholder when sample is null', () => {
    sampleSig.current = null
    const { getByTestId } = render(() => <ResourceChip onClick={() => {}} />)
    expect(getByTestId('resource-chip').textContent).toMatch(/RAM\s*-/)
  })

  it('renders formatted total RAM and CPU when sample present', () => {
    sampleSig.current = {
      total: { rssBytes: 1024 * 1024 * 1024 + 200 * 1024 * 1024, cpuPct: 32.4 },
      app: { rssBytes: 0, cpuPct: 0 },
      tasks: [],
      sampledAtMs: 0,
    }
    const { getByTestId } = render(() => <ResourceChip onClick={() => {}} />)
    const text = getByTestId('resource-chip').textContent ?? ''
    expect(text).toMatch(/1\.20 GB/)
    expect(text).toMatch(/32%/)
  })

  it('invokes onClick when clicked', () => {
    sampleSig.current = null
    const onClick = vi.fn()
    const { getByTestId } = render(() => <ResourceChip onClick={onClick} />)
    fireEvent.click(getByTestId('resource-chip'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
