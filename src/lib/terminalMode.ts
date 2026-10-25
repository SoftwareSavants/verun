import type { ClipboardPaste, Session } from '../types'

/**
 * Whether we can spawn a Claude PTY for this session. Any Claude session
 * qualifies — fresh ones spawn `claude --session-id <pre-generated-uuid>`
 * (the backend generates the UUID and persists it so subsequent reopens
 * use `--resume <uuid>`), and existing ones use `--resume`.
 */
export function canUseTerminalView(session: Session | null | undefined): boolean {
  return !!session && session.agentType === 'claude'
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

/** Text to bracket-paste into a terminal: files and images go in as quoted paths. */
export function terminalPasteText(clip: ClipboardPaste): string {
  if (clip.kind === 'files') return formatDroppedPathsForTerminal(clip.paths)
  if (clip.kind === 'image') return formatDroppedPathsForTerminal([clip.path])
  return clip.text
}
