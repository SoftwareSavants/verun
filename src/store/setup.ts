import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { AttachmentRef } from '../types'
import * as ipc from '../lib/ipc'
import { registerHookTerminal } from './terminals'
import { selectedTaskId, setShowTerminal } from './ui'
import { isTaskOwnedByThisWindow } from '../lib/windowContext'

interface SetupState {
  status: 'running' | 'failed'
  error?: string
  terminalId?: string
  hookType?: 'setup' | 'destroy'
}

interface QueuedMessage {
  sessionId: string
  message: string
  attachments?: AttachmentRef[]
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
export const hookTerminalId = (taskId: string) => setupTasks[taskId]?.terminalId

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

  await listen<{ taskId: string; status: string; error?: string; terminalId?: string; hookType?: string }>('setup-hook', (event) => {
    const { taskId, status, error, terminalId, hookType } = event.payload

    if (!isTaskOwnedByThisWindow(taskId)) return

    if (status === 'running') {
      setSetupTasks(taskId, { status: 'running', terminalId, hookType: hookType as 'setup' | 'destroy' })
      // Register the hook terminal tab and auto-show the terminal panel
      if (terminalId) {
        const ht = (hookType === 'destroy' ? 'destroy' : 'setup') as 'setup' | 'destroy'
        registerHookTerminal(taskId, terminalId, ht)
        if (selectedTaskId() === taskId) setShowTerminal(true)
      }
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
      setSetupTasks(taskId, { status: 'failed', error, terminalId, hookType: hookType as 'setup' | 'destroy' })
      clearQueuedMessage(taskId)
    }
  })

  // Sync on frontend reload — check which tasks still have setup running
  try {
    const ids = await ipc.getSetupInProgress()
    for (const id of ids) {
      if (isTaskOwnedByThisWindow(id)) {
        setSetupTasks(id, { status: 'running' })
      }
    }
  } catch {
    // Backend may not be ready yet during startup
  }
}
