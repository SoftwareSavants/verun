import { Component } from 'solid-js'
import { clsx } from 'clsx'
import { claudeDefaultViewMode, setClaudeDefaultViewMode } from '../store/sessionViewMode'

/**
 * Settings-page picker that controls the app-wide default view (UI or Terminal)
 * for new Claude sessions. Per-session overrides set via ClaudeViewToggle take
 * precedence over this default.
 */
export const ClaudeDefaultViewPicker: Component = () => {
  const mode = () => claudeDefaultViewMode()
  return (
    <div
      class="inline-flex items-center rounded-full bg-surface-2 ring-1 ring-outline/8 text-xs"
      data-testid="claude-default-view-picker"
    >
      <button
        data-testid="claude-default-view-picker-ui"
        class={clsx(
          'px-3 py-1 rounded-full transition-colors',
          mode() === 'ui'
            ? 'bg-accent/20 text-accent'
            : 'text-text-muted hover:text-text-primary'
        )}
        onClick={() => setClaudeDefaultViewMode('ui')}
      >
        UI
      </button>
      <button
        data-testid="claude-default-view-picker-terminal"
        class={clsx(
          'px-3 py-1 rounded-full transition-colors',
          mode() === 'terminal'
            ? 'bg-accent/20 text-accent'
            : 'text-text-muted hover:text-text-primary'
        )}
        onClick={() => setClaudeDefaultViewMode('terminal')}
      >
        Terminal
      </button>
    </div>
  )
}
