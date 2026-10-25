import { Component, For, Show, createSignal, createUniqueId, onMount } from 'solid-js'
import { Plus } from 'lucide-solid'
import SvgIcon from './SvgIcon'
import { AccountDialog } from './AccountDialog'
import { AccountTerminalDialog } from './AccountTerminalDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Toggle } from './Toggle'
import { agents } from '../store/agents'
import { defaultIdentity, liveAccountsFor, loadAccounts } from '../store/accounts'
import { addToast } from '../store/ui'
import { agentIcon, meetsVersionReq } from '../lib/agents'
import { notifyAccountError } from '../lib/accountErrors'
import { useDismissable } from '../lib/dismissable'
import * as ipc from '../lib/ipc'
import type { Account, AccountIdentity, AccountSupport, AccountTerminalAction, AgentInfo, AgentType } from '../types'

/** Who an account is signed in as in one line: email, organization and plan, or why nobody is. */
function identityLine(identity: AccountIdentity | undefined): string {
  switch (identity?.status) {
    case 'signedIn': {
      const parts = [identity.email, identity.orgName, identity.plan, identity.providers.join(', ')].filter(Boolean)
      return parts.length > 0 ? parts.join(' · ') : 'Signed in'
    }
    case 'signedOut': return 'Signed out'
    case 'apiKey': return 'API key'
    default: return 'Status unknown'
  }
}

/** Why no account can be added for the agent right now, or `null`. */
function addBlockedReason(agent: AgentInfo, support: AccountSupport): string | null {
  if (support.blockedReason) return support.blockedReason
  if (!meetsVersionReq(agent.cliVersion, support.minCliVersion ?? undefined)) {
    const installed = agent.cliVersion ? ` (installed: ${agent.cliVersion})` : ''
    return `Added accounts need ${agent.name} ${support.minCliVersion} or later${installed}.`
  }
  return null
}

const ROW_BUTTON = 'px-2.5 py-1 rounded-md text-xs text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors'
const ADD_BUTTON = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const ROW_CARD = 'rounded-lg bg-surface-1 ring-1 ring-outline/8 px-3 py-2.5 flex items-center justify-between gap-3'

/**
 * Settings -> Accounts: per agent, the Default login and the accounts added
 * next to it. The list is the accounts store, which the backend keeps current
 * with `accounts-changed` after every change and every login or logout, so the
 * commands below only report how they went.
 */
export const AccountsSettings: Component = () => {
  const [editing, setEditing] = createSignal<{ agentType: AgentType; account?: Account } | null>(null)
  const [terminal, setTerminal] = createSignal<{ account: Account; action: AccountTerminalAction } | null>(null)
  const [removing, setRemoving] = createSignal<Account | null>(null)
  const [deleteDir, setDeleteDir] = createSignal(false)

  // Showing the page re-reads every identity, so a login the user did in a
  // terminal of their own shows up.
  onMount(() => { void loadAccounts() })

  // Escape closes the question, not Settings behind it.
  useDismissable(() => removing() !== null, () => setRemoving(null))

  // An agent whose CLI is gone keeps its accounts in the list, so they can be removed.
  const groups = () => agents.filter((a) => a.accountSupport && (a.installed || liveAccountsFor(a.id).length > 0))

  const askToRemove = (account: Account) => {
    setDeleteDir(false)
    setRemoving(account)
  }

  const remove = async () => {
    const account = removing()
    if (!account) return
    const { id, label } = account
    const withDir = account.managedDir && deleteDir()
    setRemoving(null)
    try {
      await ipc.removeAccount(id, withDir)
      addToast(`Removed ${label}`, 'success')
    } catch (e) {
      if (!notifyAccountError(e)) addToast(String(e), 'error')
    }
  }

  /** Removing leaves the CLI's own saved login behind, so a signed-in account is offered a logout first. */
  const canLogOutFirst = () => {
    const account = removing()
    if (!account || account.identity.status !== 'signedIn') return false
    const agent = agents.find((a) => a.id === account.agentType)
    return !!agent?.installed && !!agent.accountSupport?.logout
  }

  const logOutFirst = () => {
    const account = removing()
    if (!account) return
    // The question goes first: its Enter key must not reach the terminal.
    setRemoving(null)
    setTerminal({ account, action: 'logout' })
  }

  return (
    <>
      <p class="text-xs text-text-dim mb-6">Sign in to more than one account per agent. Default is the login your CLI already uses.</p>

      <Show
        when={groups().length > 0}
        fallback={<p class="text-sm text-text-dim">None of your installed agents support added accounts.</p>}
      >
        <For each={groups()}>
          {(agent) => (
            <Show when={agent.accountSupport}>
              {(support) => (
                <HarnessGroup
                  agent={agent}
                  support={support()}
                  onAdd={() => setEditing({ agentType: agent.id })}
                  onEdit={(account) => setEditing({ agentType: agent.id, account })}
                  onTerminal={(account, action) => setTerminal({ account, action })}
                  onRemove={askToRemove}
                />
              )}
            </Show>
          )}
        </For>
      </Show>

      <Show when={editing()} keyed>
        {(target) => <AccountDialog open agentType={target.agentType} account={target.account} onClose={() => setEditing(null)} />}
      </Show>

      <Show when={terminal()} keyed>
        {(target) => <AccountTerminalDialog account={target.account} action={target.action} onClose={() => setTerminal(null)} />}
      </Show>

      <ConfirmDialog
        open={removing() !== null}
        danger
        title={`Remove ${removing()?.label}?`}
        message="Sessions on this account keep their history but can't continue."
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        {/* The dialog confirms on any Enter. Here Enter is for the switch and the button. */}
        <div onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation() }}>
          <Show when={canLogOutFirst()}>
            <div class="flex items-center justify-between gap-3 mb-4">
              <span class="text-sm text-text-muted">Log out first to clear its saved login.</span>
              <button
                type="button"
                class="shrink-0 px-2.5 py-1 rounded-lg text-xs bg-surface-3 hover:bg-surface-4 text-text-secondary hover:text-text-primary transition-colors"
                onClick={logOutFirst}
              >
                Log out first
              </button>
            </div>
          </Show>
          <Show when={removing()?.managedDir}>
            <label class="flex items-center justify-between gap-3 mb-4 text-sm text-text-secondary">
              Also delete its folder
              <Toggle checked={deleteDir()} onChange={setDeleteDir} />
            </label>
          </Show>
        </div>
      </ConfirmDialog>
    </>
  )
}

interface GroupProps {
  agent: AgentInfo
  support: AccountSupport
  onAdd: () => void
  onEdit: (account: Account) => void
  onTerminal: (account: Account, action: AccountTerminalAction) => void
  onRemove: (account: Account) => void
}

/** One agent: its Default login, its accounts, and the way to add another. */
const HarnessGroup: Component<GroupProps> = (props) => {
  const headingId = createUniqueId()
  const blocked = () => addBlockedReason(props.agent, props.support)

  return (
    <section class="mb-8" aria-labelledby={headingId}>
      <div class="flex items-center gap-2 mb-3">
        <SvgIcon svg={agentIcon(props.agent.id)} size={14} class="text-text-muted" />
        <h2 id={headingId} class="section-title">{props.agent.name}</h2>
        <Show when={!props.agent.installed}>
          <span class="text-[11px] text-text-dim">Not installed</span>
        </Show>
      </div>

      <ul class="list-none m-0 p-0 space-y-2">
        {/* Nobody can say who a CLI is signed in as when there is no CLI. */}
        <Show when={props.agent.installed}>
          <li class={ROW_CARD}>
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full ring-1 ring-outline/20 shrink-0" />
              <div class="min-w-0">
                <div class="text-sm text-text-primary">Default</div>
                <div class="text-xs text-text-muted truncate">{identityLine(defaultIdentity(props.agent.id))}</div>
              </div>
            </div>
          </li>
        </Show>
        <For each={liveAccountsFor(props.agent.id)}>
          {(account) => (
            <AccountCard
              account={account}
              canLogIn={props.agent.installed && props.support.login}
              canLogOut={props.agent.installed && props.support.logout}
              onTerminal={(action) => props.onTerminal(account, action)}
              onEdit={() => props.onEdit(account)}
              onRemove={() => props.onRemove(account)}
            />
          )}
        </For>
      </ul>

      <Show when={props.agent.installed}>
        <div class="mt-3 flex items-center gap-3">
          <button type="button" class={`${ADD_BUTTON} shrink-0`} disabled={blocked() !== null} title={blocked() ?? undefined} onClick={props.onAdd}>
            <Plus size={12} />
            Add account
          </button>
          <Show when={blocked()}>
            {(reason) => <span class="text-xs text-text-dim">{reason()}</span>}
          </Show>
        </div>
      </Show>
    </section>
  )
}

interface CardProps {
  account: Account
  canLogIn: boolean
  canLogOut: boolean
  onTerminal: (action: AccountTerminalAction) => void
  onEdit: () => void
  onRemove: () => void
}

const AccountCard: Component<CardProps> = (props) => (
  <li class={ROW_CARD}>
    <div class="flex items-center gap-3 min-w-0">
      <span
        data-testid="account-color"
        class="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ 'background-color': props.account.color }}
      />
      <div class="min-w-0">
        <div class="text-sm text-text-primary truncate">{props.account.label}</div>
        <div class="text-xs text-text-muted truncate">{identityLine(props.account.identity)}</div>
        <div class="text-[11px] text-text-dim font-mono truncate" title={props.account.configDir}>{props.account.configDir}</div>
      </div>
    </div>
    <div class="flex items-center gap-1 shrink-0">
      <Show when={props.canLogIn}>
        <button type="button" class={ROW_BUTTON} aria-label={`Log in to ${props.account.label}`} onClick={() => props.onTerminal('login')}>Log in</button>
      </Show>
      <Show when={props.canLogOut}>
        <button type="button" class={ROW_BUTTON} aria-label={`Log out of ${props.account.label}`} onClick={() => props.onTerminal('logout')}>Log out</button>
      </Show>
      <button type="button" class={ROW_BUTTON} aria-label={`Edit ${props.account.label}`} onClick={props.onEdit}>Edit</button>
      <button
        type="button"
        class="px-2.5 py-1 rounded-md text-xs text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
        aria-label={`Remove ${props.account.label}`}
        onClick={props.onRemove}
      >
        Remove
      </button>
    </div>
  </li>
)
