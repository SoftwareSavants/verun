import type { Session } from '../types'

/**
 * Whether we can spawn a Claude PTY for this session. Terminal mode requires
 * a claude agent and a resumable session id — the first turn must have
 * reached `system:init` before `claude --resume <id>` will work.
 */
export function canUseTerminalView(session: Session | null | undefined): boolean {
  return !!session && session.agentType === 'claude' && !!session.resumeSessionId
}
