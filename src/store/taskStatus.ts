import { createMemo, createRoot } from 'solid-js'
import { sessionActivity } from './activity'
import { sessions, pendingApprovals } from './sessions'
import { taskById, isTaskCreating, isTaskArchiving, getTaskError } from './tasks'
import { taskGit } from './git'
import { effectiveActivity } from '../lib/sessionActivity'
import { taskBoardState, type TaskStatus } from '../lib/taskBoard'

interface SessionRollup { running: boolean; error: boolean; approval: boolean; unknown: boolean }

// Roll every open session up to its task once, shared by every caller.
const sessionRollup = createRoot(() => createMemo(() => {
  const result = new Map<string, SessionRollup>()
  for (const session of sessions) {
    if (session.closedAt) continue
    const state = result.get(session.taskId) ?? { running: false, error: false, approval: false, unknown: false }
    const observed = effectiveActivity(session.status, (pendingApprovals[session.id]?.length ?? 0) > 0, sessionActivity[session.id]?.phase)
    state.running ||= observed.running
    state.error ||= observed.error
    state.approval ||= observed.approval
    state.unknown ||= observed.unknown
    result.set(session.taskId, state)
  }
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

export const needsYou = (taskId: string) => taskStatus(taskId).column === 'attention'
