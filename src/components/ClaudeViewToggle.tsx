import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { Terminal, MessageSquare } from 'lucide-solid'
import { sessionViewMode, setSessionViewMode, setClaudeDefaultViewMode } from '../store/sessionViewMode'
import { canUseTerminalView } from '../lib/terminalMode'
import type { Session } from '../types'

interface Props {
  session: Session | undefined | null
  sessionId: string | null | undefined
  /**
   * The active session tab keeps the toggle visible. Inactive tabs collapse
   * it to zero width via a smooth transition - the control stays in the DOM
   * but is non-interactive and takes no visual space.
   */
  active: boolean
}

/**
 * Tiny 2-segment icon control inside the Claude session tab. Both icons are
 * always visible so it reads as a toggle at a glance; the active mode gets
 * an accent background, the other is muted. Click either to switch.
 *
 * Eligibility (Claude agent + resumable session id) controls whether the
 * outer slot exists at all - non-Claude or first-turn sessions render
 * nothing. Among eligible sessions, the `active` prop drives an animated
 * collapse so the tab width slides smoothly when the user changes which
 * session is selected, instead of snapping.
 */
export const ClaudeViewToggle: Component<Props> = (props) => {
  const enabled = () => canUseTerminalView(props.session)
  const mode = () => sessionViewMode(props.sessionId)

  const stop = (e: MouseEvent) => e.stopPropagation()
  const select = (next: 'ui' | 'terminal') => (e: MouseEvent) => {
    e.stopPropagation()
    const sid = props.sessionId
    if (!sid) return
    setSessionViewMode(sid, next)
    // Sticky last-used: bump the global default so newly-created sessions
    // inherit the user's most recent choice. They can still override per
    // session, and Settings → General → Claude Code remains the place to
    // pin a specific default if they want to opt out of the learning.
    setClaudeDefaultViewMode(next)
  }

  return (
    <Show when={props.session?.agentType === 'claude' && props.sessionId && enabled()}>
      <div
        data-testid="claude-view-toggle"
        data-active={props.active}
        aria-hidden={!props.active}
        class={clsx(
          'shrink-0 overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none',
          // -ml-1.5 cancels the parent's gap-1.5 when collapsed so we don't
          // leave a phantom 6px gap; ml-0 lets the gap apply when expanded.
          props.active
            ? 'max-w-12 opacity-100 ml-0 pointer-events-auto'
            : 'max-w-0 opacity-0 -ml-1.5 pointer-events-none',
        )}
        onClick={stop}
      >
        <div class="inline-flex items-center rounded bg-surface-2 ring-1 ring-outline/8">
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
      </div>
    </Show>
  )
}
