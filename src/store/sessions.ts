import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Session, SessionOutputEvent, SessionStatusEvent, OutputItem, Attachment, ToolApprovalRequest, PolicyAutoApprovedEvent, RateLimitInfo } from '../types'
import { setTasks, taskById } from './tasks'
import { markTaskUnread, markTaskAttention, clearTaskAttention } from './ui'
import * as ipc from '../lib/ipc'
import { notify } from '../lib/notifications'

const MAX_ITEMS_IN_MEMORY = 50_000

export const [sessions, setSessions] = createStore<Session[]>([])
export const [outputItems, setOutputItems] = createStore<Record<string, OutputItem[]>>({})
export const [pendingApprovals, setPendingApprovals] = createStore<Record<string, ToolApprovalRequest[]>>({})
export const [autoApprovedCounts, setAutoApprovedCounts] = createStore<Record<string, number>>({})
export const [sessionCosts, setSessionCosts] = createStore<Record<string, number>>({})
export const [sessionTokens, setSessionTokens] = createStore<Record<string, { input: number; output: number }>>({})
export const [rateLimitInfo, setRateLimitInfo] = createSignal<RateLimitInfo | null>(null)
export const [taskPlanMode, setTaskPlanMode] = createStore<Record<string, boolean>>({})
export const [taskThinkingMode, setTaskThinkingMode] = createStore<Record<string, boolean>>({})
export const [taskFastMode, setTaskFastMode] = createStore<Record<string, boolean>>({})
export const [taskPlanFilePath, setTaskPlanFilePath] = createStore<Record<string, string | null>>({})

export async function loadSessions(taskId: string) {
  const list = await ipc.listSessions(taskId)
  // Merge — keep sessions from other tasks, replace sessions for this task
  setSessions(prev => [...prev.filter(s => s.taskId !== taskId), ...list])
  // Seed session costs from persisted data
  for (const s of list) {
    if (s.totalCost > 0) setSessionCosts(s.id, s.totalCost)
  }
}

export async function createSession(taskId: string): Promise<Session> {
  const session = await ipc.createSession(taskId)
  setSessions(produce(s => s.push(session)))
  setOutputItems(session.id, [])
  return session
}

export async function sendMessage(sessionId: string, message: string, attachments?: Attachment[], model?: string, planMode?: boolean, thinkingMode?: boolean, fastMode?: boolean) {
  const images = attachments
    ?.filter(a => a.mimeType.startsWith('image/'))
    .map(a => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 }))

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
  setSessions(s => s.id === sessionId, 'status', 'idle')
  try {
    await ipc.abortMessage(sessionId)
  } catch (e) {
    setSessions(s => s.id === sessionId, 'status', 'running')
    throw e
  }
}

export async function approveToolUse(requestId: string, sessionId: string) {
  await ipc.respondToApproval(requestId, 'allow')
  removeApproval(requestId, sessionId)
}

export async function denyToolUse(requestId: string, sessionId: string) {
  await ipc.respondToApproval(requestId, 'deny')
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
  // Remove from local store
  setSessions(prev => prev.filter(s => s.id !== sessionId))
  // Clean up output and usage from memory
  setOutputItems(produce(store => { delete store[sessionId] }))
  setSessionCosts(produce(store => { delete store[sessionId] }))
  setSessionTokens(produce(store => { delete store[sessionId] }))
  // Persist closure to DB (status = 'closed', filtered from future loads)
  await ipc.closeSession(sessionId)
}

export async function loadOutputLines(sessionId: string, taskId: string) {
  const lines = await ipc.getOutputLines(sessionId)
  const items: OutputItem[] = []
  let lastPlanMode = false
  let lastThinkingMode = true
  let lastFastMode = false
  let planFilePath: string | null = null
  for (const l of lines) {
    try {
      const v = JSON.parse(l.line)
      // Check plan_mode on user messages for persistence
      if (v.type === 'verun_user_message' && typeof v.plan_mode === 'boolean') {
        lastPlanMode = v.plan_mode
      }
      if (v.type === 'verun_user_message' && typeof v.thinking_mode === 'boolean') {
        lastThinkingMode = v.thinking_mode
      }
      if (v.type === 'verun_user_message' && typeof v.fast_mode === 'boolean') {
        lastFastMode = v.fast_mode
      }
      // Extract plan file path from ExitPlanMode control_request
      if (v.type === 'control_request') {
        const req = v.request as Record<string, unknown> | undefined
        if (req?.tool_name === 'ExitPlanMode') {
          const input = req.input as Record<string, unknown> | undefined
          if (input?.planFilePath) {
            planFilePath = input.planFilePath as string
          }
        }
      }
    } catch { /* ignore */ }
    const parsed = parseNdjsonLine(l.line, l.emittedAt)
    if (parsed) items.push(...parsed)
  }
  setOutputItems(sessionId, items)
  setTaskPlanMode(taskId, lastPlanMode)
  setTaskThinkingMode(taskId, lastThinkingMode)
  setTaskFastMode(taskId, lastFastMode)
  setTaskPlanFilePath(taskId, planFilePath)
  // Accumulate costs + tokens from replayed output
  let replayCost = 0
  let replayInputTokens = 0
  let replayOutputTokens = 0
  for (const item of items) {
    if (item.kind === 'turnEnd') {
      if (item.cost) replayCost += item.cost
      if (item.inputTokens) replayInputTokens += item.inputTokens
      if (item.outputTokens) replayOutputTokens += item.outputTokens
    }
  }
  if (replayCost > 0) setSessionCosts(sessionId, replayCost)
  if (replayInputTokens > 0 || replayOutputTokens > 0) {
    setSessionTokens(sessionId, { input: replayInputTokens, output: replayOutputTokens })
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

  // Stream event (content_block_delta)
  if (type === 'stream_event') {
    const event = v.event as Record<string, unknown> | undefined
    if (!event) return null
    const eventType = event.type as string | undefined
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return null
      if (delta.type === 'text_delta' && delta.text) {
        return [{ kind: 'text', text: delta.text as string }]
      }
      if (delta.type === 'thinking_delta' && delta.thinking) {
        return [{ kind: 'thinking', text: delta.thinking as string }]
      }
    }
    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (!block) return null
      const blockType = block.type as string
      if (blockType === 'tool_use' || blockType === 'server_tool_use' || blockType === 'mcp_tool_use') {
        const input = block.input as Record<string, unknown> | undefined
        const inputStr = input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : ''
        return [{ kind: 'toolStart', tool: (block.name as string) || 'tool', input: inputStr }]
      }
    }
    return null
  }

  // User message (tool results)
  if (type === 'user') {
    const msg = v.message as Record<string, unknown> | undefined
    const content = msg?.content as Array<Record<string, unknown>> | undefined
    if (!content) return null
    const items: OutputItem[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        const text = extractText(block.content)
        if (text) items.push({ kind: 'toolResult', text, isError: block.is_error === true })
      }
    }
    return items.length > 0 ? items : null
  }

  // Control request (tool approval) — extract tool name for ToolStart
  if (type === 'control_request') {
    const request = v.request as Record<string, unknown> | undefined
    if (request?.subtype === 'can_use_tool') {
      const toolName = (request.tool_name as string) || 'tool'
      const input = request.input as Record<string, unknown> | undefined
      const inputStr = input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : ''
      return [{ kind: 'toolStart', tool: toolName, input: inputStr }]
    }
  }

  // Turn completed (result)
  if (type === 'result') {
    const subtype = (v.subtype as string) || 'unknown'
    const status = subtype === 'success' ? 'completed' : 'error'
    const cost = typeof v.total_cost_usd === 'number' ? v.total_cost_usd : undefined
    const usage = v.usage as Record<string, unknown> | undefined
    const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens as number : undefined
    const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens as number : undefined
    return [{ kind: 'turnEnd', status, timestamp: emittedAt, cost, inputTokens, outputTokens }]
  }

  // Skip system, rate_limit_event, etc.
  return null
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => (c as Record<string, unknown>)?.text || '').filter(Boolean).join('')
  }
  return ''
}

export async function clearOutputItems(sessionId: string) {
  setOutputItems(sessionId, [])
  // Also clear the Claude session context + persisted output in DB
  await ipc.clearSession(sessionId)
  // Reset the local session's claudeSessionId so next message starts fresh
  setSessions(s => s.id === sessionId, 'claudeSessionId', null)
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
    // Accumulate cost + tokens from turnEnd events
    for (const item of items) {
      if (item.kind === 'turnEnd') {
        if (item.cost) {
          setSessionCosts(produce(store => {
            store[sessionId] = (store[sessionId] || 0) + item.cost!
          }))
        }
        if (item.inputTokens || item.outputTokens) {
          setSessionTokens(produce(store => {
            const prev = store[sessionId] || { input: 0, output: 0 }
            store[sessionId] = {
              input: prev.input + (item.inputTokens || 0),
              output: prev.output + (item.outputTokens || 0),
            }
          }))
        }
      }
    }
    // Mark task as unread if it's not currently selected
    const session = sessions.find(s => s.id === sessionId)
    if (session) markTaskUnread(session.taskId)
  })

  await listen<SessionStatusEvent>('session-status', (event) => {
    const { sessionId, status } = event.payload
    const prevSession = sessions.find(s => s.id === sessionId)
    const wasRunning = prevSession?.status === 'running'
    setSessions(s => s.id === sessionId, 'status', status)
    // Clear pending approvals when session stops running
    if (status !== 'running') {
      setPendingApprovals(produce(store => { delete store[sessionId] }))
    }
    // OS notification on completion/error
    if (wasRunning && (status === 'idle' || status === 'error') && prevSession) {
      const taskName = taskById(prevSession.taskId)?.name || 'Task'
      notify({
        title: status === 'error' ? 'Task failed' : 'Task completed',
        body: taskName,
        taskId: prevSession.taskId,
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
      })
    }
  })

  await listen<{ sessionId: string; name: string }>('session-name', (event) => {
    const { sessionId, name } = event.payload
    setSessions(s => s.id === sessionId, 'name', name)
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
