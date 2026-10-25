import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import type { AgentRow } from '../lib/accounts'

/**
 * What an agent row of a picker is called: the agent, then its account when it
 * has accounts to choose from (`Claude Code · Acme`), with the account's color.
 * It shrinks and truncates the name inside a flex row.
 */
export const AgentRowName: Component<{ row: AgentRow; class?: string }> = (props) => (
  <span class={clsx('min-w-0 flex items-center gap-1.5', props.class)}>
    <span class="truncate">{props.row.name}</span>
    <Show when={props.row.choice?.color}>
      {(color) => (
        <span data-testid="account-color" aria-hidden="true" class="w-2 h-2 rounded-full shrink-0" style={{ 'background-color': color() }} />
      )}
    </Show>
  </span>
)
