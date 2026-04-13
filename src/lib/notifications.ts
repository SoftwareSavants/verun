import { createSignal } from 'solid-js'
import { selectedTaskId, addToast, dismissToast } from '../store/ui'
import * as ipc from './ipc'

// User preference — persisted to localStorage, default enabled
const PREF_KEY = 'verun:notificationsEnabled'
const PROMPTED_KEY = 'verun:notificationsPrompted'
const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PREF_KEY) : null
export const [notificationsEnabled, setNotificationsEnabled] = createSignal(saved !== 'false')

export function setNotificationsEnabledAndPersist(v: boolean) {
  setNotificationsEnabled(v)
  localStorage.setItem(PREF_KEY, String(v))
}

function wasPrompted(): boolean {
  return localStorage.getItem(PROMPTED_KEY) === 'true'
}

function markPrompted() {
  localStorage.setItem(PROMPTED_KEY, 'true')
}

const TOAST_ID = 'notification-prompt'

/** Call on app mount. Shows an opt-in toast on first launch. */
export function initNotifications() {
  if (!wasPrompted()) {
    addToast('Enable desktop notifications for task updates?', 'info', {
      id: TOAST_ID,
      persistent: true,
      onDismiss: () => {
        markPrompted()
        setNotificationsEnabledAndPersist(false)
      },
      actions: [
        {
          label: 'Enable',
          variant: 'primary',
          onClick: () => {
            markPrompted()
            dismissToast(TOAST_ID)
          },
        },
      ],
    })
  }
}

// Suppress if the user is already looking at this task
function shouldSuppress(taskId: string): boolean {
  const appFocused = document.visibilityState === 'visible'
  const taskSelected = selectedTaskId() === taskId
  return appFocused && taskSelected
}

// Simple 1s throttle to avoid notification spam
let lastNotifyTime = 0
const MIN_INTERVAL = 1000

export interface NotifyOpts {
  title: string
  body: string
  taskId: string
}

export async function notify(opts: NotifyOpts): Promise<void> {
  if (!notificationsEnabled()) return
  if (shouldSuppress(opts.taskId)) return
  const now = Date.now()
  if (now - lastNotifyTime < MIN_INTERVAL) return
  lastNotifyTime = now
  ipc.sendNotification(opts.title, opts.body)
}
