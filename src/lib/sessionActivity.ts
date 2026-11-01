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
    running: status === 'running' || phase === 'working',
    approval: approval || phase === 'waiting',
    error: status === 'error' || phase === 'failed',
    unknown: phase === 'unknown',
  }
}
