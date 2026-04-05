import { describe, test, expect, beforeEach } from 'vitest'
import { sessions, setSessions, getSessionForAgent } from './sessions'
import type { Session } from '../types'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-1',
  agentId: 'agent-1',
  outputLines: [],
  startedAt: 1000,
  ...overrides,
})

describe('sessions store', () => {
  beforeEach(() => {
    setSessions({})
  })

  test('starts empty', () => {
    expect(Object.keys(sessions).length).toBe(0)
  })

  test('setSessions populates the store', () => {
    setSessions({ 'agent-1': makeSession() })
    expect(sessions['agent-1'].id).toBe('sess-1')
  })

  test('getSessionForAgent returns the session', () => {
    setSessions({ 'agent-1': makeSession({ id: 'sess-1' }) })
    const session = getSessionForAgent('agent-1')
    expect(session).toBeDefined()
    expect(session.id).toBe('sess-1')
  })

  test('getSessionForAgent returns undefined for missing agent', () => {
    const session = getSessionForAgent('nonexistent')
    expect(session).toBeUndefined()
  })

  test('multiple sessions keyed by agent id', () => {
    setSessions({
      'agent-1': makeSession({ id: 'sess-1', agentId: 'agent-1' }),
      'agent-2': makeSession({ id: 'sess-2', agentId: 'agent-2' }),
    })
    expect(getSessionForAgent('agent-1').id).toBe('sess-1')
    expect(getSessionForAgent('agent-2').id).toBe('sess-2')
  })

  test('session with output lines', () => {
    setSessions({
      'agent-1': makeSession({ outputLines: ['line 1', 'line 2'] }),
    })
    expect(getSessionForAgent('agent-1').outputLines).toEqual(['line 1', 'line 2'])
  })
})
