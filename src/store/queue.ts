import { createStore, produce } from 'solid-js/store'
import type { Attachment } from '../types'

export interface QueuedMessage {
  id: string
  sessionId: string
  message: string
  attachments?: Attachment[]
  model?: string
  planMode?: boolean
  thinkingMode?: boolean
  fastMode?: boolean
  editing?: boolean
}

const [messageQueue, setMessageQueue] = createStore<Record<string, QueuedMessage[]>>({})

export function enqueueMessage(msg: QueuedMessage) {
  setMessageQueue(produce(store => {
    if (!store[msg.sessionId]) store[msg.sessionId] = []
    store[msg.sessionId].push(msg)
  }))
}

export function dequeueMessage(sessionId: string): QueuedMessage | undefined {
  const queue = messageQueue[sessionId]
  if (!queue || queue.length === 0) return undefined
  // Pause if the front message is being edited
  if (queue[0].editing) return undefined
  let result: QueuedMessage | undefined
  setMessageQueue(produce(store => {
    result = store[sessionId]?.shift()
  }))
  return result
}

export function removeQueuedMessage(sessionId: string, messageId: string) {
  setMessageQueue(produce(store => {
    const queue = store[sessionId]
    if (!queue) return
    const idx = queue.findIndex(m => m.id === messageId)
    if (idx !== -1) queue.splice(idx, 1)
  }))
}

export function updateQueuedMessage(sessionId: string, messageId: string, updates: Partial<Pick<QueuedMessage, 'message' | 'editing'>>) {
  setMessageQueue(produce(store => {
    const queue = store[sessionId]
    if (!queue) return
    const msg = queue.find(m => m.id === messageId)
    if (!msg) return
    if (updates.message !== undefined) msg.message = updates.message
    if (updates.editing !== undefined) msg.editing = updates.editing
  }))
}

export function clearQueue(sessionId: string) {
  setMessageQueue(produce(store => { delete store[sessionId] }))
}

export function getQueue(sessionId: string | undefined): QueuedMessage[] {
  if (!sessionId) return []
  return messageQueue[sessionId] || []
}

/** Remove only this message from the queue, return it. Other queued messages stay and resume after. */
export function sendNowFromQueue(sessionId: string, messageId: string): QueuedMessage | undefined {
  let target: QueuedMessage | undefined
  setMessageQueue(produce(store => {
    const queue = store[sessionId]
    if (!queue) return
    const idx = queue.findIndex(m => m.id === messageId)
    if (idx === -1) return
    target = { ...queue[idx] }
    queue.splice(idx, 1)
  }))
  return target
}
