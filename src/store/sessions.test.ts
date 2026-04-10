import { describe, test, expect, beforeEach } from 'vitest'
import { sessions, setSessions, outputItems, setOutputItems, sessionsForTask, sessionById } from './sessions'
import type { Session, OutputItem } from '../types'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's-001',
  taskId: 't-001',
  name: null,
  claudeSessionId: null,
  status: 'idle',
  startedAt: 1000,
  endedAt: null,
  totalCost: 0,
  ...overrides,
})

describe('sessions store', () => {
  beforeEach(() => {
    setSessions([])
    setOutputItems({})
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

  test('output items stored by session id', () => {
    const items: OutputItem[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'thinking', text: 'hmm' },
    ]
    setOutputItems('s-001', items)
    expect(outputItems['s-001']).toEqual(items)
  })

  test('setOutputItems can clear to empty', () => {
    setOutputItems('s-001', [{ kind: 'text', text: 'hello' }])
    setOutputItems('s-001', [])
    expect(outputItems['s-001']).toEqual([])
  })

  test('status update works', () => {
    setSessions([makeSession({ id: 's-1', status: 'running' })])
    setSessions(s => s.id === 's-1', 'status', 'idle')
    expect(sessions[0].status).toBe('idle')
  })
})
