import { describe, test, expect } from 'vitest'
import type { OutputItem } from '../types'
import {
  mergeAgentProgress,
  isTaskFinished,
  agentActivityLine,
  formatElapsed,
  runningBackgroundTasks,
  agentState,
  agentFinalText,
  agentTypeLabel,
} from './subagents'

describe('agentFinalText', () => {
  test('a foreground agent reports through its tool result', () => {
    expect(agentFinalText({ taskId: 't', status: 'completed', summary: 'Agent finished' }, { text: 'Report body', isError: false })).toBe('Report body')
  })
  test('a background agent reports through its task summary', () => {
    expect(agentFinalText({ taskId: 't', status: 'completed', isBackgrounded: true, summary: 'Found 3 bugs' }, { text: 'Async agent launched', isError: false })).toBe('Found 3 bugs')
  })
  test('falls back to whichever exists', () => {
    expect(agentFinalText(undefined, { text: 'r', isError: false })).toBe('r')
    expect(agentFinalText({ taskId: 't', summary: 's' }, undefined)).toBe('s')
    expect(agentFinalText(undefined, undefined)).toBe('')
  })
})

const progress = (p: object) => ({ kind: 'agentProgress', ...p }) as unknown as OutputItem

describe('mergeAgentProgress', () => {
  test('later fields win and missing ones keep their earlier value', () => {
    const a = mergeAgentProgress(undefined, { taskId: 't', status: 'running', description: 'Review', toolUses: 1 })
    const b = mergeAgentProgress(a, { taskId: 't', toolUses: 3, summary: 'reading a.ts' })
    expect(b).toEqual({ taskId: 't', status: 'running', description: 'Review', toolUses: 3, summary: 'reading a.ts' })
    expect(a.toolUses).toBe(1)
  })
})

test('isTaskFinished', () => {
  expect(isTaskFinished('running')).toBe(false)
  expect(isTaskFinished(undefined)).toBe(false)
  for (const s of ['completed', 'failed', 'stopped', 'killed', 'cancelled', 'error']) expect(isTaskFinished(s)).toBe(true)
})

describe('agentActivityLine', () => {
  test('tools, tokens and the current action', () => {
    // What it is doing now leads; the counts are secondary.
    expect(agentActivityLine({ taskId: 't', toolUses: 12, totalTokens: 41_200, summary: 'reading types.ts' }))
      .toBe('reading types.ts · 12 tools · 41k tokens')
  })
  test('falls back to the last tool name and singular tool', () => {
    expect(agentActivityLine({ taskId: 't', toolUses: 1, lastToolName: 'Read' })).toBe('Read · 1 tool')
  })
  test('empty without progress', () => {
    expect(agentActivityLine({ taskId: 't' })).toBe('')
  })
})

test('formatElapsed', () => {
  expect(formatElapsed(4_000)).toBe('4s')
  expect(formatElapsed(75_000)).toBe('1m 15s')
  expect(formatElapsed(3_720_000)).toBe('1h 2m')
})

describe('agentState', () => {
  test('progress status wins over the tool result', () => {
    expect(agentState({ progress: { taskId: 't', status: 'running' }, result: { text: 'Async agent launched', isError: false } }).state).toBe('running')
  })
  test('running without progress counters is starting', () => {
    expect(agentState({ progress: { taskId: 't', status: 'running' } }).state).toBe('running')
    expect(agentState({ progress: { taskId: 't', status: 'running' } }).starting).toBe(true)
  })
  test('backgrounded running tasks say so', () => {
    expect(agentState({ progress: { taskId: 't', status: 'running', isBackgrounded: true, toolUses: 2 } })).toMatchObject({ state: 'background', starting: false })
  })
  test('pending approval inside the agent means it needs input', () => {
    expect(agentState({ progress: { taskId: 't', status: 'running' }, needsInput: true }).state).toBe('needs-input')
  })
  test('finished statuses', () => {
    expect(agentState({ progress: { taskId: 't', status: 'completed' } }).state).toBe('done')
    expect(agentState({ progress: { taskId: 't', status: 'failed' } }).state).toBe('failed')
    expect(agentState({ progress: { taskId: 't', status: 'killed' } }).state).toBe('stopped')
  })
  test('without progress it reads the tool result, or the session for a live call', () => {
    expect(agentState({ result: { text: 'ok', isError: false } }).state).toBe('done')
    expect(agentState({ result: { text: 'no', isError: true } }).state).toBe('failed')
    expect(agentState({ sessionLive: true }).state).toBe('running')
    expect(agentState({ sessionLive: false }).state).toBe('stopped')
  })
})

describe('runningBackgroundTasks', () => {
  test('one entry per still-running task, agents and shells, in start order', () => {
    const items: OutputItem[] = [
      progress({ taskId: 'a', toolUseId: 'toolu_A', status: 'running', taskType: 'local_agent', description: 'Review' }),
      { kind: 'text', text: 'x' } as OutputItem,
      progress({ taskId: 'b', status: 'running', taskType: 'local_bash', description: 'pnpm dev' }),
      progress({ taskId: 'c', status: 'running', description: 'done soon' }),
      progress({ taskId: 'a', toolUses: 4 }),
      progress({ taskId: 'c', status: 'completed' }),
    ]
    const tasks = runningBackgroundTasks(items)
    expect(tasks.map(t => t.taskId)).toEqual(['a', 'b'])
    expect(tasks[0]).toMatchObject({ toolUseId: 'toolu_A', toolUses: 4 })
  })
  test('ignores progress nested inside subagent items', () => {
    expect(runningBackgroundTasks([{ kind: 'subagent', parentToolUseId: 'p', item: progress({ taskId: 'z', status: 'running' }) } as unknown as OutputItem])).toEqual([])
  })
})

describe('agentTypeLabel', () => {
  test("an Agent call without a type runs Claude's general-purpose agent, so it is named that", () => {
    expect(agentTypeLabel(undefined)).toBe('general-purpose')
    expect(agentTypeLabel('')).toBe('general-purpose')
    expect(agentTypeLabel('code-reviewer')).toBe('code-reviewer')
  })
})
