import { createSignal, onCleanup, type Accessor } from 'solid-js'
import type { AgentProgress, OutputItem } from '../types'

/** Tool names that spawn a Claude subagent. */
export const AGENT_TOOLS = new Set(['Agent', 'Task'])

/**
 * Fold a newer progress event into what is known about the task. A start
 * begins a new run (an agent resumed with SendMessage restarts its task), so
 * nothing from the previous run, like its "didn't finish" summary, carries over.
 */
export function mergeAgentProgress(prev: AgentProgress | undefined, next: AgentProgress): AgentProgress {
  const out: AgentProgress = { ...(next.startedAt === undefined && prev ? prev : { taskId: next.taskId }) }
  // A progress event names the current step in `description` ("Running X").
  // Verun now sends it as `activity`; older transcripts still carry it here.
  if (next.status === undefined && next.startedAt === undefined && next.description !== undefined) {
    const { description, ...rest } = next
    next = { ...rest, activity: next.activity ?? description.replace(/^Running /, '') }
  }
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined && k !== 'kind') (out as unknown as Record<string, unknown>)[k] = v
  }
  return out
}

const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'])
export function isTaskFinished(status: string | undefined): boolean {
  return !!status && FINISHED.has(status)
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

/** "reading types.ts · 12 tools · 41k tokens": what it's doing now leads. */
export function agentActivityLine(p: AgentProgress): string {
  const parts: string[] = []
  const action = agentAction(p)
  if (action) parts.push(action)
  if (p.toolUses !== undefined) parts.push(`${p.toolUses} ${p.toolUses === 1 ? 'tool' : 'tools'}`)
  if (p.totalTokens) parts.push(`${compactTokens(p.totalTokens)} tokens`)
  return parts.join(' · ')
}

/** What the agent is doing right now, if Claude said. */
export function agentAction(p: AgentProgress): string {
  return p.summary || p.activity || p.lastToolName || ''
}

/** An Agent call without a type runs Claude's general-purpose agent. */
export function agentTypeLabel(subagentType: string | undefined): string {
  return subagentType || 'general-purpose'
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Elapsed time of a task: live while running, final once it ends. */
export function taskElapsed(p: AgentProgress | undefined, now: number): number | undefined {
  if (!p) return undefined
  if (p.startedAt !== undefined) {
    if (isTaskFinished(p.status)) return (p.endedAt ?? p.startedAt + (p.durationMs ?? 0)) - p.startedAt
    return now - p.startedAt
  }
  return p.durationMs
}

export type AgentStateKind = 'running' | 'background' | 'needs-input' | 'done' | 'failed' | 'stopped'

export const AGENT_STATE_LABEL: Record<AgentStateKind, string> = {
  running: 'Running',
  background: 'In background',
  'needs-input': 'Needs input',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/** Where an agent block stands, from its progress, its tool result and the session. */
export function agentState(a: {
  progress?: AgentProgress
  result?: { text: string; isError: boolean }
  needsInput?: boolean
  /** The session is still running or has background work. */
  sessionLive?: boolean
}): { state: AgentStateKind; starting: boolean } {
  const p = a.progress
  const status = p?.status
  let state: AgentStateKind
  if (status && isTaskFinished(status)) {
    state = status === 'completed' ? 'done' : status === 'failed' || status === 'error' ? 'failed' : 'stopped'
  } else if (status) {
    state = p?.isBackgrounded ? 'background' : 'running'
  } else if (a.result) {
    state = a.result.isError ? 'failed' : 'done'
  } else {
    state = a.sessionLive ? 'running' : 'stopped'
  }
  if (a.needsInput && (state === 'running' || state === 'background')) state = 'needs-input'
  const starting = !!status && !isTaskFinished(status) && p?.toolUses === undefined && p?.totalTokens === undefined
  return { state, starting }
}

/**
 * An agent's final report. A foreground agent returns it as its tool result;
 * a background one returns at once ("launched") and reports through its task.
 */
export function agentFinalText(
  p: AgentProgress | undefined,
  result: { text: string; isError: boolean } | undefined,
): string {
  if (p?.isBackgrounded && p.summary) return p.summary
  return result?.text || p?.summary || ''
}

/** Still-running background tasks (subagents and shells) in start order. */
export function runningBackgroundTasks(items: readonly OutputItem[]): AgentProgress[] {
  const tasks = new Map<string, AgentProgress>()
  // Task events may omit the agent type; the Agent call's input names it.
  const typeByCall = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'toolStart' && item.id && AGENT_TOOLS.has(item.tool) && item.input.includes('subagent_type')) {
      try {
        const t = JSON.parse(item.input)?.subagent_type
        if (typeof t === 'string') typeByCall.set(item.id, t)
      } catch { /* partial input */ }
    }
    if (item.kind !== 'agentProgress') continue
    const { kind: _kind, ...p } = item
    tasks.set(p.taskId, mergeAgentProgress(tasks.get(p.taskId), p))
  }
  return [...tasks.values()]
    .filter(t => !isTaskFinished(t.status))
    .map(t => t.subagentType || !t.toolUseId || !typeByCall.has(t.toolUseId) ? t : { ...t, subagentType: typeByCall.get(t.toolUseId) })
}

// One shared one-second clock for live elapsed times, running only while
// something on screen reads it.
const [now, setNow] = createSignal(Date.now())
let clockUsers = 0
let clockTimer: ReturnType<typeof setInterval> | undefined
export function useNow(): Accessor<number> {
  clockUsers++
  if (!clockTimer) {
    setNow(Date.now())
    clockTimer = setInterval(() => setNow(Date.now()), 1000)
  }
  onCleanup(() => {
    if (--clockUsers === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  })
  return now
}
