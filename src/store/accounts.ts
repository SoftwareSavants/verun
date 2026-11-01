import { createStore, reconcile } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Account, AccountIdentity, AccountsSnapshot, AgentType } from '../types'
import { listAccounts } from '../lib/ipc'

export const [accountsState, setAccountsState] = createStore<AccountsSnapshot>({
  accounts: [],
  defaults: [],
  projectAccounts: [],
})

/**
 * Replaces everything in the store with `s`. Rows that did not change keep their
 * identity, so what reads them does not rerun.
 *
 * Snapshots come from two places only: the `accounts-changed` event and an
 * explicit `loadAccounts()`. The snapshot an account command resolves with is
 * not applied. It reaches this window as the event too, and the two travel
 * separately, so applying both could put an older state over a newer one.
 */
export function applySnapshot(s: AccountsSnapshot): void {
  setAccountsState(reconcile(s))
}

/**
 * Reads the accounts and who is signed in to each. A failed read keeps what the
 * store has: accounts are optional, and the windows load them next to stores the
 * app cannot start without.
 */
export async function loadAccounts(): Promise<void> {
  try {
    applySnapshot(await listAccounts())
  } catch (e) {
    console.error('Failed to load accounts:', e)
  }
}

/** Keeps the store current: Rust sends every window a snapshot after each change. */
export async function initAccountListeners(): Promise<void> {
  await listen<AccountsSnapshot>('accounts-changed', (event) => {
    applySnapshot(event.payload)
  })
}

/** An added account, removed or not: a session on a removed one still shows whose it was. */
export function accountById(id: string | null | undefined): Account | undefined {
  return id ? accountsState.accounts.find(a => a.id === id) : undefined
}

/** The added accounts of a harness that can still be used. */
export function liveAccountsFor(agentType: AgentType): Account[] {
  return accountsState.accounts.filter(a => a.agentType === agentType && a.removedAt === null)
}

/** The account a project uses for a harness, or `null` for Default. */
export function projectAccountId(projectId: string, agentType: AgentType): string | null {
  const binding = accountsState.projectAccounts.find(p => p.projectId === projectId && p.agentType === agentType)
  return binding?.accountId ?? null
}

/** Who a harness is signed in as on the Default account (the user's own CLI login). */
export function defaultIdentity(agentType: AgentType): AccountIdentity | undefined {
  return accountsState.defaults.find(d => d.agentType === agentType)?.identity
}
