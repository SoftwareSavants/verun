import type { Session } from '../types'

/**
 * Whether we can spawn a Claude PTY for this session. Terminal mode requires
 * a claude agent and a resumable session id — the first turn must have
 * reached `system:init` before `claude --resume <id>` will work.
 */
export function canUseTerminalView(session: Session | null | undefined): boolean {
  return !!session && session.agentType === 'claude' && !!session.resumeSessionId
}

/**
 * Format file paths for typing into a terminal stdin. Each path is wrapped in
 * single quotes (POSIX-safe for spaces and most metacharacters) and trailing
 * single quotes inside paths are escaped with the standard `'\''` idiom. A
 * trailing space lets the user keep typing after the inserted paths, matching
 * the behavior of native macOS terminals when files are dragged in.
 */
export function formatDroppedPathsForTerminal(paths: string[]): string {
  if (paths.length === 0) return ''
  return paths.map(p => `'${p.replace(/'/g, "'\\''")}' `).join('')
}
