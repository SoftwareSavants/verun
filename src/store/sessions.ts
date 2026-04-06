import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Session, SessionOutputEvent, SessionStatusEvent, OutputItem, Attachment } from '../types'
import * as ipc from '../lib/ipc'

const MAX_ITEMS_IN_MEMORY = 50_000

export const [sessions, setSessions] = createStore<Session[]>([])
export const [outputItems, setOutputItems] = createStore<Record<string, OutputItem[]>>({})

export async function loadSessions(taskId: string) {
  const list = await ipc.listSessions(taskId)
  setSessions(list)
}

export async function createSession(taskId: string): Promise<Session> {
  const session = await ipc.createSession(taskId)
  setSessions(produce(s => s.push(session)))
  setOutputItems(session.id, [])
  return session
}

export async function sendMessage(sessionId: string, message: string, attachments?: Attachment[], model?: string) {
  const images = attachments
    ?.filter(a => a.mimeType.startsWith('image/'))
    .map(a => ({ mimeType: a.mimeType, dataBase64: a.dataBase64 }))

  const item: OutputItem = {
    kind: 'userMessage',
    text: message,
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
  await ipc.sendMessage(sessionId, message, attachments, model)
}

export async function abortMessage(sessionId: string) {
  await ipc.abortMessage(sessionId)
}

export function closeSession(sessionId: string) {
  // Remove from local store (keeps in DB for potential restore)
  setSessions(prev => prev.filter(s => s.id !== sessionId))
  // Clean up output from memory
  setOutputItems(produce(store => { delete store[sessionId] }))
}

export async function loadOutputLines(sessionId: string) {
  const lines = await ipc.getOutputLines(sessionId)
  const items: OutputItem[] = []
  for (const l of lines) {
    const parsed = parseNdjsonLine(l.line)
    if (parsed) items.push(...parsed)
  }
  setOutputItems(sessionId, items)
}

/** Re-parse a persisted NDJSON line back into OutputItems (mirrors Rust parse_sdk_event) */
function parseNdjsonLine(line: string): OutputItem[] | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }

  const type = v.type as string | undefined

  // Our synthetic user message
  if (type === 'verun_user_message') {
    return [{ kind: 'userMessage', text: v.text as string }]
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

  // Skip system, result, rate_limit_event, etc.
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
  })

  await listen<SessionStatusEvent>('session-status', (event) => {
    const { sessionId, status } = event.payload
    setSessions(s => s.id === sessionId, 'status', status)
  })
}
