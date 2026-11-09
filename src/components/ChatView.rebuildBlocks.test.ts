import { describe, test, expect } from 'vitest'
import { rebuildBlocks, createBlockBuilder } from './ChatView'
import type { OutputItem } from '../types'

/** The (single) error block a transcript builds. */
function errorBlock(items: OutputItem[]) {
  const err = rebuildBlocks(items).find(b => b.type === 'error')
  if (!err || err.type !== 'error') throw new Error('no error block')
  return err
}

describe('rebuildBlocks with backend-merged deltas', () => {
  test('one merged delta per run renders the same blocks as per-token deltas', () => {
    // stream.rs merges adjacent text/thinking deltas before emitting and
    // persisting; the blocks must not depend on how a run was split.
    const tool = { kind: 'toolStart', tool: 'Read', input: '{}' } as OutputItem
    const perToken: OutputItem[] = [
      { kind: 'userMessage', text: 'hi', timestamp: 1 } as OutputItem,
      { kind: 'thinking', text: 'Let ' } as OutputItem,
      { kind: 'thinking', text: 'me see' } as OutputItem,
      { kind: 'text', text: 'Hel' } as OutputItem,
      { kind: 'text', text: 'lo' } as OutputItem,
      tool,
      { kind: 'text', text: 'Do' } as OutputItem,
      { kind: 'text', text: 'ne' } as OutputItem,
      { kind: 'turnEnd', status: 'completed' } as OutputItem,
    ]
    const merged: OutputItem[] = [
      perToken[0],
      { kind: 'thinking', text: 'Let me see' } as OutputItem,
      { kind: 'text', text: 'Hello' } as OutputItem,
      tool,
      { kind: 'text', text: 'Done' } as OutputItem,
      perToken[8],
    ]
    expect(rebuildBlocks(merged)).toEqual(rebuildBlocks(perToken))
  })
})

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

describe('rebuildBlocks scheduled wakeups (issue #230)', () => {
  test('userMessage with wakeupReason renders a wakeup block, not a user bubble', () => {
    const items: OutputItem[] = [
      {
        kind: 'userMessage',
        text: 'Check the build now',
        wakeupReason: 'polling CI',
        timestamp: 1,
      } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const wakeup = blocks.find(b => b.type === 'wakeup') as
      | { type: 'wakeup'; prompt: string; reason?: string }
      | undefined
    expect(wakeup).toBeDefined()
    expect(wakeup!.prompt).toBe('Check the build now')
    expect(wakeup!.reason).toBe('polling CI')
    expect(blocks.find(b => b.type === 'user')).toBeUndefined()
  })

  test('userMessage without wakeupReason still renders as a user bubble', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    expect(blocks.find(b => b.type === 'user')).toBeDefined()
    expect(blocks.find(b => b.type === 'wakeup')).toBeUndefined()
  })

  test('transcriptUserMessage with isMeta=true renders as a wakeup block', () => {
    const items: OutputItem[] = [
      {
        kind: 'transcriptUserMessage',
        text: 'Check if there are any local changes',
        isMeta: true,
      } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    expect(blocks.find(b => b.type === 'wakeup')).toBeDefined()
    expect(blocks.find(b => b.type === 'user')).toBeUndefined()
  })

  test('transcriptUserMessage without isMeta renders as a user bubble', () => {
    const items: OutputItem[] = [
      { kind: 'transcriptUserMessage', text: 'a real human typed this' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    expect(blocks.find(b => b.type === 'user')).toBeDefined()
    expect(blocks.find(b => b.type === 'wakeup')).toBeUndefined()
  })
})

describe('rebuildBlocks codex plan/diff updates', () => {
  test('planUpdate renders a plan block with the latest items', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'design rate limiter', timestamp: 1 } as OutputItem,
      {
        kind: 'planUpdate',
        items: [
          { status: 'completed', step: 'Survey existing middleware' },
          { status: 'in_progress', step: 'Draft token bucket' },
        ],
        explanation: 'Working through the plan.',
      } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const plan = blocks.find(b => b.type === 'plan') as
      | { type: 'plan'; items: Array<{ step: string }>; explanation?: string }
      | undefined
    expect(plan).toBeDefined()
    expect(plan!.items).toHaveLength(2)
    expect(plan!.items[1].step).toBe('Draft token bucket')
    expect(plan!.explanation).toBe('Working through the plan.')
  })

  test('multiple planUpdates collapse — only the latest renders', () => {
    const items: OutputItem[] = [
      { kind: 'planUpdate', items: [{ status: 'in_progress', step: 'A' }] } as OutputItem,
      { kind: 'planUpdate', items: [{ status: 'completed', step: 'A' }, { status: 'in_progress', step: 'B' }] } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const plans = blocks.filter(b => b.type === 'plan')
    expect(plans.length).toBe(1)
    expect((plans[0] as { items: Array<{ step: string }> }).items).toHaveLength(2)
  })

  test('diffUpdate renders a diff block', () => {
    const items: OutputItem[] = [
      { kind: 'diffUpdate', diff: 'diff --git a/x b/x\n+new line\n' } as OutputItem,
    ]
    const blocks = rebuildBlocks(items)
    const diff = blocks.find(b => b.type === 'diff') as { type: 'diff'; diff: string } | undefined
    expect(diff).toBeDefined()
    expect(diff!.diff).toContain('+new line')
  })
})

describe('error block hasProgress (mid-turn vs first-shot detection for retry)', () => {
  test('returns false when error fires before any assistant content', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: ConnectionRefused' } as OutputItem,
      { kind: 'turnEnd', status: 'error', error: 'API Error: ConnectionRefused' } as OutputItem,
    ]
    expect(errorBlock(items).hasProgress).toBe(false)
  })

  test('returns true when assistant text streamed before the error', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
      { kind: 'text', text: 'partial response' } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: ConnectionRefused' } as OutputItem,
    ]
    expect(errorBlock(items).hasProgress).toBe(true)
  })

  test('returns true when tool calls happened before the error (mid-loop failure)', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'do work', timestamp: 1 } as OutputItem,
      { kind: 'toolStart', tool: 'Read', input: '{}' } as OutputItem,
      { kind: 'toolResult', text: 'file contents', isError: false } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: ConnectionRefused' } as OutputItem,
    ]
    expect(errorBlock(items).hasProgress).toBe(true)
  })

  test('returns true when only thinking was produced before the error', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'hello', timestamp: 1 } as OutputItem,
      { kind: 'thinking', text: 'pondering' } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: ConnectionRefused' } as OutputItem,
    ]
    expect(errorBlock(items).hasProgress).toBe(true)
  })

  test('does not count progress from earlier completed turns', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'first', timestamp: 1 } as OutputItem,
      { kind: 'text', text: 'first response' } as OutputItem,
      { kind: 'turnEnd', status: 'completed' } as OutputItem,
      { kind: 'userMessage', text: 'second', timestamp: 2 } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: ConnectionRefused' } as OutputItem,
    ]
    expect(errorBlock(items).hasProgress).toBe(false)
  })

  test('error block carries the message of its own turn for retry', () => {
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'first', timestamp: 1 } as OutputItem,
      { kind: 'turnEnd', status: 'completed' } as OutputItem,
      { kind: 'userMessage', text: 'second', timestamp: 2 } as OutputItem,
      { kind: 'errorMessage', message: 'API Error: 401' } as OutputItem,
    ]
    expect(errorBlock(items).retryText).toBe('second')
  })

  test('an error before any user message has nothing to retry', () => {
    const items: OutputItem[] = [{ kind: 'errorMessage', message: 'boom' } as OutputItem]
    expect(errorBlock(items).retryText).toBeUndefined()
  })
})

describe('rebuildBlocks user attachments', () => {
  test('a user message carries its files to the block', () => {
    const file = { hash: 'h', mimeType: 'text/markdown', name: 'Handoff.md', size: 1 }
    const blocks = rebuildBlocks([{ kind: 'userMessage', text: '', timestamp: 1, files: [file] } as OutputItem])
    const user = blocks.find(b => b.type === 'user') as { files?: unknown[] }
    expect(user.files).toEqual([file])
  })
})

describe('createBlockBuilder (incremental block building)', () => {
  const transcript: OutputItem[] = [
    { kind: 'userMessage', text: 'first', timestamp: 1 } as OutputItem,
    { kind: 'thinking', text: 'hmm ' } as OutputItem,
    { kind: 'thinking', text: 'more' } as OutputItem,
    { kind: 'text', text: 'Hello ' } as OutputItem,
    { kind: 'text', text: '' } as OutputItem,
    { kind: 'text', text: 'world' } as OutputItem,
    { kind: 'toolStart', tool: 'Bash', input: '' } as OutputItem,
    { kind: 'toolStart', tool: 'Bash', input: '{"command":"ls"}' } as OutputItem,
    { kind: 'toolStart', tool: 'Read', input: '{"file_path":"a.ts"}' } as OutputItem,
    { kind: 'toolResult', text: 'a.ts', isError: false } as OutputItem,
    { kind: 'toolResult', text: 'files', isError: false } as OutputItem,
    { kind: 'toolResult', text: 'orphan', isError: true } as OutputItem,
    { kind: 'text', text: 'Done.' } as OutputItem,
    { kind: 'turnEnd', status: 'completed', timestamp: 9, cost: 0.1, inputTokens: 5, outputTokens: 7 } as OutputItem,
    { kind: 'turnSnapshot', messageUuid: 'uuid-1' } as OutputItem,
    { kind: 'planUpdate', items: [{ status: 'pending', step: 'a' }] } as OutputItem,
    { kind: 'diffUpdate', diff: 'd1' } as OutputItem,
    { kind: 'transcriptUserMessage', text: 'second', isMeta: false } as OutputItem,
    { kind: 'system', text: 'sys' } as OutputItem,
    { kind: 'userMessage', text: 'third', timestamp: 10 } as OutputItem,
    { kind: 'text', text: 'partial' } as OutputItem,
    { kind: 'errorMessage', message: 'boom', raw: '{}' } as OutputItem,
    { kind: 'turnEnd', status: 'error', error: 'boom' } as OutputItem,
    { kind: 'userMessage', text: 'fourth', timestamp: 11, wakeupReason: 'poll' } as OutputItem,
    { kind: 'text', text: 'streaming ' } as OutputItem,
    { kind: 'planUpdate', items: [{ status: 'completed', step: 'a' }], explanation: 'x' } as OutputItem,
    { kind: 'diffUpdate', diff: 'd2' } as OutputItem,
    { kind: 'text', text: 'still ' } as OutputItem,
    { kind: 'text', text: 'going' } as OutputItem,
  ]

  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

  test('appending in any chunking matches a full rebuild at every step', () => {
    for (let chunk = 1; chunk <= 5; chunk++) {
      const builder = createBlockBuilder()
      for (let end = chunk; end < transcript.length + chunk; end += chunk) {
        const prefix = transcript.slice(0, Math.min(end, transcript.length))
        builder.append(prefix)
        expect(plain(builder.blocks)).toEqual(plain(rebuildBlocks(prefix)))
      }
    }
  })

  test('streaming text only dirties the last block', () => {
    const builder = createBlockBuilder()
    builder.append(transcript)
    const dirty = builder.append([...transcript, { kind: 'text', text: 'x' } as OutputItem])
    expect([...dirty]).toEqual([builder.blocks.length - 1])
  })

  test('turnEnd after streamed text clears isStreaming on that text', () => {
    const builder = createBlockBuilder()
    const items: OutputItem[] = [
      { kind: 'userMessage', text: 'q', timestamp: 1 } as OutputItem,
      { kind: 'text', text: 'a' } as OutputItem,
    ]
    builder.append(items)
    expect((builder.blocks[1] as { isStreaming?: boolean }).isStreaming).toBe(true)
    const dirty = builder.append([...items, { kind: 'turnEnd', status: 'completed' } as OutputItem])
    expect((builder.blocks[1] as { isStreaming?: boolean }).isStreaming).toBeUndefined()
    expect(dirty.has(1)).toBe(true)
  })
})
