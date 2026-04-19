import { describe, test, expect } from 'vitest'
import { rebuildBlocks } from './ChatView'
import type { OutputItem } from '../types'

describe('rebuildBlocks turnEnd rendering', () => {
  test('error turnEnd (no prior errorMessage) renders a single error block with the message', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
      { kind: 'turnEnd', status: 'error', error: 'Prompt is too long' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const errors = blocks.filter(b => b.type === 'error')
    expect(errors.length).toBe(1)
    expect((errors[0] as { message: string }).message).toContain('Prompt is too long')
    // No duplicate system bubble for the same error.
    expect(blocks.some(b => b.type === 'system' && 'text' in b && b.text.includes('Prompt is too long'))).toBe(false)
  })

  test('synthetic errorMessage + matching turnEnd de-dupe to one error block', () => {
    // Regression: the CLI emits BOTH a synthetic assistant (→ errorMessage)
    // AND a result with status=error. Without de-dupe the user sees the
    // same error twice (assistant bubble + system bubble + banner).
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
      { kind: 'errorMessage', message: 'Prompt is too long', raw: '{"foo":1}' } as OutputItem,
      { kind: 'turnEnd', status: 'error', error: 'Prompt is too long' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const errors = blocks.filter(b => b.type === 'error')
    expect(errors.length).toBe(1)
    expect((errors[0] as { raw?: string }).raw).toBe('{"foo":1}')
    expect(blocks.some(b => b.type === 'assistant')).toBe(false)
  })

  test('error block carries turnIndex so retry can pick the right user message', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'first', timestamp: 1 } as OutputItem,
      { kind: 'turnEnd', status: 'completed' } as OutputItem,
      { kind: 'userMessage', text: 'second', timestamp: 2 } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: 401', raw: undefined } as OutputItem,
      { kind: 'turnEnd', status: 'error', error: 'API Error: 401' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const err = blocks.find(b => b.type === 'error') as { turnIndex: number } | undefined
    expect(err?.turnIndex).toBe(2)
  })

  test('interrupted turnEnd renders no bubble (user already hit stop)', () => {
    const items: OutputItem[] = [
      { kind: 'turnEnd', status: 'interrupted' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    expect(blocks.find(b => b.type === 'system')).toBeUndefined()
    expect(blocks.find(b => b.type === 'error')).toBeUndefined()
  })

  test('completed turnEnd renders no bubble', () => {
    const items: OutputItem[] = [
      { kind: 'turnEnd', status: 'completed' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    expect(blocks.find(b => b.type === 'system')).toBeUndefined()
    expect(blocks.find(b => b.type === 'error')).toBeUndefined()
  })
})
