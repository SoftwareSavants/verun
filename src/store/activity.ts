import { createStore } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import { sessionActivitySnapshot } from '../lib/ipc'
import { acceptActivity, startedWaiting, type SessionActivity } from '../lib/sessionActivity'
import { notify } from '../lib/notifications'
import { sessions } from './sessions'
import { taskById } from './tasks'

export const [sessionActivity, setSessionActivity] = createStore<Record<string, SessionActivity>>({})

// Terminal sessions answer their own approvals and questions inside Claude, so
// there is no approval request to notify on. The waiting phase is the signal.
function notifyWaiting(activity: SessionActivity) {
  const session = sessions.find(s => s.id === activity.sessionId)
  if (!session) return
  const name = session.name || taskById(session.taskId)?.name || 'Task'
  notify({ title: 'Claude needs you', body: `${name} is waiting for your input in the terminal`, taskId: session.taskId, sessionId: session.id })
}

export async function initActivityListeners() {
  const accept = (activity: SessionActivity, live: boolean) => {
    const previous = sessionActivity[activity.sessionId]
    if (!acceptActivity(previous?.revision, activity.revision)) return
    setSessionActivity(activity.sessionId, activity)
    if (live && startedWaiting(previous?.phase, activity.phase)) notifyWaiting(activity)
  }
  await listen<SessionActivity>('session-activity', event => accept(event.payload, true))
  for (const activity of await sessionActivitySnapshot()) accept(activity, false)
}
