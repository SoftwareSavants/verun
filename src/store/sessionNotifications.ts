import { createEffect, createRoot } from 'solid-js'
import { notify } from '../lib/notifications'
import { notificationFor, workState, type SessionNotification, type WorkState } from '../lib/sessionNotifications'
import { ELICITATION_TOOL_NAME, parseElicitation } from '../lib/mcpElicitation'
import { sessions, pendingApprovals, abortingSessions } from './sessions'
import { sessionActivity } from './activity'
import { taskById } from './tasks'
import { markTaskUnread, markSessionUnread } from './ui'
import type { Session, ToolApprovalRequest } from '../types'

function body(kind: SessionNotification, name: string, approval: ToolApprovalRequest | undefined): { title: string; body: string } {
  if (kind === 'completed') return { title: 'Task completed', body: name }
  if (kind === 'failed') return { title: 'Task failed', body: name }
  if (!approval) return { title: 'Claude needs you', body: `${name} is waiting for your input` }
  if (approval.toolName === 'AskUserQuestion') {
    return { title: 'Question from task', body: `${name}: ${(approval.toolInput?.question as string)?.slice(0, 100) || 'has a question'}` }
  }
  if (approval.toolName === ELICITATION_TOOL_NAME) {
    return { title: 'Question from task', body: `${name}: ${parseElicitation(approval.toolInput).message.slice(0, 100) || 'an MCP server needs input'}` }
  }
  return { title: 'Approval needed', body: `${name}: ${approval.prompt?.title ?? approval.toolName}` }
}

function send(kind: SessionNotification, session: Session, approval: ToolApprovalRequest | undefined) {
  if (kind !== 'needs-input') {
    markTaskUnread(session.taskId)
    markSessionUnread(session.id)
  }
  const name = session.name || taskById(session.taskId)?.name || 'Task'
  notify({ ...body(kind, name, approval), taskId: session.taskId, sessionId: session.id })
}

/**
 * The one place that decides session notifications, for chat and terminal
 * sessions alike: it watches each session's work state and notifies only when
 * work actually finishes, fails or needs the user (see lib/sessionNotifications).
 */
export function initSessionNotifications() {
  createRoot(() => {
    const previous = new Map<string, WorkState>()
    createEffect(() => {
      const live = new Set<string>()
      for (const session of sessions) {
        if (session.closedAt) continue
        live.add(session.id)
        const activity = sessionActivity[session.id]
        const approvals = pendingApprovals[session.id] ?? []
        const next = workState(session.status, approvals.length > 0, activity?.phase)
        if (next === null) continue
        const userStopped = !!abortingSessions[session.id] || !!activity?.interrupted || activity?.phase === 'ended'
        const kind = notificationFor(previous.get(session.id), next, userStopped)
        previous.set(session.id, next)
        if (kind) send(kind, session, approvals[0])
      }
      for (const id of previous.keys()) if (!live.has(id)) previous.delete(id)
    })
  })
}
