import { Component, For, Show, createUniqueId } from 'solid-js'
import { Select } from './Select'
import { accountById, defaultIdentity, liveAccountsFor, projectAccountId } from '../store/accounts'
import { addToast } from '../store/ui'
import { notifyAccountError } from '../lib/accountErrors'
import * as ipc from '../lib/ipc'
import { AGENT_DISPLAY_NAMES, type AgentType } from '../types'

/** The option that clears the binding: the harness runs on the user's own login. */
const DEFAULT = 'default'

const HARNESSES = Object.keys(AGENT_DISPLAY_NAMES) as AgentType[]

/**
 * Settings of one project, Accounts: which account new sessions use, for each
 * harness that has an added account to choose from. The selects show the
 * accounts store, which the backend keeps current with `accounts-changed`, so
 * a choice only reports how it went. Sessions already running keep theirs.
 */
export const ProjectAccountsSettings: Component<{ projectId: string }> = (props) => {
  const harnesses = () => HARNESSES.filter((agent) => liveAccountsFor(agent).length > 0)

  return (
    <Show when={harnesses().length > 0}>
      <div class="mb-8">
        <h2 class="section-title mb-1.5">Accounts</h2>
        <p class="text-xs text-text-dim mb-4">New sessions in this project use these accounts. Existing sessions keep theirs.</p>
        <div class="space-y-4">
          <For each={harnesses()}>{(agent) => <HarnessRow projectId={props.projectId} agentType={agent} />}</For>
        </div>
      </div>
    </Show>
  )
}

interface RowProps {
  projectId: string
  agentType: AgentType
}

/** One harness: the account its new sessions use in the project. */
const HarnessRow: Component<RowProps> = (props) => {
  const id = createUniqueId()
  const name = () => AGENT_DISPLAY_NAMES[props.agentType]

  const options = () => {
    const email = defaultIdentity(props.agentType)?.email
    return [
      { value: DEFAULT, label: email ? `Default · ${email}` : 'Default' },
      ...liveAccountsFor(props.agentType).map((a) => ({ value: a.id, label: a.label })),
    ]
  }

  const value = () => projectAccountId(props.projectId, props.agentType) ?? DEFAULT

  const choose = async (next: string) => {
    if (next === value()) return
    const accountId = next === DEFAULT ? null : next
    const who = accountById(accountId)?.label ?? 'Default'
    try {
      await ipc.setProjectAccount(props.projectId, props.agentType, accountId)
      addToast(`${name()} account set to ${who}`, 'success')
    } catch (e) {
      if (!notifyAccountError(e)) addToast(String(e), 'error')
    }
  }

  return (
    <div class="flex items-center justify-between gap-4">
      <label for={id} class="text-sm text-text-primary">{name()}</label>
      <div class="w-64 shrink-0">
        <Select id={id} label={name()} value={value()} options={options()} onChange={(next) => void choose(next)} />
      </div>
    </div>
  )
}
