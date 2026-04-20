import { describe, test, expect, beforeEach } from 'vitest'
import { produce } from 'solid-js/store'
import {
  planModeForSession,
  setPlanModeForSession,
  thinkingModeForSession,
  setThinkingModeForSession,
  fastModeForSession,
  setFastModeForSession,
  planFilePathForSession,
  setPlanFilePathForSession,
  clearSessionContext,
  sessionContexts,
  setSessionContexts,
} from './sessionContext'

describe('sessionContext store', () => {
  beforeEach(() => {
    localStorage.clear()
    setSessionContexts(produce(store => {
      for (const k of Object.keys(store)) delete store[k]
    }))
  })

  test('defaults match prior task-level behavior', () => {
    expect(planModeForSession('s-1')).toBe(false)
    expect(thinkingModeForSession('s-1')).toBe(true)
    expect(fastModeForSession('s-1')).toBe(false)
    expect(planFilePathForSession('s-1')).toBe(null)
  })

  test('setters isolate by session id', () => {
    setPlanModeForSession('s-1', true)
    setThinkingModeForSession('s-1', false)
    setFastModeForSession('s-1', true)
    setPlanFilePathForSession('s-1', '/tmp/plan.md')

    expect(planModeForSession('s-1')).toBe(true)
    expect(thinkingModeForSession('s-1')).toBe(false)
    expect(fastModeForSession('s-1')).toBe(true)
    expect(planFilePathForSession('s-1')).toBe('/tmp/plan.md')

    expect(planModeForSession('s-2')).toBe(false)
    expect(thinkingModeForSession('s-2')).toBe(true)
    expect(fastModeForSession('s-2')).toBe(false)
    expect(planFilePathForSession('s-2')).toBe(null)
  })

  test('setters persist to localStorage under verun:sessionContext:<sid>', () => {
    setPlanModeForSession('s-1', true)
    setPlanFilePathForSession('s-1', '/tmp/plan.md')

    const raw = localStorage.getItem('verun:sessionContext:s-1')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.planMode).toBe(true)
    expect(parsed.planFilePath).toBe('/tmp/plan.md')
    expect(parsed.thinkingMode).toBe(true)
    expect(parsed.fastMode).toBe(false)
  })

  test('hydration from localStorage on first read', () => {
    localStorage.setItem(
      'verun:sessionContext:s-9',
      JSON.stringify({ planMode: true, thinkingMode: false, fastMode: true, planFilePath: '/x.md' }),
    )

    expect(planModeForSession('s-9')).toBe(true)
    expect(thinkingModeForSession('s-9')).toBe(false)
    expect(fastModeForSession('s-9')).toBe(true)
    expect(planFilePathForSession('s-9')).toBe('/x.md')
  })

  test('clearSessionContext removes store entry and storage key', () => {
    setPlanModeForSession('s-1', true)
    setPlanFilePathForSession('s-1', '/tmp/plan.md')
    expect(localStorage.getItem('verun:sessionContext:s-1')).not.toBeNull()

    clearSessionContext('s-1')

    expect(sessionContexts['s-1']).toBeUndefined()
    expect(localStorage.getItem('verun:sessionContext:s-1')).toBeNull()
    expect(planModeForSession('s-1')).toBe(false)
  })

  test('setPlanFilePathForSession(null) clears the field', () => {
    setPlanFilePathForSession('s-1', '/tmp/plan.md')
    setPlanFilePathForSession('s-1', null)
    expect(planFilePathForSession('s-1')).toBe(null)
    const raw = localStorage.getItem('verun:sessionContext:s-1')
    expect(JSON.parse(raw!).planFilePath).toBe(null)
  })
})
