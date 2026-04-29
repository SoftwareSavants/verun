import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { WorkflowRun, WorkflowJob } from '../types'
import { parseGhLogs, type LogLine } from '../lib/ghLogs'

const MAX_ERRORS_IN_PROMPT = 20

export interface JobLogs {
  text: string | null
  loading: boolean
  error: string | null
  fetchedAt: number
}

export interface TaskActionsState {
  runs: WorkflowRun[]
  jobsByRun: Record<number, WorkflowJob[]>
  logsByJob: Record<number, JobLogs>
  lastRefresh: number
  loading: boolean
  error: string | null
  // runId -> epoch ms when optimistic "queued" override for this run expires.
  // While not expired, incoming run/job states from polling are pinned to
  // 'queued' so the UI keeps animating until GH surfaces the new attempt.
  rerunPendingUntil: Record<number, number>
}

function empty(): TaskActionsState {
  return { runs: [], jobsByRun: {}, logsByJob: {}, lastRefresh: 0, loading: false, error: null, rerunPendingUntil: {} }
}

const RERUN_GRACE_MS = 30_000

function isRerunPending(state: TaskActionsState | undefined, runId: number): boolean {
  const until = state?.rerunPendingUntil[runId]
  return !!until && until > Date.now()
}

export const [actionsState, setActionsState] = createStore<Record<string, TaskActionsState>>({})

function ensure(taskId: string) {
  if (!actionsState[taskId]) {
    setActionsState(produce(s => { s[taskId] = empty() }))
  }
}

const inflightRuns = new Map<string, Promise<void>>()

export async function refreshWorkflowRuns(taskId: string, limit = 25): Promise<void> {
  ensure(taskId)
  const existing = inflightRuns.get(taskId)
  if (existing) return existing

  setActionsState(produce(s => {
    const state = s[taskId]
    if (state) state.loading = true
  }))

  const promise = (async () => {
    try {
      const snapshot = await ipc.getGithubActions(taskId, limit, 'cache-first')
      const runs = snapshot.runs
      const staleJobRuns: number[] = []
      setActionsState(produce(s => {
        const state = s[taskId]
        if (!state) return
        // Merge in place by databaseId so <For> keeps row identity (preserves
        // per-row expanded state across polls). Rebuild array in API order.
        const existingById = new Map(state.runs.map(r => [r.databaseId, r]))
        state.runs.splice(0, state.runs.length)
        for (const incoming of runs) {
          const existing = existingById.get(incoming.databaseId)
          const pending = isRerunPending(state, incoming.databaseId)
          if (existing) {
            const wasActive = existing.state === 'running' || existing.state === 'queued'
            const nowSettled = incoming.state !== 'running' && incoming.state !== 'queued'
            if (wasActive && nowSettled && state.jobsByRun[existing.databaseId]) {
              staleJobRuns.push(existing.databaseId)
            }
            Object.assign(existing, incoming)
            if (pending) existing.state = 'queued'
            state.runs.push(existing)
          } else {
            if (pending) incoming.state = 'queued'
            state.runs.push(incoming)
          }
        }
        state.lastRefresh = snapshot.fetchedAt
        state.error = null
        state.loading = false
      }))
      for (const rid of staleJobRuns) loadJobsForRun(taskId, rid)
    } catch (e) {
      setActionsState(produce(s => {
        const state = s[taskId]
        if (!state) return
        state.error = e instanceof Error ? e.message : String(e)
        state.loading = false
      }))
    } finally {
      inflightRuns.delete(taskId)
    }
  })()
  inflightRuns.set(taskId, promise)
  return promise
}

export async function loadJobsForRun(taskId: string, runId: number): Promise<void> {
  ensure(taskId)
  try {
    const snapshot = await ipc.getGithubWorkflowJobs(taskId, runId, 'cache-first')
    const jobs = snapshot.jobs
    setActionsState(produce(s => {
      const state = s[taskId]
      if (!state) return
      if (isRerunPending(state, runId)) {
        for (const j of jobs) {
          j.state = 'queued'
          j.startedAt = null
          j.completedAt = null
        }
      }
      state.jobsByRun[runId] = jobs
    }))
  } catch (e) {
    setActionsState(produce(s => {
      const state = s[taskId]
      if (!state) return
      state.error = e instanceof Error ? e.message : String(e)
    }))
  }
}

const inflightLogs = new Map<string, Promise<void>>()

export async function loadJobLogs(taskId: string, _runId: number, jobId: number): Promise<void> {
  ensure(taskId)
  const key = `${taskId}:${jobId}`
  const existing = inflightLogs.get(key)
  if (existing) return existing

  setActionsState(produce(s => {
    const state = s[taskId]
    if (!state) return
    const prev = state.logsByJob[jobId]
    state.logsByJob[jobId] = {
      text: prev?.text ?? null,
      loading: true,
      error: null,
      fetchedAt: prev?.fetchedAt ?? 0,
    }
  }))

  const promise = (async () => {
    try {
      const snapshot = await ipc.getGithubWorkflowLog(taskId, jobId)
      const text = snapshot.text
      setActionsState(produce(s => {
        const state = s[taskId]
        if (!state) return
        state.logsByJob[jobId] = { text, loading: false, error: null, fetchedAt: snapshot.fetchedAt }
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // gh returns 404 when a job has no failed steps (still running, passed,
      // or GH hasn't materialized the logs yet). Treat that as "no logs" not error.
      const noLogs = /HTTP 404|Not Found|no failed/i.test(msg)
      setActionsState(produce(s => {
        const state = s[taskId]
        if (!state) return
        const prev = state.logsByJob[jobId]
        state.logsByJob[jobId] = {
          text: noLogs ? '' : (prev?.text ?? null),
          loading: false,
          error: noLogs ? null : msg,
          fetchedAt: noLogs ? Date.now() : (prev?.fetchedAt ?? 0),
        }
      }))
    } finally {
      inflightLogs.delete(key)
    }
  })()
  inflightLogs.set(key, promise)
  return promise
}

export function isAnyRunActive(taskId: string): boolean {
  const state = actionsState[taskId]
  if (!state) return false
  return state.runs.some(r => r.state === 'queued' || r.state === 'running')
}

// Optimistically mark a run (and any cached jobs) as queued. Used right after
// a run-level rerun so the UI doesn't linger on the previous failure state
// while the next poll catches up with GitHub.
export function markRunRerunning(taskId: string, runId: number): void {
  setActionsState(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.rerunPendingUntil[runId] = Date.now() + RERUN_GRACE_MS
    const r = state.runs.find(x => x.databaseId === runId)
    if (r) r.state = 'queued'
    const jobs = state.jobsByRun[runId]
    if (jobs) {
      for (const j of jobs) {
        j.state = 'queued'
        j.startedAt = null
        j.completedAt = null
      }
    }
  }))
}

// Optimistically mark a single job as queued and bump its run back to queued
// (since GitHub will re-enter the run into in_progress while the job runs).
// Sibling jobs are left alone — job-level rerun only reruns the target +
// anything that depends on it.
export function markJobRerunning(taskId: string, runId: number, jobId: number): void {
  setActionsState(produce(s => {
    const state = s[taskId]
    if (!state) return
    state.rerunPendingUntil[runId] = Date.now() + RERUN_GRACE_MS
    const r = state.runs.find(x => x.databaseId === runId)
    if (r) r.state = 'queued'
    const jobs = state.jobsByRun[runId]
    if (jobs) {
      const job = jobs.find(j => j.databaseId === jobId)
      if (job) {
        job.state = 'queued'
        job.startedAt = null
        job.completedAt = null
      }
    }
  }))
}

export async function rerunFailedJobsForRun(taskId: string, runId: number): Promise<void> {
  await ipc.rerunWorkflowRun(taskId, runId, true)
  markRunRerunning(taskId, runId)
  startPolling(taskId)
}

export async function rerunSingleJob(taskId: string, runId: number, jobId: number): Promise<void> {
  await ipc.rerunWorkflowJob(taskId, jobId)
  markJobRerunning(taskId, runId, jobId)
  startPolling(taskId)
}

export function clearActionsState(taskId: string): void {
  setActionsState(produce(s => { delete s[taskId] }))
}

export interface FixContext {
  runId: number
  runNumber: number
  workflowName: string
  jobId: number
  jobName: string
}

function formatErrorLocation(line: LogLine): string | null {
  const a = line.annotation
  if (!a?.file) return null
  let loc = a.file
  if (a.line) loc += `:${a.line}`
  if (a.line && a.col) loc += `:${a.col}`
  return loc
}

function formatErrorBullet(line: LogLine): string {
  const loc = formatErrorLocation(line)
  const title = line.annotation?.title
  const msg = line.text.trim().split('\n')[0] || '(empty message)'
  const parts: string[] = []
  if (loc) parts.push(loc)
  if (title) parts.push(title)
  parts.push(msg)
  return `  - ${parts.join('  ')}`
}

export async function buildFixPrompt(taskId: string, ctx: FixContext): Promise<string> {
  const cached = actionsState[taskId]?.logsByJob[ctx.jobId]?.text
  let raw: string | null = cached ?? null
  if (raw == null) {
    try {
      raw = (await ipc.getGithubWorkflowLog(taskId, ctx.jobId)).text
    } catch {
      raw = null
    }
  }

  const header = `The GitHub Actions job "${ctx.jobName}" on workflow run #${ctx.runNumber} (${ctx.workflowName}) failed.`
  const ghCommand = `To see the full log, run from this worktree:\n\n\`\`\`\ngh run view --log-failed --job ${ctx.jobId}\n\`\`\``
  const closing = 'Please diagnose the root cause and fix the code so this job passes.'

  if (raw == null) {
    return `${header}\n\nThe failure log could not be fetched from this app. ${ghCommand}\n\n${closing}`
  }

  const lines = parseGhLogs(raw)
  const sections: string[] = [header]

  // `--log-failed` only emits logs from the failing step(s), so any step name
  // surfaced here corresponds to a step that actually failed.
  const steps = Array.from(new Set(
    lines.map(l => l.step).filter((s): s is string => !!s),
  ))
  if (steps.length === 1) sections.push(`Failing step: ${steps[0]}`)
  else if (steps.length > 1) sections.push(`Failing steps: ${steps.join(', ')}`)

  const errors = lines.filter(l => l.level === 'error')
  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_ERRORS_IN_PROMPT).map(formatErrorBullet)
    const heading = errors.length === 1 ? 'Error:' : `Errors (${errors.length}):`
    const more = errors.length > MAX_ERRORS_IN_PROMPT
      ? `\n  ... and ${errors.length - MAX_ERRORS_IN_PROMPT} more in the full log`
      : ''
    sections.push(`${heading}\n${shown.join('\n')}${more}`)
  }

  sections.push(ghCommand)
  sections.push(closing)
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Polling — runs while any workflow is queued/in_progress, stops when settled.
// Single-loop-per-task; re-arms whenever tab is mounted + runs are active.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000
const pollTimers = new Map<string, ReturnType<typeof setInterval>>()

export function startPolling(taskId: string): void {
  if (pollTimers.has(taskId)) return
  const timer = setInterval(() => {
    if (!isAnyRunActive(taskId)) {
      stopPolling(taskId)
      return
    }
    refreshWorkflowRuns(taskId)
  }, POLL_INTERVAL_MS)
  pollTimers.set(taskId, timer)
}

export function stopPolling(taskId: string): void {
  const timer = pollTimers.get(taskId)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(taskId)
  }
}

let listenersInitialized = false

export async function initActionsListeners(): Promise<void> {
  if (listenersInitialized) return
  listenersInitialized = true
  await listen<{ taskId: string, scopes: string[] }>('github-remote-invalidated', (event) => {
    const { taskId, scopes } = event.payload
    if (actionsState[taskId] && scopes.includes('actions')) {
      refreshWorkflowRuns(taskId)
    }
  })
}
