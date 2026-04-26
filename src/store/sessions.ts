import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Session, SessionOutputEvent, SessionStatusEvent, OutputItem, AttachmentRef, ToolApprovalRequest, PolicyAutoApprovedEvent, RateLimitInfo } from '../types'
import { setTasks, taskById } from './tasks'
import { markTaskUnread, markTaskAttention, clearTaskAttention, markSessionUnread } from './ui'
import { addStep, dequeueArmedStep, disarmAllSteps, clearSteps } from './steps'
import * as ipc from '../lib/ipc'
import { notify } from '../lib/notifications'
import { deserializeAttachments } from '../lib/binary'
import {
  appendCodexLivePlanDelta,
  clearCodexLivePlan,
  clearSessionContext,
  setPlanFilePathForSession,
} from './sessionContext'

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

export async function reopenSession(sessionId: string): Promise<Session> {
  const session = await ipc.reopenSession(sessionId)
  // Rust broadcasts session-created on reopen (mirrors createSession); same
  // dedup against the broadcast landing before this await resolves.
  setSessions(produce(s => { if (!s.find(x => x.id === session.id)) s.push(session) }))
  return session
}

export function updateSessionModel(sessionId: string, model: string | null) {
  setSessions(s => s.id === sessionId, 'model', model)
  ipc.updateSessionModel(sessionId, model)
}

export async function sendMessage(sessionId: string, message: string, attachments?: AttachmentRef[], model?: string, planMode?: boolean, thinkingMode?: boolean, fastMode?: boolean) {
  const images = attachments?.filter(a => a.mimeType.startsWith('image/'))

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

/// Steer: queue the new message as an armed step, then abort the current turn.
/// session-aborted fires once graceful shutdown is done, and its listener
/// drains the armed step. Sending inline races the interrupt and hits Rust's
/// busy guard, which silently fails and leaves the UI desynced.
export async function steerSession(
  sessionId: string,
  message: string,
  attachments: AttachmentRef[] | undefined,
  model: string | undefined,
  planMode: boolean | undefined,
  thinkingMode: boolean | undefined,
  fastMode: boolean | undefined,
) {
  addStep({ sessionId, message, attachments, armed: true, model, planMode, thinkingMode, fastMode })
  await abortMessage(sessionId)
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
  outputPageState.delete(sessionId)
  // Persist closure to DB (status = 'closed', filtered from future loads)
  await ipc.closeSession(sessionId)
}

// Sessions whose output_lines have been pulled from SQLite in this window.
// Live streaming (session-output events) keeps the in-memory store fresh after
// the first load, so re-fetching on every task/session switch is pure waste —
// and it's not cheap: every NDJSON line round-trips through JSON.parse.
// Invalidated on clearOutputItems, closeSession, session-removed.
const loadedSessionOutputs = new Set<string>()

// Initial hydration is intentionally tight: 250 NDJSON lines parses + paints
// in a few tens of ms even on long-running sessions. Older history is fetched
// on demand via loadOlderOutputLines when the chat scrolls near the top.
export const INITIAL_OUTPUT_LINES_LIMIT = 250
export const OLDER_OUTPUT_PAGE_SIZE = 250

interface OutputPageState {
  oldestLineId: number | null
  hasMore: boolean
  loading: boolean
}
const outputPageState = new Map<string, OutputPageState>()

export function hasMoreOutputLines(sessionId: string): boolean {
  return outputPageState.get(sessionId)?.hasMore ?? false
}

export async function loadOutputLines(sessionId: string) {
  if (loadedSessionOutputs.has(sessionId)) return
  const lines = await ipc.getOutputLines(sessionId, INITIAL_OUTPUT_LINES_LIMIT)
  loadedSessionOutputs.add(sessionId)
  outputPageState.set(sessionId, {
    oldestLineId: lines.length > 0 ? lines[0].id : null,
    hasMore: lines.length === INITIAL_OUTPUT_LINES_LIMIT,
    loading: false,
  })
  const items: OutputItem[] = []
  for (const l of lines) {
    const parsed = parseNdjsonLine(l.line, l.emittedAt)
    if (parsed) items.push(...parsed)
  }
  // Don't overwrite live items (from sendMessage/streaming) when DB returned nothing
  const current = outputItems[sessionId]
  if (current && current.length > 0 && items.length === 0) return
  setOutputItems(sessionId, items)
  // Cost: trust the seed from `loadSessions` (DB-maintained `total_cost`).
  // Summing replayed turnEnd costs only sees the last 250 lines, so it would
  // clobber the authoritative DB total with a partial sum.
  // Tokens: there's no persisted aggregate, so ask the backend to scan
  // output_lines and sum every turnEnd's token fields once per session load.
  try {
    const totals = await ipc.getSessionTokenTotals(sessionId)
    if (totals.input > 0 || totals.output > 0 || totals.cacheRead > 0 || totals.cacheWrite > 0) {
      setSessionTokens(sessionId, totals)
    }
  } catch {
    // Best-effort — a stale token chip is preferable to a thrown promise that
    // breaks the surrounding chat-load flow.
  }
}

/** Fetch the next page of older output_lines and prepend them to the in-memory
 *  store. Returns the number of OutputItems added, or 0 when there's nothing
 *  more to load (or a fetch is already in flight). */
export async function loadOlderOutputLines(sessionId: string): Promise<number> {
  const state = outputPageState.get(sessionId)
  if (!state || !state.hasMore || state.loading || state.oldestLineId == null) return 0
  state.loading = true
  try {
    const lines = await ipc.getOutputLines(sessionId, OLDER_OUTPUT_PAGE_SIZE, state.oldestLineId)
    if (lines.length === 0) {
      state.hasMore = false
      return 0
    }
    const olderItems: OutputItem[] = []
    for (const l of lines) {
      const parsed = parseNdjsonLine(l.line, l.emittedAt)
      if (parsed) olderItems.push(...parsed)
    }
    const current = outputItems[sessionId] ?? []
    setOutputItems(sessionId, [...olderItems, ...current])
    state.oldestLineId = lines[0].id
    state.hasMore = lines.length === OLDER_OUTPUT_PAGE_SIZE
    return olderItems.length
  } finally {
    state.loading = false
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
    const rawAtts = v.attachments
    const images: AttachmentRef[] | undefined = Array.isArray(rawAtts)
      ? rawAtts
          .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
          .filter(a => typeof (a as { hash?: unknown }).hash === 'string'
            && typeof (a as { mimeType?: unknown }).mimeType === 'string'
            && (a as { mimeType: string }).mimeType.startsWith('image/'))
          .map(a => ({
            hash: String(a.hash),
            mimeType: String(a.mimeType),
            name: String(a.name ?? ''),
            size: Number(a.size ?? 0),
          }))
      : undefined
    return [{
      kind: 'userMessage',
      text: v.text as string,
      timestamp: emittedAt,
      ...(images && images.length > 0 ? { images } : {}),
    }]
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
  outputPageState.delete(sessionId)
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
      } else if (item.kind === 'codexPlanDelta') {
        appendCodexLivePlanDelta(sessionId, item.itemId, item.delta)
      } else if (item.kind === 'codexPlanReady') {
        // Flip from live streaming → file-backed viewer. MessageInput's
        // existing effect watches `planFilePathForSession` and reads the
        // markdown off disk so it restores on session reopen for free.
        clearCodexLivePlan(sessionId)
        if (item.filePath) {
          setPlanFilePathForSession(sessionId, item.filePath)
        }
      } else if (item.kind === 'userMessage') {
        // A new user turn invalidates any unresolved plan buffer.
        clearCodexLivePlan(sessionId)
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
        const attachments = next.attachmentsJson ? deserializeAttachments(next.attachmentsJson) : undefined
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
    outputPageState.delete(sessionId)
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
