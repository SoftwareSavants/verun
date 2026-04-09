import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Attachment } from '../types'
import * as ipc from '../lib/ipc'

interface SetupState {
  status: 'running' | 'failed'
  error?: string
}

interface QueuedMessage {
  sessionId: string
  message: string
  attachments?: Attachment[]
  model?: string
  planMode?: boolean
  thinkingMode?: boolean
  fastMode?: boolean
}

export const [setupTasks, setSetupTasks] = createStore<Record<string, SetupState>>({})
export const [queuedMessages, setQueuedMessages] = createStore<Record<string, QueuedMessage>>({})

export const isSetupRunning = (taskId: string) => setupTasks[taskId]?.status === 'running'
export const setupFailed = (taskId: string) => setupTasks[taskId]?.status === 'failed'
export const setupError = (taskId: string) => setupTasks[taskId]?.error

export function queueMessage(taskId: string, msg: QueuedMessage) {
  setQueuedMessages(taskId, msg)
}

export function clearQueuedMessage(taskId: string) {
  setQueuedMessages(produce(store => { delete store[taskId] }))
}

let initialized = false

export async function initSetupListeners() {
  if (initialized) return
  initialized = true

  await listen<{ taskId: string; status: string; error?: string }>('setup-hook', (event) => {
    const { taskId, status, error } = event.payload

    if (status === 'running') {
      setSetupTasks(taskId, { status: 'running' })
    } else if (status === 'completed') {
      setSetupTasks(produce(store => { delete store[taskId] }))
      // Auto-send any queued message
      const queued = queuedMessages[taskId]
      if (queued) {
        clearQueuedMessage(taskId)
        import('./sessions').then(({ sendMessage }) => {
          sendMessage(queued.sessionId, queued.message, queued.attachments, queued.model, queued.planMode, queued.thinkingMode, queued.fastMode)
        })
      }
    } else if (status === 'failed') {
      setSetupTasks(taskId, { status: 'failed', error })
      clearQueuedMessage(taskId)
    }
  })

  // Sync on frontend reload — check which tasks still have setup running
  try {
    const ids = await ipc.getSetupInProgress()
    for (const id of ids) {
      setSetupTasks(id, { status: 'running' })
    }
  } catch {
    // Backend may not be ready yet during startup
  }
}
