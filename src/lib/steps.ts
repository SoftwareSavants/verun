// What a tool call did, in words: the chat's step rows, and the summaries of
// a run of steps. The raw input stays in the row's details.

export type StepTone = 'verb' | 'path' | 'code' | 'target' | 'dim'
export interface StepPart { text: string; tone: StepTone }
export type StepKind = 'read' | 'edit' | 'write' | 'search' | 'files' | 'run' | 'web' | 'todo' | 'question' | 'skill' | 'mcp' | 'other'
export interface StepSummary { kind: StepKind; parts: StepPart[]; added?: number; removed?: number }

type Input = Record<string, unknown> | undefined

const WORKTREE = /^.*\.verun\/worktrees\/[^/]+\//
const HOME = /^\/Users\/[^/]+\//

/** A path relative to the first of `roots` (the worktree, the project) holding it, else from home. */
export function shortPath(p: string, roots: readonly string[] = []): string {
  for (const root of roots) {
    const r = root.replace(/\/+$/, '')
    if (r && (p === r || p.startsWith(r + '/'))) return p.slice(r.length + 1) || '.'
  }
  return WORKTREE.test(p) ? p.replace(WORKTREE, '') : p.replace(HOME, '~/')
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const lines = (v: unknown) => (typeof v === 'string' && v ? v.replace(/\n$/, '').split('\n').length : 0)
const part = (tone: StepTone) => (text: string): StepPart => ({ text, tone })
const verb = part('verb'), code = part('code'), target = part('target'), dim = part('dim')
const opt = (v: string | undefined, f: (s: string) => StepPart) => (v ? [f(v)] : [])

function webTarget(url: string): string {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\/$/, '')
  } catch {
    return url
  }
}

/** `roots`: folders paths are shown relative to, the task's worktree first. */
export function describeStep(tool: string, input: Input, roots: readonly string[] = []): StepSummary {
  const i = input ?? {}
  const path = (p: string) => part('path')(shortPath(p, roots))
  const file = str(i.file_path) ?? str(i.notebook_path)
  switch (tool) {
    case 'Read':
      return { kind: 'read', parts: [verb('Read'), ...opt(file, path)] }
    case 'Edit':
      return { kind: 'edit', parts: [verb('Edited'), ...opt(file, path)], added: lines(i.new_string), removed: lines(i.old_string) }
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []
      const sum = (key: string) => edits.reduce((n, e) => n + lines(e?.[key]), 0)
      return { kind: 'edit', parts: [verb('Edited'), ...opt(file, path)], added: sum('new_string'), removed: sum('old_string') }
    }
    case 'NotebookEdit':
      return { kind: 'edit', parts: [verb('Edited'), ...opt(file, path)] }
    case 'Write':
      return { kind: 'write', parts: [verb('Wrote'), ...opt(file, path)], added: lines(i.content), removed: 0 }
    case 'Bash': {
      // Claude's description says what the command is for; the command shows when opened.
      const description = str(i.description)
      if (description) return { kind: 'run', parts: [verb(description)] }
      return { kind: 'run', parts: [verb('Ran'), ...opt(str(i.command)?.split('\n')[0], code)] }
    }
    case 'Grep':
      return { kind: 'search', parts: [verb('Searched for'), ...opt(str(i.pattern)?.replace(/\\(.)/g, '$1'), code), ...(str(i.path) ? [dim('in'), path(str(i.path)!)] : [])] }
    case 'Glob':
      return { kind: 'files', parts: [verb('Found files'), ...opt(str(i.pattern), code), ...(str(i.path) ? [dim('in'), path(str(i.path)!)] : [])] }
    case 'WebFetch':
      return { kind: 'web', parts: [verb('Fetched'), ...opt(str(i.url) && webTarget(str(i.url)!), target)] }
    case 'WebSearch':
      return { kind: 'web', parts: [verb('Searched the web for'), ...opt(str(i.query), target)] }
    case 'TodoWrite':
      return { kind: 'todo', parts: [verb('Updated the to-do list')] }
    case 'AskUserQuestion': {
      const first = Array.isArray(i.questions) ? str((i.questions[0] as Record<string, unknown> | undefined)?.question) : undefined
      return { kind: 'question', parts: [verb('Asked'), ...opt(first, target)] }
    }
    case 'Skill':
      return { kind: 'skill', parts: [verb('Used the'), ...opt(str(i.skill), code), dim('skill')] }
  }
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__')
    return { kind: 'mcp', parts: [verb('Used'), code(rest.join('__') || server), dim(`on ${server}`)] }
  }
  const any = file ?? str(i.path) ?? str(i.pattern) ?? str(i.command) ?? str(i.query) ?? str(i.url) ?? str(i.description)
  return { kind: 'other', parts: [verb(tool), ...opt(any && shortPath(any.split('\n')[0], roots), target)] }
}

// How a run of steps reads in one line: "Read 3 files, searched 2 times, ran 1 command".
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const CLAUSES: Record<string, (n: number) => string> = {
  read: n => `read ${plural(n, 'file', 'files')}`,
  edit: n => `edited ${plural(n, 'file', 'files')}`,
  write: n => `wrote ${plural(n, 'file', 'files')}`,
  run: n => `ran ${plural(n, 'command', 'commands')}`,
  search: n => `searched ${plural(n, 'time', 'times')}`,
  web: n => `used the web ${plural(n, 'time', 'times')}`,
  todo: () => 'updated the to-do list',
  thought: () => 'thought',
  other: n => `used ${plural(n, 'tool', 'tools')}`,
}
const CLAUSE_OF: Record<StepKind, string> = {
  read: 'read', edit: 'edit', write: 'write', run: 'run', search: 'search', files: 'search',
  web: 'web', todo: 'todo', question: 'other', skill: 'other', mcp: 'other', other: 'other',
}

/** One line for a run of steps. `tool: 'thinking'` stands for a thinking block. */
export function summarizeSteps(steps: readonly { tool: string; input?: Input }[]): string {
  const counts = new Map<string, number>()
  for (const s of steps) {
    const clause = s.tool === 'thinking' ? 'thought' : CLAUSE_OF[describeStep(s.tool, s.input).kind]
    counts.set(clause, (counts.get(clause) ?? 0) + 1)
  }
  const text = [...counts].map(([clause, n]) => CLAUSES[clause](n)).join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
