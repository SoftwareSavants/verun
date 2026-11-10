import { describe, test, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import type { OutputItem } from '../types'

const reveal = vi.fn()
vi.mock('./AgentBlockView', async (orig) => ({ ...(await orig<typeof import('./AgentBlockView')>()), revealAgent: (id: string) => reveal(id) }))

import { AgentStrip } from './AgentStrip'

afterEach(() => { cleanup(); reveal.mockReset() })

const progress = (p: object) => ({ kind: 'agentProgress', ...p }) as unknown as OutputItem
const items: OutputItem[] = [
  { kind: 'toolStart', tool: 'Agent', input: '{"subagent_type":"code-reviewer"}', id: 'toolu_A' } as unknown as OutputItem,
  progress({ taskId: 'a', toolUseId: 'toolu_A', status: 'running', taskType: 'local_agent', description: 'Review diff', toolUses: 3, summary: 'reading a.ts' }),
  progress({ taskId: 'b', toolUseId: 'toolu_S', status: 'running', taskType: 'local_bash', description: 'pnpm dev' }),
  progress({ taskId: 'c', toolUseId: 'toolu_C', status: 'completed', description: 'Finished one' }),
]

describe('AgentStrip', () => {
  test('hidden unless the session is in the background state', () => {
    const { container } = render(() => <AgentStrip status="idle" items={items} />)
    expect(container.textContent).toBe('')
  })

  test('one row per still-running agent and shell', () => {
    const { container } = render(() => <AgentStrip status="background" items={items} />)
    const text = container.textContent ?? ''
    expect(text).toContain('code-reviewer')
    expect(text).toContain('Review diff')
    expect(text).toContain('reading a.ts')
    expect(text).toContain('shell')
    expect(text).toContain('pnpm dev')
    expect(text).not.toContain('Finished one')
    // One row per task; the rows say what runs, no separate heading.
    expect(text).not.toContain('Running in background')
  })

  test("clicking an agent row reveals that agent's block", () => {
    const { getByRole } = render(() => <AgentStrip status="background" items={items} />)
    fireEvent.click(getByRole('button', { name: /Review diff/ }))
    expect(reveal).toHaveBeenCalledWith('toolu_A')
  })

  test('without task data it still says background work is running', () => {
    const { container } = render(() => <AgentStrip status="background" items={[]} />)
    expect(container.textContent).toContain('Running in background')
  })
})
