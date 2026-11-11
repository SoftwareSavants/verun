import { createMemo, createRoot } from 'solid-js'
import { sessionActivity } from './activity'
import { sessions, pendingApprovals } from './sessions'
import { tasks, taskById, isTaskCreating, isTaskArchiving, getTaskError } from './tasks'
import { taskGit } from './git'
import { effectiveActivity } from '../lib/sessionActivity'
import { agentsWorking, taskBoardState, type TaskStatus } from '../lib/taskBoard'

interface SessionRollup { running: boolean; background: boolean; error: boolean; approval: boolean; unknown: boolean }

// Roll every open session up to its task once, shared by every caller.
// Waiting and running count from any session. A failure counts only from the
// task's newest session: an old crashed one that was never closed shouldn't
// flag a task whose current session is fine.
const sessionRollup = createRoot(() => createMemo(() => {
  const result = new Map<string, SessionRollup>()
  const newest = new Map<string, { startedAt: number; error: boolean }>()
  for (const session of sessions) {
    if (session.closedAt) continue
    const state = result.get(session.taskId) ?? { running: false, background: false, error: false, approval: false, unknown: false }
    const observed = effectiveActivity(session.status, (pendingApprovals[session.id]?.length ?? 0) > 0, sessionActivity[session.id]?.phase, sessionActivity[session.id]?.background)
    state.running ||= observed.running
    state.background ||= observed.background
    state.approval ||= observed.approval
    state.unknown ||= observed.unknown
    const latest = newest.get(session.taskId)
    if (!latest || session.startedAt >= latest.startedAt) newest.set(session.taskId, { startedAt: session.startedAt, error: observed.error })
    result.set(session.taskId, state)
  }
  for (const [taskId, latest] of newest) result.get(taskId)!.error = latest.error
  return result
}))

/** Where a task stands right now. The sidebar and the board both read this. */
export function taskStatus(taskId: string): TaskStatus {
  const task = taskById(taskId)
  const git = taskGit(taskId)
  const state = sessionRollup().get(taskId)
  return taskBoardState({
    ...state,
    archived: task?.archived,
    error: !!getTaskError(taskId) || state?.error,
    creating: isTaskCreating(taskId),
    archiving: isTaskArchiving(taskId),
    conflicts: git.pr?.state === 'OPEN' && git.pr.mergeable === 'CONFLICTING',
    failedChecks: git.pr?.state === 'OPEN' && git.checks.some(c => c.status === 'FAILURE' || c.status === 'ERROR'),
    merged: git.pr?.state === 'MERGED',
    prOpen: git.pr?.state === 'OPEN',
  })
}

/** Tasks with agents working, in a turn or in the background: what keep-awake and restart guard. */
export const workingTaskCount = () => tasks.filter(t => !t.archived && agentsWorking(taskStatus(t.id))).length

export const needsYou = (taskId: string) => taskStatus(taskId).column === 'attention'
