import { produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'
import type { ForkTarget } from '../lib/ipc'
import type { Session } from '../types'
import { setSessions, loadOutputLines, sendMessage } from './sessions'
import { setTasks } from './tasks'
import { setSelectedTaskId, setSelectedSessionIdForTask } from './ui'
import { planModeForSession, thinkingModeForSession, fastModeForSession } from './sessionContext'
import { sessionViewMode, setSessionViewMode } from './sessionViewMode'
import { setPendingTerminalPrompt } from '../lib/terminalMode'

/** Fork into a new session of the same task and open it. `messageUuid: null` forks it all. */
export async function forkInTask(sessionId: string, messageUuid: string | null, target?: ForkTarget): Promise<Session> {
  const session = await ipc.forkSessionInTask(sessionId, messageUuid, target)
  setSessions(produce(s => { if (!s.find(x => x.id === session.id)) s.push(session) }))
  await loadOutputLines(session.id)
  setSelectedSessionIdForTask(session.taskId, session.id)
  return session
}

/** Fork into a new task with its own worktree and open it. */
export async function forkToNewTask(sessionId: string, messageUuid: string | null, worktreeState: 'snapshot' | 'current', target?: ForkTarget) {
  const tws = await ipc.forkSessionToNewTask(sessionId, messageUuid, worktreeState, target)
  setTasks(produce(t => { if (!t.find(x => x.id === tws.task.id)) t.unshift(tws.task) }))
  setSessions(produce(s => { if (!s.find(x => x.id === tws.session.id)) s.push(tws.session) }))
  await loadOutputLines(tws.session.id)
  setSelectedTaskId(tws.task.id)
  setSelectedSessionIdForTask(tws.task.id, tws.session.id)
  return tws
}

/**
 * Carry a session that ran out of usage over to another account: fork all of
 * it there, in the view it was in, and send `message` to pick up where it stopped.
 */
export async function continueOnAccount(sessionId: string, target: ForkTarget, message: string, model?: string | null): Promise<Session> {
  const session = await forkInTask(sessionId, null, target)
  if (sessionViewMode(sessionId) === 'terminal') {
    setSessionViewMode(session.id, 'terminal')
    setPendingTerminalPrompt(session.id, message)
  } else {
    await sendMessage(session.id, message, undefined, model ?? undefined, planModeForSession(sessionId), thinkingModeForSession(sessionId), fastModeForSession(sessionId))
  }
  return session
}
