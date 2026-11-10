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
  /** The turn ended on the user's Esc / Ctrl-C, not on Claude finishing. */
  interrupted?: boolean
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
const isWorking = (status: string | undefined) => status === 'running' || status === 'background'
/** Approvals belong to work in flight; a background subagent's request outlives its parent's turn. */
export function clearsPendingApprovals(status: string): boolean {
  return !isWorking(status)
}
