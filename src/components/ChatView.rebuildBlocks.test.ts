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

describe('agent blocks (subagents)', () => {
  const sub = (parent: string, item: object) => ({ kind: 'subagent', parentToolUseId: parent, item }) as unknown as OutputItem
  const agentStart = (id: string, input = '{"description":"Review diff","subagent_type":"code-reviewer","prompt":"go"}') =>
    ({ kind: 'toolStart', tool: 'Agent', input, id }) as unknown as OutputItem
  const progress = (p: object) => ({ kind: 'agentProgress', ...p }) as unknown as OutputItem
  type Agent = {
    type: 'agent'; toolUseId?: string; description?: string; subagentType?: string
    children: Array<{ type: string; text?: string; tool?: string; result?: { text: string } }>
    result?: { text: string; isError: boolean }
    progress?: { status?: string; toolUses?: number; summary?: string; isBackgrounded?: boolean }
  }
  const agents = (items: OutputItem[]) => rebuildBlocks(items).filter(b => b.type === 'agent') as unknown as Agent[]

  const transcript: OutputItem[] = [
    { kind: 'userMessage', text: 'review', timestamp: 1 } as OutputItem,
    { kind: 'text', text: 'Spawning ' } as OutputItem,
    agentStart('toolu_A', ''),
    agentStart('toolu_A'),
    progress({ taskId: 't1', toolUseId: 'toolu_A', status: 'running', description: 'Review diff', startedAt: 100 }),
    agentStart('toolu_B', '{"description":"Run tests","subagent_type":"tester"}'),
    sub('toolu_A', { kind: 'text', text: 'Reading ' }),
    sub('toolu_B', { kind: 'toolStart', tool: 'Bash', input: '{"command":"pnpm test"}', id: 'toolu_B1' }),
    sub('toolu_A', { kind: 'text', text: 'files' }),
    sub('toolu_A', { kind: 'toolStart', tool: 'Read', input: '{"file_path":"a.ts"}', id: 'toolu_A1' }),
    // control_request duplicate of a subagent tool reaches the main list with the same id
    { kind: 'toolStart', tool: 'Read', input: '{"file_path":"a.ts"}', id: 'toolu_A1' } as unknown as OutputItem,
    progress({ taskId: 't1', toolUses: 1, totalTokens: 41000, summary: 'reading a.ts' }),
    sub('toolu_A', { kind: 'toolResult', text: 'contents', isError: false, toolUseId: 'toolu_A1' }),
    sub('toolu_B', { kind: 'toolResult', text: 'failed', isError: true, toolUseId: 'toolu_B1' }),
    { kind: 'text', text: 'main keeps going' } as OutputItem,
    { kind: 'toolResult', text: 'B crashed', isError: true, toolUseId: 'toolu_B' } as unknown as OutputItem,
    { kind: 'toolResult', text: 'All good\nmore detail', isError: false, toolUseId: 'toolu_A' } as unknown as OutputItem,
    progress({ taskId: 't1', status: 'completed', endedAt: 900 }),
    sub('toolu_C', { kind: 'text', text: 'orphan child' }),
    { kind: 'turnEnd', status: 'completed', timestamp: 9 } as OutputItem,
  ]

  test('an Agent call becomes one agent block, deduped by tool_use id', () => {
    const blocks = rebuildBlocks(transcript.slice(0, 5))
    expect(blocks.map(b => b.type)).toEqual(['user', 'assistant', 'agent'])
    const a = blocks[2] as unknown as Agent
    expect(a.toolUseId).toBe('toolu_A')
    expect(a.description).toBe('Review diff')
    expect(a.subagentType).toBe('code-reviewer')
    expect(a.progress?.status).toBe('running')
  })

  test("subagent items nest under their parent's block, not the main list", () => {
    const blocks = rebuildBlocks(transcript)
    // The main list holds no Read/Bash rows from the subagents.
    expect(blocks.filter(b => b.type === 'tool')).toEqual([])
    const [a, b] = agents(transcript)
    expect(a.children.map(c => c.type)).toEqual(['assistant', 'tool'])
    expect(a.children[0].text).toBe('Reading files')
    expect(a.children[1].tool).toBe('Read')
    expect(a.children[1].result?.text).toBe('contents')
    expect(b.children.map(c => c.tool)).toEqual(['Bash'])
    expect(b.children[0].result?.text).toBe('failed')
  })

  test('results match their agent by tool_use id and progress applies per task', () => {
    const [a, b] = agents(transcript)
    expect(a.result).toEqual({ text: 'All good\nmore detail', isError: false })
    expect(b.result).toEqual({ text: 'B crashed', isError: true })
    expect(a.progress).toMatchObject({ status: 'completed', toolUses: 1, summary: 'reading a.ts' })
    expect(b.progress).toBeUndefined()
  })

  test('children of an unknown parent get their own agent block', () => {
    const c = agents(transcript)[2]
    expect(c.toolUseId).toBe('toolu_C')
    expect(c.children[0].text).toBe('orphan child')
  })

  describe('an agent resumed with SendMessage', () => {
    // Claude tags the resumed agent's actions with its original Agent call id,
    // and its task events with the SendMessage call.
    const resumed: OutputItem[] = [
      { kind: 'userMessage', text: 'go', timestamp: 1 } as OutputItem,
      agentStart('toolu_A', '{"description":"Implement Task 15","subagent_type":"general-purpose"}'),
      progress({ taskId: 't1', toolUseId: 'toolu_A', status: 'running', description: 'Implement Task 15', startedAt: 100, isBackgrounded: true, taskType: 'local_agent' }),
      progress({ taskId: 't1', status: 'stopped', summary: "didn't finish before the previous session ended", endedAt: 200 }),
      { kind: 'userMessage', text: 'continue', timestamp: 2 } as OutputItem,
      { kind: 'toolStart', tool: 'SendMessage', input: '{"to":"t1","message":"Resume"}', id: 'toolu_S' } as unknown as OutputItem,
      progress({ taskId: 't1', toolUseId: 'toolu_S', status: 'running', description: 'Implement Task 15', startedAt: 300, isBackgrounded: true, taskType: 'local_agent', subagentType: 'general-purpose' }),
      { kind: 'toolResult', text: '{"success":true}', isError: false, toolUseId: 'toolu_S' } as unknown as OutputItem,
      sub('toolu_A', { kind: 'text', text: 'Resuming.' }),
      progress({ taskId: 't1', toolUseId: 'toolu_S', activity: 'Confirm the revert', toolUses: 1 }),
    ]

    test('shows the resumed run where it was resumed, with its task and live progress', () => {
      const blocks = rebuildBlocks(resumed)
      expect(blocks.filter(b => b.type === 'tool')).toEqual([])
      const [first, again] = blocks.filter(b => b.type === 'agent') as unknown as Agent[]
      expect(first.toolUseId).toBe('toolu_A')
      expect(first.progress?.status).toBe('stopped')
      expect(again.toolUseId).toBe('toolu_S')
      expect(again.description).toBe('Implement Task 15')
      expect(again.progress).toMatchObject({ status: 'running', toolUses: 1 })
      expect(again.progress?.summary).toBeUndefined()
      expect(again.children.map(c => c.text)).toEqual(['Resuming.'])
      expect(blocks.indexOf(again as never)).toBeGreaterThan(blocks.indexOf(first as never))
    })

    test('builds the same blocks fed one item at a time', () => {
      const b = createBlockBuilder()
      for (let i = 1; i <= resumed.length; i++) b.append(resumed.slice(0, i))
      expect(JSON.stringify(b.blocks)).toBe(JSON.stringify(rebuildBlocks(resumed)))
    })

    test('a background shell keeps its Bash row', () => {
      const items: OutputItem[] = [
        { kind: 'toolStart', tool: 'Bash', input: '{"command":"pnpm test"}', id: 'toolu_X' } as unknown as OutputItem,
        progress({ taskId: 'b1', toolUseId: 'toolu_X', status: 'running', startedAt: 1, taskType: 'local_bash' }),
      ]
      expect(rebuildBlocks(items).map(b => b.type)).toEqual(['tool'])
    })
  })

  test('children of an unknown parent join the agent that just started, for transcripts recorded without call ids', () => {
    const items: OutputItem[] = [
      { kind: 'toolStart', tool: 'SendMessage', input: '{}', id: 'toolu_S' } as unknown as OutputItem,
      progress({ taskId: 't1', toolUseId: 'toolu_S', status: 'running', description: 'Implement Task 15', startedAt: 300, taskType: 'local_agent' }),
      sub('toolu_OLD', { kind: 'text', text: 'Resuming.' }),
    ]
    const all = agents(items)
    expect(all).toHaveLength(1)
    expect(all[0].description).toBe('Implement Task 15')
    expect(all[0].children.map(c => c.text)).toEqual(['Resuming.'])
  })

  test('main text after an agent block keeps streaming into the main list', () => {
    const blocks = rebuildBlocks(transcript)
    expect(blocks.some(b => b.type === 'assistant' && b.text === 'main keeps going')).toBe(true)
  })

  test('old transcripts without ids still render Agent calls as agent blocks', () => {
    const old: OutputItem[] = [
      { kind: 'userMessage', text: 'q', timestamp: 1 } as OutputItem,
      { kind: 'toolStart', tool: 'Task', input: '' } as OutputItem,
      { kind: 'toolStart', tool: 'Task', input: '{"description":"Explore"}' } as OutputItem,
      { kind: 'toolResult', text: 'report', isError: false } as OutputItem,
    ]
    const [a] = agents(old)
    expect(agents(old).length).toBe(1)
    expect(a.description).toBe('Explore')
    expect(a.subagentType).toBeUndefined()
    expect(a.result?.text).toBe('report')
  })

  test('progress that arrives before its Agent call is applied when the block appears', () => {
    const items: OutputItem[] = [
      progress({ taskId: 't9', toolUseId: 'toolu_Z', status: 'running', subagentType: 'explorer' }),
      agentStart('toolu_Z', '{"description":"Look"}'),
    ]
    expect(agents(items)[0].progress?.status).toBe('running')
    expect(agents(items)[0].subagentType).toBe('explorer')
  })

  const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
  test('incremental building matches a full rebuild in any chunking', () => {
    for (let chunk = 1; chunk <= 4; chunk++) {
      const builder = createBlockBuilder()
      for (let end = chunk; end < transcript.length + chunk; end += chunk) {
        const prefix = transcript.slice(0, Math.min(end, transcript.length))
        builder.append(prefix)
        expect(plain(builder.blocks)).toEqual(plain(rebuildBlocks(prefix)))
      }
    }
  })

  test('a subagent update dirties its own agent block only', () => {
    const builder = createBlockBuilder()
    const head = transcript.slice(0, 14)
    builder.append(head)
    const idx = builder.blocks.findIndex(b => b.type === 'agent')
    const other = builder.blocks.map(b => b.type).lastIndexOf('agent')
    const dirty = builder.append([...head, sub('toolu_A', { kind: 'text', text: '!' })])
    expect(dirty.has(idx)).toBe(true)
    expect(dirty.has(other)).toBe(false)
    expect(builder.blocks.length).toBe(other + 1)
  })
})

describe('turn times on turn-start blocks', () => {
  test('a user block carries when it was sent and when its turn ended', () => {
    const blocks = rebuildBlocks([
      { kind: 'userMessage', text: 'one', timestamp: 100 } as OutputItem,
      { kind: 'text', text: 'done' } as OutputItem,
      { kind: 'turnEnd', status: 'completed', timestamp: 250 } as OutputItem,
      { kind: 'userMessage', text: 'two', timestamp: 300 } as OutputItem,
      { kind: 'text', text: 'working' } as OutputItem,
    ])
    expect(blocks[0]).toMatchObject({ type: 'user', at: 100, endedAt: 250 })
    expect(blocks[2]).toMatchObject({ type: 'user', at: 300 })
    expect((blocks[2] as { endedAt?: number }).endedAt).toBeUndefined()
  })

  test('a turn that ended in an error is marked failed on its prompt', () => {
    const blocks = rebuildBlocks([
      { kind: 'userMessage', text: 'one', timestamp: 100 } as OutputItem,
      { kind: 'turnEnd', status: 'error', error: 'API overloaded', timestamp: 250 } as OutputItem,
      { kind: 'userMessage', text: 'two', timestamp: 300 } as OutputItem,
      { kind: 'turnEnd', status: 'completed', timestamp: 400 } as OutputItem,
    ])
    expect(blocks[0]).toMatchObject({ type: 'user', failed: true })
    expect((blocks.find(b => b.type === 'user' && b.text === 'two') as { failed?: boolean }).failed).toBeFalsy()
  })
})
