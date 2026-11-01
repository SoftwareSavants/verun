import type { Account, AccountIdentity, AccountsSnapshot } from '../types'

// Accounts as the tests of the pickers need them: the same shapes the backend
// sends in an accounts snapshot.

/** Who is signed in to an account: nobody, unless a test says otherwise. */
export const makeIdentity = (overrides: Partial<AccountIdentity> = {}): AccountIdentity => ({
  status: 'signedOut',
  email: null,
  orgName: null,
  plan: null,
  providers: [],
  ...overrides,
})

/** A live Claude account "Acme", signed in as dev@acme.com. */
export const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 'a1',
  agentType: 'claude',
  label: 'Acme',
  color: '#7c3aed',
  configDir: '/data/accounts/a1',
  managedDir: true,
  env: [],
  removedAt: null,
  createdAt: 1000,
  identity: makeIdentity({ status: 'signedIn', email: 'dev@acme.com' }),
  ...overrides,
})

export const makeSnapshot = (overrides: Partial<AccountsSnapshot> = {}): AccountsSnapshot => ({
  accounts: [],
  defaults: [],
  projectAccounts: [],
  ...overrides,
})
