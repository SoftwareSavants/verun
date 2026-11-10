import { effectiveActivity, type ActivityPhase } from './sessionActivity'

/** Where a session's work stands, whether it runs in chat or the terminal. */
export type WorkState = 'working' | 'needs-input' | 'failed' | 'finished'
export type SessionNotification = 'completed' | 'failed' | 'needs-input'

/**
 * One reading of a session for notifications: the chat status, its pending
 * approvals and the terminal hooks feed the same states. `null` when the
 * terminal can't be read, so an unknown status never looks like a finish.
 */
export function workState(status: string, approval: boolean, phase?: ActivityPhase): WorkState | null {
  if (phase === 'unknown') return null
  const a = effectiveActivity(status, approval, phase)
  if (a.approval) return 'needs-input'
  if (a.error) return 'failed'
  if (a.running) return 'working'
  return 'finished'
}

/**
 * The notification a transition deserves. Only work that ran and then ended
 * counts as completed; a stop the user made, a first sighting (app start) or
 * an unchanged state stays quiet.
 */
export function notificationFor(
  previous: WorkState | undefined,
  next: WorkState,
  userStopped: boolean,
): SessionNotification | null {
  if (previous === undefined || previous === next) return null
  if (next === 'needs-input') return 'needs-input'
  if (previous !== 'working') return null
  if (next === 'failed') return 'failed'
  if (next === 'finished') return userStopped ? null : 'completed'
  return null
}
