import { describe, test, expect, beforeEach } from 'vitest'
import {
  agents,
  setAgents,
  setActiveAgentId,
  runningAgents,
  activeAgent,
  agentById,
} from './agents'
import type { Agent } from '../types'

const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'test-1',
  name: 'agent-feature',
  status: 'running',
  repoPath: '/repo',
  worktreePath: '/repo-wt',
  branch: 'feature',
  prompt: 'do stuff',
  createdAt: 1000,
  lastActiveAt: 2000,
  ...overrides,
})

describe('agents store', () => {
  beforeEach(() => {
    setAgents([])
    setActiveAgentId(null)
  })

  test('starts empty', () => {
    expect(agents.length).toBe(0)
  })

  test('setAgents populates the store', () => {
    setAgents([makeAgent()])
    expect(agents.length).toBe(1)
    expect(agents[0].id).toBe('test-1')
  })

  test('runningAgents filters by status', () => {
    setAgents([
      makeAgent({ id: '1', status: 'running' }),
      makeAgent({ id: '2', status: 'idle' }),
      makeAgent({ id: '3', status: 'running' }),
      makeAgent({ id: '4', status: 'done' }),
    ])
    expect(runningAgents().length).toBe(2)
    expect(runningAgents().map(a => a.id)).toEqual(['1', '3'])
  })

  test('runningAgents returns empty when none running', () => {
    setAgents([
      makeAgent({ id: '1', status: 'idle' }),
      makeAgent({ id: '2', status: 'done' }),
    ])
    expect(runningAgents().length).toBe(0)
  })

  test('activeAgent returns the selected agent', () => {
    setAgents([
      makeAgent({ id: '1' }),
      makeAgent({ id: '2' }),
    ])
    setActiveAgentId('2')
    expect(activeAgent()?.id).toBe('2')
  })

  test('activeAgent returns undefined when no active id', () => {
    setAgents([makeAgent()])
    expect(activeAgent()).toBeUndefined()
  })

  test('activeAgent returns undefined when id not found', () => {
    setAgents([makeAgent({ id: '1' })])
    setActiveAgentId('nonexistent')
    expect(activeAgent()).toBeUndefined()
  })

  test('agentById finds the correct agent', () => {
    setAgents([
      makeAgent({ id: '1', name: 'first' }),
      makeAgent({ id: '2', name: 'second' }),
    ])
    expect(agentById('2')?.name).toBe('second')
  })

  test('agentById returns undefined for missing id', () => {
    setAgents([makeAgent()])
    expect(agentById('nope')).toBeUndefined()
  })
})
