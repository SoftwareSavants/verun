export type ActivityPhase = 'unknown' | 'idle' | 'working' | 'waiting' | 'failed' | 'ended'
export interface SessionActivity {
  sessionId: string
  launch: string
  revision: number
  phase: ActivityPhase
  harness: string
  source: string
  coverage: 'full' | 'partial' | 'unavailable'
  pending: string[]
}
export function acceptActivity(current: number | undefined, incoming: number): boolean {
  return current === undefined || incoming > current
}
export function effectiveActivity(status: string, approval: boolean, phase?: ActivityPhase) {
  return {
    // 'background': the turn ended but subagents or background shells still run.
    running: status === 'running' || status === 'background' || phase === 'working',
    approval: approval || phase === 'waiting',
    error: status === 'error' || phase === 'failed',
    unknown: phase === 'unknown',
  }
}
/** True on the transition into waiting, so a wait notifies once, not on every update. */
export function startedWaiting(previous: ActivityPhase | undefined, next: ActivityPhase): boolean {
  return next === 'waiting' && previous !== 'waiting'
}
const isWorking = (status: string | undefined) => status === 'running' || status === 'background'
/** A working session settled: notify and mark it unread. A turn handing off to background agents is not done. */
export function finishedWork(previous: string | undefined, next: string): boolean {
  return isWorking(previous) && (next === 'idle' || next === 'error')
}
/** Approvals belong to work in flight; a background subagent's request outlives its parent's turn. */
export function clearsPendingApprovals(status: string): boolean {
  return !isWorking(status)
}
