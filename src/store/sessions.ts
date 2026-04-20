import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Session, SessionOutputEvent, SessionStatusEvent, OutputItem, Attachment, ToolApprovalRequest, PolicyAutoApprovedEvent, RateLimitInfo } from '../types'
import { setTasks, taskById } from './tasks'
import { markTaskUnread, markTaskAttention, clearTaskAttention, markSessionUnread } from './ui'
import { dequeueArmedStep, disarmAllSteps, clearSteps } from './steps'
import * as ipc from '../lib/ipc'
import { notify } from '../lib/notifications'
import { deserializeAttachments } from '../lib/binary'
import { clearSessionContext } from './sessionContext'

const MAX_ITEMS_IN_MEMORY = 50_000

export const [sessions, setSessions] = createStore<Session[]>([])
export const [outputItems, setOutputItems] = createStore<Record<string, OutputItem[]>>({})
export const [pendingApprovals, setPendingApprovals] = createStore<Record<string, ToolApprovalRequest[]>>({})
export const [autoApprovedCounts, setAutoApprovedCounts] = createStore<Record<string, number>>({})
export const [sessionCosts, setSessionCosts] = createStore<Record<string, number>>({})
export const [sessionTokens, setSessionTokens] = createStore<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>({})
/// Tracks sessions whose CLI is in the middle of a graceful shutdown after abort.
/// Set on abort click, cleared when the backend emits `session-aborted`.
export const [abortingSessions, setAbortingSessions] = createStore<Record<string, boolean>>({})
export const [rateLimitInfo, setRateLimitInfo] = createSignal<RateLimitInfo | null>(null)

/**
 * Backstop for cross-window session sync: when the window becomes visible,
 * refresh sessions for every task currently in the store. The session-created
 * / session-removed events cover the common case, but a missed event (e.g. the
 * user was on another desktop) would leave the sidebar stale until reload.
 */
export function initSessionWindowFocusRefresh(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const taskIds = Array.from(new Set(sessions.map(s => s.taskId)))
    for (const tid of taskIds) loadSessions(tid)
  })
}

export async function loadSessions(taskId: string) {
  const list = await ipc.listSessions(taskId)
  // Merge — keep sessions from other tasks, replace sessions for this task
  setSessions(prev => [...prev.filter(s => s.taskId !== taskId), ...list])
  // Seed session costs from persisted data
  for (const s of list) {
    if (s.totalCost > 0) setSessionCosts(s.id, s.totalCost)
  }
}

export async function createSession(taskId: string, agentType: string, model?: string): Promise<Session> {
  const session = await ipc.createSession(taskId, agentType, model)
  // Dedup vs the session-created broadcast: Rust emits to all windows including
  // the source, and the broadcast can land before this await resolves.
  setSessions(produce(s => { if (!s.find(x => x.id === session.id)) s.push(session) }))
  setOutputItems(session.id, [])
  return session
}

export function updateSessionModel(sessionId: string, model: string | null) {
  setSessions(s => s.id === sessionId, 'model', model)
  ipc.updateSessionModel(sessionId, model)
}

export async function sendMessage(sessionId: string, message: string, attachments?: Attachment[], model?: string, planMode?: boolean, thinkingMode?: boolean, fastMode?: boolean) {
  const images = attachments
    ?.filter(a => a.mimeType.startsWith('image/'))
    .map(a => ({ mimeType: a.mimeType, data: a.data }))

  const item: OutputItem = {
    kind: 'userMessage',
    text: message,
    timestamp: Date.now(),
    ...(images && images.length > 0 ? { images } : {}),
  }

  setOutputItems(produce(store => {
    const existing = store[sessionId]
    if (existing) {
      existing.push(item)
    } else {
      store[sessionId] = [item]
    }
  }))
  setSessions(s => s.id === sessionId, 'status', 'running')
  try {
    await ipc.sendMessage(sessionId, message, attachments, model, planMode, thinkingMode, fastMode)
  } catch (e) {
    setSessions(s => s.id === sessionId, 'status', 'idle')
    throw e
  }
}

export async function abortMessage(sessionId: string) {
  setAbortingSessions(sessionId, true)
  setSessions(s => s.id === sessionId, 'status', 'idle')
  try {
    await ipc.abortMessage(sessionId)
  } catch (e) {
    setAbortingSessions(produce(store => { delete store[sessionId] }))
    setSessions(s => s.id === sessionId, 'status', 'running')
    throw e
  }
}

export async function approveToolUse(requestId: string, sessionId: string) {
  await ipc.respondToApproval(requestId, 'allow')
  removeApproval(requestId, sessionId)
}

export async function denyToolUse(requestId: string, sessionId: string, message?: string) {
  await ipc.respondToApproval(requestId, 'deny', undefined, message)
  removeApproval(requestId, sessionId)
}

export async function answerQuestion(requestId: string, sessionId: string, answers: Record<string, string>, originalInput: Record<string, unknown>) {
  await ipc.respondToApproval(requestId, 'allow', { ...originalInput, answers })
  removeApproval(requestId, sessionId)
}

function removeApproval(requestId: string, sessionId: string) {
  setPendingApprovals(produce(store => {
    const list = store[sessionId]
    if (list) {
      const idx = list.findIndex(r => r.requestId === requestId)
      if (idx >= 0) list.splice(idx, 1)
      if (list.length === 0) delete store[sessionId]
    }
  }))
  // Clear attention indicator if no more pending approvals for this task
  const session = sessions.find(s => s.id === sessionId)
  if (session) {
    const taskSessions = sessions.filter(s => s.taskId === session.taskId)
    const hasRemaining = taskSessions.some(s => {
      const approvals = pendingApprovals[s.id]
      return approvals && approvals.length > 0
    })
    if (!hasRemaining) clearTaskAttention(session.taskId)
  }
}

export async function closeSession(sessionId: string) {
  // Clear any steps
  clearSteps(sessionId)
  // Remove from local store
  setSessions(prev => prev.filter(s => s.id !== sessionId))
  // Clean up output and usage from memory
  setOutputItems(produce(store => { delete store[sessionId] }))
  setSessionCosts(produce(store => { delete store[sessionId] }))
  setSessionTokens(produce(store => { delete store[sessionId] }))
  setAbortingSessions(produce(store => { delete store[sessionId] }))
  loadedSessionOutputs.delete(sessionId)
  // Persist closure to DB (status = 'closed', filtered from future loads)
  await ipc.closeSession(sessionId)
}

// Sessions whose output_lines have been pulled from SQLite in this window.
// Live streaming (session-output events) keeps the in-memory store fresh after
// the first load, so re-fetching on every task/session switch is pure waste —
// and it's not cheap: every NDJSON line round-trips through JSON.parse.
// Invalidated on clearOutputItems, closeSession, session-removed.
const loadedSessionOutputs = new Set<string>()

export async function loadOutputLines(sessionId: string) {
  if (loadedSessionOutputs.has(sessionId)) return
  const lines = await ipc.getOutputLines(sessionId)
  loadedSessionOutputs.add(sessionId)
  const items: OutputItem[] = []
  for (const l of lines) {
    const parsed = parseNdjsonLine(l.line, l.emittedAt)
    if (parsed) items.push(...parsed)
  }
  // Don't overwrite live items (from sendMessage/streaming) when DB returned nothing
  const current = outputItems[sessionId]
  if (current && current.length > 0 && items.length === 0) return
  setOutputItems(sessionId, items)
  // Accumulate costs + tokens from replayed output
  let replayCost = 0
  let replayInputTokens = 0
  let replayOutputTokens = 0
  let replayCacheRead = 0
  let replayCacheWrite = 0
  for (const item of items) {
    if (item.kind === 'turnEnd') {
      if (item.cost) replayCost += item.cost
      if (item.inputTokens) replayInputTokens += item.inputTokens
      if (item.outputTokens) replayOutputTokens += item.outputTokens
      if (item.cacheReadTokens) replayCacheRead += item.cacheReadTokens
      if (item.cacheWriteTokens) replayCacheWrite += item.cacheWriteTokens
    }
  }
  if (replayCost > 0) setSessionCosts(sessionId, replayCost)
  if (replayInputTokens > 0 || replayOutputTokens > 0) {
    setSessionTokens(sessionId, { input: replayInputTokens, output: replayOutputTokens, cacheRead: replayCacheRead, cacheWrite: replayCacheWrite })
  }
}

/** Re-parse a persisted NDJSON line back into OutputItems (mirrors Rust parse_sdk_event) */
function parseNdjsonLine(line: string, emittedAt?: number): OutputItem[] | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }

  const type = v.type as string | undefined

  // Our synthetic user message
  if (type === 'verun_user_message') {
    return [{ kind: 'userMessage', text: v.text as string, timestamp: emittedAt }]
  }

  // Per-turn snapshot marker — attach the message uuid to the most recent
  // assistant block so the "fork from here" affordance has a stable id.
  if (type === 'verun_turn_snapshot') {
    const uuid = v.messageUuid as string | undefined
    if (uuid) return [{ kind: 'turnSnapshot', messageUuid: uuid }]
    return null
  }

  // Pre-parsed items persisted by Rust - all agent-specific parsing lives in Rust only
  if (type === 'verun_items') {
    const items = v.items as OutputItem[]
    if (!items?.length) return null
    for (const item of items) {
      if (item.kind === 'turnEnd' && emittedAt && !item.timestamp) {
        (item as any).timestamp = emittedAt
      }
    }
    return items
  }

  return null
}

export async function clearOutputItems(sessionId: string) {
  setOutputItems(sessionId, [])
  loadedSessionOutputs.delete(sessionId)
  // Also clear the Claude session context + persisted output in DB
  await ipc.clearSession(sessionId)
  setSessions(s => s.id === sessionId, 'resumeSessionId', null)
}

export async function syncSessionStatuses() {
  try {
    const activeIds = await ipc.getActiveSessions()
    const activeSet = new Set(activeIds)
    for (const s of sessions) {
      if (s.status === 'running' && !activeSet.has(s.id)) {
        setSessions(sess => sess.id === s.id, 'status', 'idle')
      } else if (s.status !== 'running' && activeSet.has(s.id)) {
        setSessions(sess => sess.id === s.id, 'status', 'running')
      }
    }
  } catch {
    // Backend may not be ready yet during startup
  }
}

/** Try to drain armed steps — call after editing finishes if session might be idle */
export function tryDrainSteps(sessionId: string) {
  const session = sessions.find(s => s.id === sessionId)
  if (session?.status === 'idle') {
    const next = dequeueArmedStep(sessionId)
    if (next) {
      const attachments = next.attachmentsJson ? deserializeAttachments(next.attachmentsJson) : undefined
      sendMessage(next.sessionId, next.message, attachments, next.model ?? undefined, next.planMode ?? undefined, next.thinkingMode ?? undefined, next.fastMode ?? undefined)
    }
  }
}

export const sessionsForTask = (taskId: string) =>
  sessions.filter(s => s.taskId === taskId)

export const sessionById = (id: string) =>
  sessions.find(s => s.id === id)

// Event listeners — call once at app mount

let listenersInitialized = false

export async function initSessionListeners() {
  if (listenersInitialized) return
  listenersInitialized = true

  await listen<SessionOutputEvent>('session-output', (event) => {
    const { sessionId, items } = event.payload
    const now = Date.now()
    for (const item of items) {
      if ((item.kind === 'userMessage' || item.kind === 'turnEnd') && !item.timestamp) {
        (item as { timestamp?: number }).timestamp = now
      }
    }
    setOutputItems(produce(store => {
      const existing = store[sessionId]
      if (existing) {
        existing.push(...items)
        if (existing.length > MAX_ITEMS_IN_MEMORY) {
          store[sessionId] = existing.slice(-MAX_ITEMS_IN_MEMORY)
        }
      } else {
        store[sessionId] = [...items]
      }
    }))
    for (const item of items) {
      if (item.kind === 'turnEnd') {
        if (item.cost) {
          setSessionCosts(produce(store => {
            store[sessionId] = (store[sessionId] || 0) + item.cost!
          }))
        }
        if (item.inputTokens || item.outputTokens) {
          setSessionTokens(produce(store => {
            const prev = store[sessionId] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            store[sessionId] = {
              input: prev.input + (item.inputTokens || 0),
              output: prev.output + (item.outputTokens || 0),
              cacheRead: prev.cacheRead + (item.cacheReadTokens || 0),
              cacheWrite: prev.cacheWrite + (item.cacheWriteTokens || 0),
            }
          }))
        }
      }
    }
  })

  await listen<SessionStatusEvent>('session-status', (event) => {
    const { sessionId, status, error } = event.payload
    const prevSession = sessions.find(s => s.id === sessionId)
    const wasRunning = prevSession?.status === 'running'
    setSessions(s => s.id === sessionId, 'status', status)
    setSessions(s => s.id === sessionId, 'error', status === 'error' ? error : undefined)
    // Clear pending approvals when session stops running
    if (status !== 'running') {
      setPendingApprovals(produce(store => { delete store[sessionId] }))
    }
    // Drain armed steps on idle — but only if this idle didn't come from an
    // abort that's still graceful-shutting-down. Spawning a new `--resume`
    // process while the old one is still writing its JSONL races the transcript
    // and the queued message gets eaten. Deferred drain happens in the
    // `session-aborted` listener below.
    if (status === 'idle' && !abortingSessions[sessionId]) {
      const next = dequeueArmedStep(sessionId)
      if (next) {
        const attachments = next.attachmentsJson ? JSON.parse(next.attachmentsJson) : undefined
        sendMessage(next.sessionId, next.message, attachments, next.model ?? undefined, next.planMode ?? undefined, next.thinkingMode ?? undefined, next.fastMode ?? undefined)
      }
    }
    // Disarm all steps on error (keep them, just stop auto-send)
    if (status === 'error') {
      disarmAllSteps(sessionId)
    }
    // Mark unread + OS notification on completion/error
    if (wasRunning && (status === 'idle' || status === 'error') && prevSession) {
      markTaskUnread(prevSession.taskId)
      markSessionUnread(sessionId)
      const taskName = taskById(prevSession.taskId)?.name || 'Task'
      notify({
        title: status === 'error' ? 'Task failed' : 'Task completed',
        body: taskName,
        taskId: prevSession.taskId,
        sessionId,
      })
    }
  })

  await listen<ToolApprovalRequest>('tool-approval-request', (event) => {
    const req = event.payload
    setPendingApprovals(produce(store => {
      const existing = store[req.sessionId]
      if (existing) {
        existing.push(req)
      } else {
        store[req.sessionId] = [req]
      }
    }))
    // Mark task as needing attention + OS notification
    const session = sessions.find(s => s.id === req.sessionId)
    if (session) {
      markTaskAttention(session.taskId)
      const taskName = taskById(session.taskId)?.name || 'Task'
      const isQuestion = req.toolName === 'AskUserQuestion'
      notify({
        title: isQuestion ? 'Question from task' : 'Approval needed',
        body: isQuestion
          ? `${taskName}: ${(req.toolInput?.question as string)?.slice(0, 100) || 'has a question'}`
          : `${taskName}: ${req.toolName}`,
        taskId: session.taskId,
        sessionId: req.sessionId,
      })
    }
  })

  await listen<{ sessionId: string; name: string }>('session-name', (event) => {
    const { sessionId, name } = event.payload
    setSessions(s => s.id === sessionId, 'name', name)
  })

  await listen<string>('session-aborted', (event) => {
    const sid = event.payload
    setAbortingSessions(produce(store => { delete store[sid] }))
    // Now that graceful shutdown is done, drain any armed step that the
    // session-status:idle listener skipped to avoid racing the transcript.
    const session = sessions.find(s => s.id === sid)
    if (session?.status === 'idle') {
      const next = dequeueArmedStep(sid)
      if (next) {
        const attachments = next.attachmentsJson ? deserializeAttachments(next.attachmentsJson) : undefined
        sendMessage(next.sessionId, next.message, attachments, next.model ?? undefined, next.planMode ?? undefined, next.thinkingMode ?? undefined, next.fastMode ?? undefined)
      }
    }
  })

  // Cross-window session lifecycle. New sessions or closes happening in another
  // window must reflect locally so the sidebar's per-task phase chip stays in
  // sync without forcing a full reload.
  await listen<Session>('session-created', (event) => {
    const s = event.payload
    if (sessions.some(x => x.id === s.id)) return
    setSessions(produce(list => { list.push(s) }))
    if (s.totalCost > 0) setSessionCosts(s.id, s.totalCost)
  })

  await listen<{ sessionId: string; taskId: string | null }>('session-removed', (event) => {
    const { sessionId } = event.payload
    setSessions(prev => prev.filter(s => s.id !== sessionId))
    setOutputItems(produce(store => { delete store[sessionId] }))
    setPendingApprovals(produce(store => { delete store[sessionId] }))
    setSessionCosts(produce(store => { delete store[sessionId] }))
    setSessionTokens(produce(store => { delete store[sessionId] }))
    loadedSessionOutputs.delete(sessionId)
    clearSteps(sessionId)
  })

  await listen<{ taskId: string; name: string }>('task-name', (event) => {
    const { taskId, name } = event.payload
    setTasks(t => t.id === taskId, 'name', name)
  })

  await listen<PolicyAutoApprovedEvent>('policy-auto-approved', (event) => {
    const { sessionId } = event.payload
    setAutoApprovedCounts(produce(store => {
      store[sessionId] = (store[sessionId] || 0) + 1
    }))
  })

  await listen<RateLimitInfo>('rate-limit-info', (event) => {
    setRateLimitInfo(event.payload)
  })

  // Re-fetch any pending approvals that survived a frontend reload
  try {
    const pending = await ipc.getPendingApprovals()
    for (const req of pending) {
      setPendingApprovals(produce(store => {
        const existing = store[req.sessionId]
        if (existing) {
          if (!existing.some(e => e.requestId === req.requestId)) {
            existing.push(req)
          }
        } else {
          store[req.sessionId] = [req]
        }
      }))
    }
  } catch {
    // getPendingApprovals may not be available yet during startup
  }
}

export function clearSessionContextsForTask(taskId: string) {
  for (const s of sessionsForTask(taskId)) clearSessionContext(s.id)
}

export function cleanupSessionStorage(sessionId: string) {
  localStorage.removeItem(`verun:draft-msg:${sessionId}`)
  localStorage.removeItem(`verun:draft-att:${sessionId}`)
}
