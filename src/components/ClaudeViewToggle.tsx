import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { sessionViewMode, setSessionViewMode } from '../store/sessionViewMode'
import { canUseTerminalView } from '../lib/terminalMode'
import type { Session } from '../types'

interface Props {
  session: Session | undefined | null
  sessionId: string | null | undefined
}

/**
 * UI / Terminal pill toggle shown above the chat for Claude sessions. Renders
 * nothing for other agents or when no session is selected. The Terminal pill
 * is disabled until the session has a resumable id.
 */
export const ClaudeViewToggle: Component<Props> = (props) => {
  const enabled = () => canUseTerminalView(props.session)
  const mode = () => sessionViewMode(props.sessionId)

  return (
    <Show when={props.session?.agentType === 'claude' && props.sessionId}>
      <div
        class="flex items-center justify-end px-3 py-1 border-b border-border-subtle bg-surface-1"
        data-testid="claude-view-toggle"
      >
        <div class="inline-flex items-center rounded-full bg-surface-2 ring-1 ring-outline/8 text-[11px]">
          <button
            data-testid="claude-view-toggle-ui"
            class={clsx(
              'px-2.5 py-0.5 rounded-full transition-colors',
              mode() === 'ui'
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-primary'
            )}
            onClick={() => {
              const sid = props.sessionId
              if (sid) setSessionViewMode(sid, 'ui')
            }}
          >
            UI
          </button>
          <button
            data-testid="claude-view-toggle-terminal"
            disabled={!enabled()}
            class={clsx(
              'px-2.5 py-0.5 rounded-full transition-colors',
              !enabled()
                ? 'text-text-dim/60 cursor-not-allowed'
                : mode() === 'terminal'
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted hover:text-text-primary'
            )}
            onClick={() => {
              const sid = props.sessionId
              if (sid && enabled()) setSessionViewMode(sid, 'terminal')
            }}
            title={
              enabled()
                ? 'Run claude --resume in a real terminal'
                : 'Send a message first - the terminal view needs a resumable Claude session'
            }
          >
            Terminal
          </button>
        </div>
      </div>
    </Show>
  )
}
