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

/**
 * A new task's first prompt goes where the user will watch it. In terminal view
 * it starts `claude` itself; sending it through a chat process too would run a
 * second Claude on the same session and fork the conversation (#277).
 */
export function firstPromptTarget(agentType: string, viewMode: 'ui' | 'terminal'): 'terminal' | 'chat' {
  return agentType === 'claude' && viewMode === 'terminal' ? 'terminal' : 'chat'
}

const pendingTerminalPrompts = new Map<string, string>()
/** Hold a prompt for the session's terminal to start with when it opens. */
export function setPendingTerminalPrompt(sessionId: string, prompt: string) {
  pendingTerminalPrompts.set(sessionId, prompt)
}
/** The held prompt, once: a reopened terminal must not resend it. */
export function takePendingTerminalPrompt(sessionId: string): string | undefined {
  const prompt = pendingTerminalPrompts.get(sessionId)
  pendingTerminalPrompts.delete(sessionId)
  return prompt
}
