import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { AgentSkill } from '../types'

const listAgentSkills = vi.fn<(agent: string, scan?: string, accountId?: string | null) => Promise<AgentSkill[]>>()

vi.mock('../lib/ipc', () => ({
  listAgentSkills: (agent: string, scan?: string, accountId?: string | null) =>
    listAgentSkills(agent, scan, accountId),
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

describe('skills cache per account', () => {
  beforeEach(() => {
    listAgentSkills.mockReset()
  })

  // No taskId: only the coarse (repo-wide) load runs, one call per context.
  const base = { agentKind: 'claude' as const, projectRoot: '/repo' }
  const skillsOf = (accountId?: string | null) =>
    Promise.resolve([{ name: `skill-of-${accountId ?? 'default'}`, description: '' }])

  test('skills cache is keyed by account', async () => {
    const { primeSkills, getSkills } = await freshModule()
    listAgentSkills.mockImplementation((_agent, _scan, accountId) => skillsOf(accountId))

    primeSkills({ ...base, accountId: 'a1' })
    primeSkills({ ...base, accountId: null })
    await flushMicrotasks()

    expect(listAgentSkills).toHaveBeenCalledTimes(2)
    expect(listAgentSkills).toHaveBeenCalledWith('claude', '/repo', 'a1')
    expect(listAgentSkills).toHaveBeenCalledWith('claude', '/repo', null)
    expect(getSkills({ ...base, accountId: 'a1' }).map(s => s.name)).toEqual(['skill-of-a1'])
    expect(getSkills({ ...base, accountId: null }).map(s => s.name)).toEqual(['skill-of-default'])
  })

  test('a context without an account shares the Default entry', async () => {
    const { primeSkills, getSkills } = await freshModule()
    listAgentSkills.mockImplementation((_agent, _scan, accountId) => skillsOf(accountId))

    primeSkills(base)
    primeSkills({ ...base, accountId: null })
    await flushMicrotasks()

    expect(listAgentSkills).toHaveBeenCalledTimes(1)
    expect(listAgentSkills).toHaveBeenCalledWith('claude', '/repo', null)
    expect(getSkills(base)).toEqual(getSkills({ ...base, accountId: null }))
  })

  test('task skills are keyed by account too', async () => {
    const { primeSkills, getSkills } = await freshModule()
    // The coarse load answers for the repo; the task load answers per worktree.
    listAgentSkills.mockImplementation((_agent, scan, accountId) =>
      Promise.resolve([{ name: `${scan}|${accountId ?? 'default'}`, description: '' }]),
    )
    const taskCtx = (accountId: string | null) => ({ ...ctx('task-1'), accountId })

    primeSkills(taskCtx('a1'))
    primeSkills(taskCtx(null))
    await flushMicrotasks()

    expect(getSkills(taskCtx('a1')).map(s => s.name)).toEqual(['/repo/.verun/worktrees/task-1|a1'])
    expect(getSkills(taskCtx(null)).map(s => s.name)).toEqual(['/repo/.verun/worktrees/task-1|default'])
  })

  test('dropTaskSkills drops the task entries of every account', async () => {
    const { primeSkills, getSkills, dropTaskSkills } = await freshModule()
    listAgentSkills.mockImplementation((_agent, scan, accountId) =>
      Promise.resolve(
        scan === '/repo'
          ? [{ name: 'coarse', description: '' }]
          : [{ name: `fine-${accountId ?? 'default'}`, description: '' }],
      ),
    )
    const taskCtx = (accountId: string | null) => ({ ...ctx('task-1'), accountId })

    primeSkills(taskCtx('a1'))
    primeSkills(taskCtx(null))
    await flushMicrotasks()
    expect(getSkills(taskCtx('a1')).map(s => s.name)).toEqual(['fine-a1'])

    dropTaskSkills('task-1')
    expect(getSkills(taskCtx('a1')).map(s => s.name)).toEqual(['coarse'])
    expect(getSkills(taskCtx(null)).map(s => s.name)).toEqual(['coarse'])
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
