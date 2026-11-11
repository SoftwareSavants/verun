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
  /** Background tasks Claude left unfinished at its last turn end. */
  background?: number
  /** Of those, subagents and background shells. */
  backgroundAgents?: number
  backgroundShells?: number
}
export function acceptActivity(current: number | undefined, incoming: number): boolean {
  return current === undefined || incoming > current
}
export function effectiveActivity(status: string, approval: boolean, phase?: ActivityPhase, background = 0) {
  const running = status === 'running' || phase === 'working'
  return {
    running,
    // The turn ended with subagents, shells or watchers still going: Claude
    // is at its prompt, so it's the user's turn, with work in the background.
    background: !running && (status === 'background' || background > 0),
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
