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

/**
 * Approximate cell dimensions for a monospace xterm at the given font size.
 * Used to pre-size a PTY before xterm has had a chance to mount and measure
 * exact metrics. The numbers come from typical macOS monospace fonts
 * (SF Mono / Menlo at lineHeight: 1.0).
 */
export function estimatePtyDimensions(width: number, height: number, fontSize: number): { rows: number; cols: number } {
  if (width <= 0 || height <= 0 || fontSize <= 0) return { rows: 24, cols: 80 }
  const cellWidth = fontSize * 0.6
  const cellHeight = fontSize * 1.2
  return {
    rows: Math.max(10, Math.floor(height / cellHeight)),
    cols: Math.max(20, Math.floor(width / cellWidth)),
  }
}
