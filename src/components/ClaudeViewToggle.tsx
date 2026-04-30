import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { Terminal, MessageSquare } from 'lucide-solid'
import { sessionViewMode, setSessionViewMode } from '../store/sessionViewMode'
import { canUseTerminalView } from '../lib/terminalMode'
import type { Session } from '../types'

interface Props {
  session: Session | undefined | null
  sessionId: string | null | undefined
  /**
   * Only render when this session tab is the active one. Toggling the view
   * mode of a non-visible session has no observable effect (the user is
   * looking at a different session), so we hide the control there to avoid
   * the dead-click confusion.
   */
  active: boolean
}

/**
 * Tiny 2-segment icon control inside the Claude session tab. Both icons are
 * always visible so it reads as a toggle at a glance; the active mode gets
 * an accent background, the other is muted. Click either to switch.
 *
 * Renders nothing for non-Claude sessions or sessions without a resumable id
 * (the terminal view spawns `claude --resume <id>`, so first-turn sessions
 * have nothing to resume yet).
 */
export const ClaudeViewToggle: Component<Props> = (props) => {
  const enabled = () => canUseTerminalView(props.session)
  const mode = () => sessionViewMode(props.sessionId)

  const stop = (e: MouseEvent) => e.stopPropagation()
  const select = (next: 'ui' | 'terminal') => (e: MouseEvent) => {
    e.stopPropagation()
    const sid = props.sessionId
    if (sid) setSessionViewMode(sid, next)
  }

  return (
    <Show when={props.active && props.session?.agentType === 'claude' && props.sessionId && enabled()}>
      <div
        data-testid="claude-view-toggle"
        class="shrink-0 inline-flex items-center rounded bg-surface-2 ring-1 ring-outline/8"
        onClick={stop}
      >
        <button
          data-testid="claude-view-toggle-ui"
          class={clsx(
            'flex items-center justify-center w-4 h-4 rounded-l transition-colors',
            mode() === 'ui'
              ? 'bg-accent/20 text-accent'
              : 'text-text-dim hover:text-text-secondary',
          )}
          title="UI view"
          onClick={select('ui')}
        >
          <MessageSquare size={9} />
        </button>
        <button
          data-testid="claude-view-toggle-terminal"
          class={clsx(
            'flex items-center justify-center w-4 h-4 rounded-r transition-colors',
            mode() === 'terminal'
              ? 'bg-accent/20 text-accent'
              : 'text-text-dim hover:text-text-secondary',
          )}
          title="Terminal view"
          onClick={select('terminal')}
        >
          <Terminal size={9} />
        </button>
      </div>
    </Show>
  )
}
