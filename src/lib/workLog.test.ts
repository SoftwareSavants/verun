import { describe, expect, test } from 'vitest'
import { planFolds, type FoldBlock, type FoldPlanOptions } from './workLog'

const user = (at: number, endedAt?: number): FoldBlock => ({ type: 'user', at, endedAt })
const say = (final = false, durationMs?: number): FoldBlock => ({ type: 'assistant', isLastInTurn: final, durationMs })
const tool = (name: string, id: string, failed?: boolean): FoldBlock => ({ type: 'tool', id, tool: name, result: failed === undefined ? undefined : { isError: failed } })
const done = (name: string, id: string) => tool(name, id, false)
const think = (id: string): FoldBlock => ({ type: 'thinking', id })
const agent = (id: string): FoldBlock => ({ type: 'agent', id })
const opts = (o: Partial<FoldPlanOptions> = {}): FoldPlanOptions => ({ live: false, stateOf: () => undefined, isOpen: () => undefined, unfoldAll: false, ...o })
const hidden = (plan: ReturnType<typeof planFolds>) => plan.flatMap((d, i) => d.hidden ? [i] : [])
const rows = (plan: ReturnType<typeof planFolds>) => plan.flatMap((d, i) => [d.row, d.group].flatMap(r => r ? [{ at: i, ...r }] : []))

describe('finished turns', () => {
  // 0 user, 1 thinking, 2 narration, 3-5 tools, 6 final reply, 7 next prompt, 8 reply
  const blocks: FoldBlock[] = [
    user(1_000, 200_000), think('th-0'), say(), done('Read', 't0'), tool('Bash', 't1', true), done('Edit', 't2'), say(true, 192_000),
    user(300_000, 310_000), say(true, 10_000),
  ]

  test('fold the work between a prompt and its final reply into one row; a failure nothing fixed stays out', () => {
    const plan = planFolds(blocks, opts())
    expect(hidden(plan)).toEqual([1, 2, 3, 5])
    expect(plan[4].hidden).toBe(false)
    expect(rows(plan)).toEqual([{ at: 1, kind: 'turn', key: 'turn:1000', open: false, live: false, steps: 3, agents: 0, failed: 1, retried: [], running: 0, edits: 1, durationMs: 192_000, reply: 6 }])
    // The reply's own duration moves to the row.
    expect(plan[6].replyMetaInRow).toBe(true)
    // A turn with no work between prompt and reply has no row.
    expect(plan[8].replyMetaInRow).toBeFalsy()
  })

  test('a failure a later attempt fixed folds away, counted as retried', () => {
    const cmd = (command: string) => JSON.stringify({ command })
    const retried: FoldBlock[] = [
      user(1, 90),
      { type: 'tool', id: 't0', tool: 'Bash', input: cmd('pnpm lint'), result: { isError: true } },
      done('Edit', 't1'),
      { type: 'tool', id: 't2', tool: 'Bash', input: cmd('pnpm  lint'), result: { isError: false } },
      say(true),
    ]
    const plan = planFolds(retried, opts())
    expect(hidden(plan)).toEqual([1, 2, 3])
    expect(rows(plan)).toMatchObject([{ failed: 0, retried: ['pnpm lint'], steps: 3 }])
  })

  test('subagents stay in view, each its own compact block; the row says what still runs and what failed', () => {
    const plan = planFolds(
      [user(1, 9), done('Read', 't0'), agent('a0'), agent('a1'), agent('a2'), say(true)],
      opts({ stateOf: b => b.id === 'a1' ? 'active' : b.id === 'a2' ? 'failed' : undefined }),
    )
    expect(hidden(plan)).toEqual([1])
    expect(rows(plan)).toMatchObject([{ at: 1, steps: 1, agents: 3, running: 1, failed: 1 }])
  })

  test('an opened turn shows every step in place, under its row', () => {
    const plan = planFolds(blocks, opts({ isOpen: k => k === 'turn:1000' || undefined }))
    expect(hidden(plan)).toEqual([])
    expect(rows(plan)).toMatchObject([{ at: 1, open: true }])
    expect(plan[2].narration).toBe(true)
  })

  test('a step awaiting approval never folds away; with nothing else to fold there is no row', () => {
    const plan = planFolds([user(1, 50), done('Read', 't0'), tool('Bash', 't1'), say(true)], opts({ stateOf: b => b.id === 't1' ? 'active' : undefined }))
    expect(hidden(plan)).toEqual([1])
    expect(rows(planFolds([user(1, 50), tool('Bash', 't1'), say(true)], opts({ stateOf: () => 'active' })))).toEqual([])
  })

  test('errors and turn diffs stay visible; a turn without a reply folds all its steps', () => {
    const plan = planFolds([user(1, 9), done('Read', 't0'), done('Bash', 't1'), { type: 'error' }, { type: 'diff' }], opts())
    expect(hidden(plan)).toEqual([1, 2])
    expect(rows(plan)).toMatchObject([{ at: 1, steps: 2, durationMs: 8 }])
  })

  test('the last turn of a stopped session folds even without a turn end', () => {
    const plan = planFolds([user(1), done('Read', 't0'), say(true)], opts({ live: false }))
    expect(hidden(plan)).toEqual([1])
  })

  test('a plan card and a turn-status line (like max turns) never fold away', () => {
    const plan = planFolds([user(1, 9), done('Read', 't0'), { type: 'plan' }, { type: 'system' }, say(true)], opts())
    expect(hidden(plan)).toEqual([1])
  })

  test('the reply is text nothing came after; an interrupted turn folds its last narration with the rest', () => {
    const plan = planFolds([user(1, 9), say(), done('Read', 't0'), say(), done('Bash', 't1')], opts())
    expect(hidden(plan)).toEqual([1, 2, 3, 4])
    expect(rows(plan)).toMatchObject([{ at: 1, steps: 2 }])
    expect(plan.some(d => d.replyMetaInRow)).toBe(false)
  })

  test('a retry only counts for the same input: a different URL or tool call is new work', () => {
    const fetch = (id: string, url: string, isError: boolean): FoldBlock => ({ type: 'tool', id, tool: 'WebFetch', input: JSON.stringify({ url }), result: { isError } })
    const plan = planFolds([user(1, 9), fetch('t0', 'https://a.dev', true), fetch('t1', 'https://b.dev', false), say(true)], opts())
    expect(rows(plan)).toMatchObject([{ failed: 1, retried: [] }])
    expect(plan[1].hidden).toBe(false)
  })

  test("a turn's open or closed state follows the turn, also in transcripts without timestamps", () => {
    const turn = (n: number): FoldBlock[] => [{ type: 'user' }, { type: 'tool', id: `tool-${n}`, toolUseId: `toolu_${n}`, tool: 'Read', result: { isError: false } }, say(true)]
    const open = (k: string) => k === 'turn:toolu_2' || undefined
    // An older page prepended moves every index; the turn that was open stays open.
    const before = planFolds([...turn(1), ...turn(2)], opts({ isOpen: open }))
    const after = planFolds([...turn(0), ...turn(1), ...turn(2)], opts({ isOpen: open }))
    expect(rows(before).map(r => r.open)).toEqual([false, true])
    expect(rows(after).map(r => r.open)).toEqual([false, false, true])
  })

  test('search unfolds everything', () => {
    const plan = planFolds(blocks, opts({ unfoldAll: true }))
    expect(hidden(plan)).toEqual([])
    expect(rows(plan)).toEqual([])
  })
})

describe('the running turn', () => {
  // 0 user, 1 narration, 2-6 steps, 7 narration, 8 agent, 9-11 latest steps
  const blocks: FoldBlock[] = [
    user(5_000), say(), done('Read', 't0'), think('th-1'), done('Read', 't2'), done('Grep', 't3'), done('Bash', 't4'), say(), agent('a0'),
    done('Edit', 't5'), done('Edit', 't6'), tool('Bash', 't7'),
  ]
  const groups = (plan: ReturnType<typeof planFolds>) => rows(plan).filter(r => r.kind === 'group')

  test('has the same row as a finished turn, open while it works, saying when it started', () => {
    const plan = planFolds(blocks, opts({ live: true, stateOf: b => b.id === 't7' ? 'active' : undefined }))
    expect(rows(plan)[0]).toMatchObject({ at: 1, kind: 'turn', key: 'turn:5000', live: true, open: true, startedAt: 5_000, steps: 7, running: 1 })
  })

  test('older runs of steps group into one row; the last three steps stay live', () => {
    const plan = planFolds(blocks, opts({ live: true }))
    expect(groups(plan)).toEqual([{ at: 2, kind: 'group', key: 'group:t0', open: false, label: 'Read 2 files, thought, searched 1 time, ran 1 command', size: 5, failed: 0 }])
    expect(hidden(plan)).toEqual([2, 3, 4, 5, 6])
    // Narration, the subagent and the latest three steps show.
    for (const i of [1, 7, 8, 9, 10, 11]) expect(plan[i].hidden).toBe(false)
  })

  test('an opened group shows its steps; a lone older step is not grouped', () => {
    expect(hidden(planFolds(blocks, opts({ live: true, isOpen: k => k === 'group:t0' || undefined })))).toEqual([])
    const short: FoldBlock[] = [user(1), done('Read', 't0'), say(), done('Read', 't1'), done('Read', 't2'), done('Read', 't3')]
    expect(groups(planFolds(short, opts({ live: true })))).toEqual([])
  })

  test('folded while it works, it keeps only what is still running in view', () => {
    const plan = planFolds(blocks, opts({ live: true, isOpen: k => k === 'turn:5000' ? false : undefined, stateOf: b => b.id === 'a0' || b.id === 't7' ? 'active' : undefined }))
    expect(rows(plan)).toMatchObject([{ kind: 'turn', open: false }])
    expect(hidden(plan)).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10])
  })

  test('text followed by more work is narration, quieter than a reply; the latest text may be the reply', () => {
    const plan = planFolds([...blocks, say()], opts({ live: true }))
    expect([1, 7].map(i => plan[i].narration)).toEqual([true, true])
    expect(plan[12].narration).toBeFalsy()
  })

  test('a turn that has ended is not the running one, even while the session works in the background', () => {
    const plan = planFolds([user(1, 5), done('Read', 't0'), done('Read', 't1'), say(true)], opts({ live: true }))
    expect(rows(plan)).toMatchObject([{ kind: 'turn', live: false }])
  })
})
