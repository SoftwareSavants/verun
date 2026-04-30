import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { Terminal, MessageSquare } from 'lucide-solid'
import { sessionViewMode, setSessionViewMode } from '../store/sessionViewMode'
import { canUseTerminalView } from '../lib/terminalMode'
import type { Session } from '../types'

interface Props {
  session: Session | undefined | null
  sessionId: string | null | undefined
}

/**
 * Tiny icon toggle that lives inside the Claude session tab. The icon shows
 * the *target* mode (what you'll switch to on click), matching the macOS
 * convention where the icon represents the action, not the current state.
 * Renders nothing for non-Claude sessions or when the session lacks a
 * resumable id (terminal view requires `claude --resume <id>`).
 */
export const ClaudeViewToggle: Component<Props> = (props) => {
  const enabled = () => canUseTerminalView(props.session)
  const mode = () => sessionViewMode(props.sessionId)
  const isTerminal = () => mode() === 'terminal'

  return (
    <Show when={props.session?.agentType === 'claude' && props.sessionId && enabled()}>
      <button
        data-testid="claude-view-toggle"
        class={clsx(
          'shrink-0 p-0.5 rounded transition-colors',
          isTerminal()
            ? 'text-accent hover:text-accent-hover'
            : 'text-text-dim hover:text-text-secondary',
        )}
        title={isTerminal() ? 'Switch to UI view' : 'Switch to terminal view (claude --resume)'}
        onClick={(e) => {
          e.stopPropagation()
          const sid = props.sessionId
          if (!sid) return
          setSessionViewMode(sid, isTerminal() ? 'ui' : 'terminal')
        }}
      >
        {isTerminal() ? <MessageSquare size={10} /> : <Terminal size={10} />}
      </button>
    </Show>
  )
}
