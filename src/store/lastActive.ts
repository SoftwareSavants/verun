import { createStore } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { sessions } from './sessions'

// When each task was last active (a turn starting, ending or being stopped,
// in chat or the terminal), for ordering tasks by recency. Rust records it;
// this mirrors the record and the live events that move it.
const [lastActive, setLastActive] = createStore<Record<string, number>>({})

const touch = (sessionId: string) => {
  const taskId = sessions.find(s => s.id === sessionId)?.taskId
  if (taskId) setLastActive(taskId, Math.max(lastActive[taskId] ?? 0, Date.now()))
}

export async function initLastActive() {
  await Promise.all([
    listen<{ sessionId: string }>('session-status', e => touch(e.payload.sessionId)),
    listen<string>('session-touched', e => touch(e.payload)),
  ])
  setLastActive(await ipc.taskLastActive())
}

export const lastActiveAt = (task: { id: string; createdAt: number }) => lastActive[task.id] ?? task.createdAt
