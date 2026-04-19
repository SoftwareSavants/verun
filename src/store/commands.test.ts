import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { AgentSkill } from '../types'

const listAgentSkills = vi.fn<(agent: string, scan?: string) => Promise<AgentSkill[]>>()

vi.mock('../lib/ipc', () => ({
  listAgentSkills: (agent: string, scan?: string) => listAgentSkills(agent, scan),
}))

const flushMicrotasks = () => new Promise(r => setTimeout(r, 0))

async function freshModule() {
  vi.resetModules()
  return await import('./commands')
}

const ctx = (taskId: string) => ({
  agentKind: 'claude' as const,
  projectRoot: '/repo',
  taskId,
  worktreePath: `/repo/.verun/worktrees/${taskId}`,
})

describe('primeSkills coarse cache', () => {
  beforeEach(() => {
    listAgentSkills.mockReset()
  })

  test('concurrent primeSkills calls only trigger one coarse fetch', async () => {
    const { primeSkills } = await freshModule()
    listAgentSkills.mockImplementation(() => new Promise<AgentSkill[]>(() => {}))

    primeSkills(ctx('task-1'))
    primeSkills(ctx('task-1'))
    primeSkills(ctx('task-1'))

    const coarseCalls = listAgentSkills.mock.calls.filter(c => c[1] === '/repo').length
    expect(coarseCalls).toBe(1)
  })
})

describe('dropTaskSkills', () => {
  beforeEach(() => {
    listAgentSkills.mockReset()
  })

  test('removes fine-cached entries so getSkills falls back to coarse cache', async () => {
    const { primeSkills, getSkills, dropTaskSkills } = await freshModule()
    listAgentSkills.mockImplementation((_agent, scan) =>
      Promise.resolve(
        scan === '/repo'
          ? [{ name: 'coarse-only', description: '' }]
          : [{ name: 'fine-only', description: '' }],
      ),
    )

    primeSkills(ctx('task-1'))
    await flushMicrotasks()
    expect(getSkills(ctx('task-1')).some(s => s.name === 'fine-only')).toBe(true)

    dropTaskSkills('task-1')
    expect(getSkills(ctx('task-1')).some(s => s.name === 'fine-only')).toBe(false)
    expect(getSkills(ctx('task-1')).some(s => s.name === 'coarse-only')).toBe(true)
  })
})
