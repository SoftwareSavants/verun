import { describe, test, expect, beforeEach } from 'vitest'
import { sessions, setSessions, outputLines, setOutputLines, sessionsForTask, sessionById, clearOutputLines } from './sessions'
import type { Session } from '../types'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's-001',
  taskId: 't-001',
  name: null,
  claudeSessionId: null,
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  ...overrides,
})

describe('sessions store', () => {
  beforeEach(() => {
    setSessions([])
    setOutputLines({})
  })

  test('starts empty', () => {
    expect(sessions.length).toBe(0)
  })

  test('setSessions populates the store', () => {
    setSessions([makeSession()])
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe('s-001')
  })

  test('sessionsForTask filters by task id', () => {
    setSessions([
      makeSession({ id: 's-1', taskId: 't-001' }),
      makeSession({ id: 's-2', taskId: 't-002' }),
      makeSession({ id: 's-3', taskId: 't-001' }),
    ])
    const filtered = sessionsForTask('t-001')
    expect(filtered.length).toBe(2)
    expect(filtered.map(s => s.id)).toEqual(['s-1', 's-3'])
  })

  test('sessionById finds the correct session', () => {
    setSessions([
      makeSession({ id: 's-1' }),
      makeSession({ id: 's-2' }),
    ])
    expect(sessionById('s-2')?.id).toBe('s-2')
  })

  test('sessionById returns undefined for missing id', () => {
    setSessions([makeSession()])
    expect(sessionById('nope')).toBeUndefined()
  })

  test('output lines stored by session id', () => {
    setOutputLines('s-001', ['line 1', 'line 2'])
    expect(outputLines['s-001']).toEqual(['line 1', 'line 2'])
  })

  test('clearOutputLines empties the array', () => {
    setOutputLines('s-001', ['line 1', 'line 2'])
    clearOutputLines('s-001')
    expect(outputLines['s-001']).toEqual([])
  })

  test('status update works', () => {
    setSessions([makeSession({ id: 's-1', status: 'running' })])
    setSessions(s => s.id === 's-1', 'status', 'done')
    expect(sessions[0].status).toBe('done')
  })
})
