import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createEffect, createRoot } from 'solid-js'

// Capture every `listen(eventName, cb)` registration so tests can fire events
// directly. The factory is hoisted above the imports, so it stays self-contained.
const listenCallbacks = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    listenCallbacks.set(event, cb)
    return Promise.resolve(() => listenCallbacks.delete(event))
  }),
}))

vi.mock('../lib/ipc', () => ({
  listAccounts: vi.fn(),
}))

import { accountsState, applySnapshot, loadAccounts, initAccountListeners, accountById, liveAccountsFor, projectAccountId, defaultIdentity } from './accounts'
import * as ipc from '../lib/ipc'
import type { Account, AccountIdentity, AccountsSnapshot } from '../types'

const makeIdentity = (overrides: Partial<AccountIdentity> = {}): AccountIdentity => ({
  status: 'signedIn',
  email: 'dev@acme.com',
  orgName: null,
  plan: null,
  providers: [],
  ...overrides,
})

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 'a1',
  agentType: 'claude',
  label: 'Acme',
  color: '#7c3aed',
  configDir: '/acc/a1',
  managedDir: true,
  env: [],
  removedAt: null,
  createdAt: 1000,
  identity: makeIdentity(),
  ...overrides,
})

const makeSnapshot = (overrides: Partial<AccountsSnapshot> = {}): AccountsSnapshot => ({
  accounts: [],
  defaults: [],
  projectAccounts: [],
  ...overrides,
})

beforeEach(() => {
  applySnapshot(makeSnapshot())
  vi.mocked(ipc.listAccounts).mockReset()
})

describe('accounts store', () => {
  test('starts empty', () => {
    expect(accountsState.accounts).toEqual([])
    expect(accountsState.defaults).toEqual([])
    expect(accountsState.projectAccounts).toEqual([])
  })

  test('loadAccounts stores the snapshot', async () => {
    const snapshot = makeSnapshot({
      accounts: [makeAccount()],
      defaults: [{ agentType: 'claude', identity: makeIdentity({ email: 'me@home.dev' }) }],
      projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a1' }],
    })
    vi.mocked(ipc.listAccounts).mockResolvedValue(snapshot)

    await loadAccounts()

    expect(accountsState).toEqual(snapshot)
  })

  test('a failed read leaves the accounts as they were and does not fail the caller', async () => {
    // Startup awaits loadAccounts next to the stores the app cannot do without.
    // Accounts are optional, so a failed read must not hold the splash screen.
    applySnapshot(makeSnapshot({ accounts: [makeAccount()] }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(ipc.listAccounts).mockRejectedValue('Couldn\'t find your home folder.')

    await expect(loadAccounts()).resolves.toBeUndefined()

    expect(accountsState.accounts.map(a => a.id)).toEqual(['a1'])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  describe('accounts-changed', () => {
    beforeAll(async () => {
      await initAccountListeners()
    })

    test('accounts-changed replaces the snapshot', () => {
      applySnapshot(makeSnapshot({
        accounts: [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2', label: 'Beta' })],
        defaults: [{ agentType: 'claude', identity: makeIdentity() }, { agentType: 'codex', identity: makeIdentity() }],
        projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a1' }],
      }))

      const fresh = makeSnapshot({
        accounts: [makeAccount({ id: 'a2', label: 'Beta renamed' })],
        defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedOut', email: null }) }],
      })
      const fire = listenCallbacks.get('accounts-changed')
      expect(fire).toBeDefined()
      fire!({ payload: fresh })

      // Nothing of the old snapshot is left behind.
      expect(accountsState).toEqual(fresh)
    })
  })

  describe('applySnapshot', () => {
    test('keeps the rows that did not change, so what reads them does not rerun', () => {
      applySnapshot(makeSnapshot({
        accounts: [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2', label: 'Beta' })],
      }))
      const unchanged = accountsState.accounts[0]
      const seen: string[] = []
      const dispose = createRoot(dispose => {
        createEffect(() => { seen.push(accountsState.accounts[0].label) })
        return dispose
      })

      // a2 changes (a rename); a1 comes back exactly as it was.
      applySnapshot(makeSnapshot({
        accounts: [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2', label: 'Beta renamed' })],
      }))
      dispose()

      expect(accountsState.accounts[0]).toBe(unchanged)
      expect(accountsState.accounts[1].label).toBe('Beta renamed')
      expect(seen).toEqual(['Acme'])
    })

    test('a row that changed shows its new values', () => {
      applySnapshot(makeSnapshot({ accounts: [makeAccount({ identity: makeIdentity({ status: 'signedOut', email: null }) })] }))
      applySnapshot(makeSnapshot({ accounts: [makeAccount({ identity: makeIdentity({ email: 'dev@acme.com', plan: 'max' }) })] }))

      expect(accountsState.accounts[0].identity).toEqual(makeIdentity({ email: 'dev@acme.com', plan: 'max' }))
    })

    test('a row that is gone is gone, and the others keep their order', () => {
      applySnapshot(makeSnapshot({
        accounts: [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2' }), makeAccount({ id: 'a3' })],
      }))
      applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'a3' }), makeAccount({ id: 'a1' })] }))

      expect(accountsState.accounts.map(a => a.id)).toEqual(['a3', 'a1'])
    })

    test('rows without an id (defaults, bindings) are replaced in place', () => {
      applySnapshot(makeSnapshot({
        defaults: [{ agentType: 'claude', identity: makeIdentity() }, { agentType: 'codex', identity: makeIdentity() }],
        projectAccounts: [
          { projectId: 'p1', agentType: 'claude', accountId: 'a1' },
          { projectId: 'p2', agentType: 'claude', accountId: 'a2' },
        ],
      }))
      applySnapshot(makeSnapshot({
        defaults: [{ agentType: 'codex', identity: makeIdentity({ email: 'codex@acme.com' }) }],
        projectAccounts: [{ projectId: 'p2', agentType: 'claude', accountId: 'a2' }],
      }))

      expect(accountsState.defaults).toEqual([{ agentType: 'codex', identity: makeIdentity({ email: 'codex@acme.com' }) }])
      expect(accountsState.projectAccounts).toEqual([{ projectId: 'p2', agentType: 'claude', accountId: 'a2' }])
    })
  })

  describe('selectors', () => {
    test('liveAccountsFor hides removed accounts', () => {
      applySnapshot(makeSnapshot({
        accounts: [
          makeAccount({ id: 'a1' }),
          makeAccount({ id: 'a2', removedAt: 1700 }),
          makeAccount({ id: 'a3', agentType: 'codex' }),
          makeAccount({ id: 'a4' }),
        ],
      }))

      expect(liveAccountsFor('claude').map(a => a.id)).toEqual(['a1', 'a4'])
      expect(liveAccountsFor('codex').map(a => a.id)).toEqual(['a3'])
      expect(liveAccountsFor('gemini')).toEqual([])
    })

    test('accountById finds an account, removed or not', () => {
      applySnapshot(makeSnapshot({
        accounts: [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2', removedAt: 1700 })],
      }))

      expect(accountById('a1')?.label).toBe('Acme')
      // A session on a removed account still shows whose it was.
      expect(accountById('a2')?.removedAt).toBe(1700)
      expect(accountById('nope')).toBeUndefined()
      expect(accountById(null)).toBeUndefined()
      expect(accountById(undefined)).toBeUndefined()
    })

    test('projectAccountId reads the binding', () => {
      applySnapshot(makeSnapshot({
        projectAccounts: [
          { projectId: 'p1', agentType: 'claude', accountId: 'a1' },
          { projectId: 'p1', agentType: 'codex', accountId: 'a3' },
          { projectId: 'p2', agentType: 'claude', accountId: 'a2' },
        ],
      }))

      expect(projectAccountId('p1', 'claude')).toBe('a1')
      expect(projectAccountId('p1', 'codex')).toBe('a3')
      expect(projectAccountId('p2', 'claude')).toBe('a2')
      // No binding means Default.
      expect(projectAccountId('p2', 'codex')).toBeNull()
      expect(projectAccountId('p3', 'claude')).toBeNull()
    })

    test('defaultIdentity reads who the harness is signed in as', () => {
      applySnapshot(makeSnapshot({
        defaults: [
          { agentType: 'claude', identity: makeIdentity({ email: 'me@home.dev' }) },
          { agentType: 'codex', identity: makeIdentity({ status: 'signedOut', email: null }) },
        ],
      }))

      expect(defaultIdentity('claude')?.email).toBe('me@home.dev')
      expect(defaultIdentity('codex')?.status).toBe('signedOut')
      expect(defaultIdentity('gemini')).toBeUndefined()
    })

    test('selectors follow the store', () => {
      const seen: string[][] = []
      const dispose = createRoot(dispose => {
        createEffect(() => { seen.push(liveAccountsFor('claude').map(a => a.id)) })
        return dispose
      })

      applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'a1' })] }))
      applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'a1', removedAt: 1700 })] }))
      dispose()

      expect(seen).toEqual([[], ['a1'], []])
    })
  })
})
