import { createStore } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import { sessionActivitySnapshot } from '../lib/ipc'
import { acceptActivity, type SessionActivity } from '../lib/sessionActivity'

export const [sessionActivity, setSessionActivity] = createStore<Record<string, SessionActivity>>({})
export async function initActivityListeners() {
  const accept = (activity: SessionActivity) => {
    if (acceptActivity(sessionActivity[activity.sessionId]?.revision, activity.revision)) {
      setSessionActivity(activity.sessionId, activity)
    }
  }
  await listen<SessionActivity>('session-activity', event => accept(event.payload))
  for (const activity of await sessionActivitySnapshot()) accept(activity)
}
