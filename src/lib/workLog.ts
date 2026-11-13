// How a chat transcript folds its work log. Every turn's work sits under one
// row: "Working for 2m · 8 steps" while it runs, "Worked for 4m 12s · 11 steps"
// once it's done. A finished turn folds to that row above its final reply; the
// running one stays open, grouping older runs of steps behind their latest
// three. Subagents, work still going on and failures nothing fixed never fold
// away, and search unfolds everything.
import { summarizeSteps } from './steps'

export interface FoldBlock {
  type: string
  id?: string
  /** user/wakeup: when the prompt was sent and when its turn ended. */
  at?: number
  endedAt?: number
  /** assistant: the turn's final reply, and the turn's duration. */
  isLastInTurn?: boolean
  durationMs?: number
  tool?: string
  input?: string
  result?: { isError: boolean }
  /** The agent's id for a tool call: unlike an index, it holds when older pages load. */
  toolUseId?: string
}

export type FoldRow =
  | {
    kind: 'turn'; key: string; open: boolean
    /** Still working: the row counts up from `startedAt`. */
    live: boolean; startedAt?: number
    /** Tool calls, and subagents (which show as their own blocks). */
    steps: number; agents: number
    /** Failures nothing later fixed; what failed and then passed on a later attempt; work still going on. */
    failed: number; retried: string[]; running: number
    edits: number; durationMs?: number; reply?: number
  }
  | { kind: 'group'; key: string; open: boolean; label: string; size: number; failed: number }

/** For one block: whether it is folded away, and rows to show before it. */
export interface Directive {
  hidden: boolean
  /** The turn's row, before its first piece of work. */
  row?: FoldRow
  /** A run of older steps of the running turn. */
  group?: FoldRow
  replyMetaInRow?: boolean
  /** Text the agent wrote on the way, not its reply: shown quieter. */
  narration?: boolean
}

export interface FoldPlanOptions {
  /** The session is working: its last turn without an end is the running one. */
  live: boolean
  /** Work still going on, or a block that failed (a subagent). Neither folds away. */
  stateOf: (block: FoldBlock, index: number) => 'active' | 'failed' | undefined
  /** What you opened or closed; undefined leaves the default (finished: closed, running: open). */
  isOpen: (key: string) => boolean | undefined
  /** Search is on: show everything. */
  unfoldAll: boolean
  /** Latest steps of the running turn that are never grouped. */
  tail?: number
}

// What folds into a turn's row. A plan card and a turn-status line ("Turn ended:
// max_turns") stay in view, like errors and the turn's diff.
const WORK = new Set(['assistant', 'thinking', 'tool', 'agent'])
const STEP = new Set(['tool', 'thinking'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHOWN: Directive = { hidden: false }

function parse(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined
  try {
    const v = JSON.parse(input)
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

/** What a step acted on, so a later attempt at the same thing can be told apart from new work. */
function subject(b: FoldBlock): string {
  const i = parse(b.input)
  if (!i) return b.input ?? ''
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  if (b.tool === 'Bash') return s('command').trim().replace(/\s+/g, ' ')
  if (s('file_path')) return s('file_path')
  if (s('pattern') || s('path')) return `${s('pattern')}|${s('path')}`
  // Anything else is the same thing only if its whole input is.
  return b.input ?? ''
}

/** A short name for a step, to say what failed: the command, or the tool and file. */
function stepName(b: FoldBlock): string {
  const i = parse(b.input)
  const command = typeof i?.command === 'string' ? i.command.split('\n')[0].trim() : ''
  if (command) return command.length > 32 ? `${command.slice(0, 31).trimEnd()}…` : command
  const file = typeof i?.file_path === 'string' ? i.file_path.split('/').pop() : ''
  return [b.tool ?? 'Step', file].filter(Boolean).join(' ')
}

/** Failed tool calls in `work` that a later call of the same tool on the same thing got past. */
function retriedFailures(blocks: readonly FoldBlock[], work: readonly number[]): Set<number> {
  const out = new Set<number>()
  work.forEach((i, n) => {
    const b = blocks[i]
    if (b.type !== 'tool' || !b.result?.isError) return
    const key = subject(b)
    if (work.slice(n + 1).some(j => blocks[j].type === 'tool' && blocks[j].tool === b.tool && blocks[j].result?.isError === false && subject(blocks[j]) === key)) out.add(i)
  })
  return out
}

/** The turn's row and which of its work stays in view, for a turn running or done. */
function planTurn(blocks: readonly FoldBlock[], start: number, end: number, running: boolean, plan: Directive[], o: FoldPlanOptions) {
  // The reply is text with no steps after it. A turn stopped mid-work has none:
  // its last narration folds with the rest.
  let reply = -1
  if (!running) {
    for (let i = end - 1; i > start; i--) {
      if (blocks[i].type === 'assistant') { reply = i; break }
      if (STEP.has(blocks[i].type) || blocks[i].type === 'agent') break
    }
  }
  const work: number[] = []
  for (let i = start + 1; i < end; i++) if (i !== reply && WORK.has(blocks[i].type)) work.push(i)
  const at = (i: number) => blocks[i]
  const state = (i: number) => o.stateOf(at(i), i)
  const retried = retriedFailures(blocks, work)
  const unfixed = (i: number) => at(i).type === 'tool' && !!at(i).result?.isError && !retried.has(i)
  // In view whatever the fold: work still going on, failures, and (once done) subagents.
  const kept = (i: number) => state(i) !== undefined || (!running && (at(i).type === 'agent' || unfixed(i)))
  const folded = work.filter(i => !kept(i))
  if (folded.length === 0 && !running) return
  if (work.length === 0) return
  const head = blocks[start]
  // Stable across rebuilds and older pages loading: when it was sent, else its first tool call.
  const firstCall = work.map(i => at(i).toolUseId).find(Boolean)
  const key = `turn:${head.at ?? firstCall ?? start}`
  const open = o.isOpen(key) ?? running
  const fromHead = head.at !== undefined && head.endedAt !== undefined ? head.endedAt - head.at : undefined
  const durationMs = (reply >= 0 ? at(reply).durationMs : undefined) ?? fromHead
  const row: FoldRow = {
    kind: 'turn',
    key,
    open,
    live: running,
    ...(running && head.at !== undefined ? { startedAt: head.at } : {}),
    steps: work.filter(i => at(i).type === 'tool').length,
    agents: work.filter(i => at(i).type === 'agent').length,
    failed: work.filter(i => unfixed(i) || state(i) === 'failed').length,
    retried: [...retried].map(i => stepName(at(i))),
    running: work.filter(i => state(i) === 'active').length,
    edits: work.filter(i => at(i).type === 'tool' && EDIT_TOOLS.has(at(i).tool ?? '')).length,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(reply >= 0 ? { reply } : {}),
  }
  const foldedSet = new Set(folded)
  // Text with more work after it was said on the way. The running turn's
  // latest text may still be its reply.
  const narration = (i: number) => at(i).type === 'assistant' && (!running || work.some(j => j > i && at(j).type !== 'assistant'))
  for (const i of work) plan[i] = { hidden: !open && foldedSet.has(i), ...(narration(i) ? { narration: true } : {}) }
  plan[work[0]] = { ...plan[work[0]], row }
  if (reply >= 0) plan[reply] = { hidden: false, replyMetaInRow: true }
  if (running && open) groupOlderSteps(blocks, start, end, plan, o)
}

function groupOlderSteps(blocks: readonly FoldBlock[], start: number, end: number, plan: Directive[], o: FoldPlanOptions) {
  const steps: number[] = []
  for (let i = start + 1; i < end; i++) if (STEP.has(blocks[i].type)) steps.push(i)
  const tail = new Set(steps.slice(-(o.tail ?? 3)))
  let run: number[] = []
  const close = () => {
    if (run.length >= 2) {
      const first = blocks[run[0]]
      const key = `group:${first.toolUseId ?? first.id ?? run[0]}`
      const open = o.isOpen(key) ?? false
      const label = summarizeSteps(run.map(i => ({ tool: blocks[i].type === 'thinking' ? 'thinking' : blocks[i].tool ?? 'Tool', input: parse(blocks[i].input) })))
      const failed = run.filter(i => blocks[i].result?.isError).length
      for (const i of run) plan[i] = { ...plan[i], hidden: !open }
      plan[run[0]] = { ...plan[run[0]], group: { kind: 'group', key, open, label, size: run.length, failed } }
    }
    run = []
  }
  for (let i = start + 1; i < end; i++) {
    const b = blocks[i]
    if (STEP.has(b.type) && !tail.has(i) && o.stateOf(b, i) === undefined) run.push(i)
    else close()
  }
  close()
}

export function planFolds(blocks: readonly FoldBlock[], o: FoldPlanOptions): Directive[] {
  const plan: Directive[] = blocks.map(() => SHOWN)
  if (o.unfoldAll) return plan
  const starts: number[] = []
  blocks.forEach((b, i) => { if (b.type === 'user' || b.type === 'wakeup') starts.push(i) })
  starts.forEach((start, t) => {
    const end = starts[t + 1] ?? blocks.length
    const running = t === starts.length - 1 && o.live && blocks[start].endedAt === undefined
    planTurn(blocks, start, end, running, plan, o)
  })
  return plan
}
