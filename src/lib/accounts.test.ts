import { beforeEach, describe, expect, test, vi } from 'vitest'

// The accounts store this reads imports the backend wrappers and the event bus.
// Neither is used here, only the state the tests put in the store.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('./ipc', () => ({ listAccounts: vi.fn() }))

import { accountChoicesFor, accountKey, agentRows, inheritedSelection, PROJECT_DEFAULT, selectedChoice, type AccountChoice } from './accounts'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'
import type { AccountSelection, AgentInfo, AgentType, ProjectAccount } from '../types'

// The same cases as `account_key_default_and_added` in
// src-tauri/src/accounts/mod.rs: the backend files `rate-limit-info` events
// under these strings and the UI looks them up with `accountKey`.
describe('accountKey', () => {
  test('an added account is keyed by its id', () => {
    expect(accountKey('claude', 'a1')).toBe('a1')
  })

  test('the Default account is keyed by its harness', () => {
    expect(accountKey('claude', null)).toBe('default:claude')
    expect(accountKey('codex', null)).toBe('default:codex')
  })
})

const acme = makeAccount()
const beta = makeAccount({ id: 'a2', label: 'Beta', color: '#16a34a' })
const work = makeAccount({ id: 'c1', agentType: 'codex', label: 'Work', color: '#ea580c' })

const binding = (projectId: string, agentType: AgentType, accountId: string): ProjectAccount => ({ projectId, agentType, accountId })

const keys = (choices: AccountChoice[]) => choices.map((c) => c.key)

beforeEach(() => {
  applySnapshot(makeSnapshot())
})

describe('accountChoicesFor', () => {
  test('no accounts gives no choices', () => {
    expect(accountChoicesFor('claude', 'p1')).toEqual([])
    expect(accountChoicesFor('claude', undefined)).toEqual([])
  })

  test('accounts of other harnesses and removed accounts give none either', () => {
    applySnapshot(makeSnapshot({ accounts: [work, makeAccount({ id: 'a9', label: 'Old', removedAt: 5 })] }))

    expect(accountChoicesFor('claude', 'p1')).toEqual([])
    // Codex has one to offer.
    expect(keys(accountChoicesFor('codex', 'p1'))).toEqual(['default:codex', 'c1'])
  })

  test('project binding comes first', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a2')] }))

    expect(keys(accountChoicesFor('claude', 'p1'))).toEqual(['a2', 'default:claude', 'a1'])
  })

  test('unbound project lists Default first', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta] }))

    expect(keys(accountChoicesFor('claude', 'p1'))).toEqual(['default:claude', 'a1', 'a2'])
  })

  test('so does no project at all', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a2')] }))

    expect(keys(accountChoicesFor('claude', undefined))).toEqual(['default:claude', 'a1', 'a2'])
    expect(keys(accountChoicesFor('claude', null))).toEqual(['default:claude', 'a1', 'a2'])
  })

  test('a choice is what a picker shows and what it sends when picked', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))

    expect(accountChoicesFor('claude', 'p1')).toEqual([
      { key: 'default:claude', agentType: 'claude', selection: { kind: 'default' }, label: 'Default', color: null, isProjectDefault: true },
      { key: 'a1', agentType: 'claude', selection: { kind: 'account', id: 'a1' }, label: 'Acme', color: '#7c3aed', isProjectDefault: false },
    ])
  })

  test('the choice the project uses is marked, Default when it has no binding', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a2')] }))

    expect(accountChoicesFor('claude', 'p1').filter((c) => c.isProjectDefault).map((c) => c.key)).toEqual(['a2'])
    expect(accountChoicesFor('claude', 'p2').filter((c) => c.isProjectDefault).map((c) => c.key)).toEqual(['default:claude'])
  })

  test('other projects and other harnesses bindings do not count', () => {
    applySnapshot(makeSnapshot({
      accounts: [acme, work],
      projectAccounts: [binding('p2', 'claude', 'a1'), binding('p1', 'codex', 'c1')],
    }))

    expect(keys(accountChoicesFor('claude', 'p1'))).toEqual(['default:claude', 'a1'])
    expect(keys(accountChoicesFor('codex', 'p1'))).toEqual(['c1', 'default:codex'])
  })

  test('a binding to an account that cannot be used marks no choice', () => {
    applySnapshot(makeSnapshot({
      accounts: [acme, makeAccount({ id: 'a2', label: 'Old', removedAt: 5 })],
      projectAccounts: [binding('p1', 'claude', 'a2')],
    }))

    const choices = accountChoicesFor('claude', 'p1')
    expect(keys(choices)).toEqual(['default:claude', 'a1'])
    expect(choices.some((c) => c.isProjectDefault)).toBe(false)
  })

  test('follows the store', () => {
    expect(accountChoicesFor('claude', 'p1')).toEqual([])

    applySnapshot(makeSnapshot({ accounts: [acme] }))

    expect(keys(accountChoicesFor('claude', 'p1'))).toEqual(['default:claude', 'a1'])
  })
})

describe('inheritedSelection', () => {
  test('inheritedSelection is explicit', () => {
    expect(inheritedSelection(null)).toEqual({ kind: 'default' })
    expect(inheritedSelection('a1')).toEqual({ kind: 'account', id: 'a1' })
  })
})

describe('selectedChoice', () => {
  beforeEach(() => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a2')] }))
  })

  const pick = (selection: AccountSelection) => selectedChoice(accountChoicesFor('claude', 'p1'), selection)?.key

  test('the project default is the choice the project uses', () => {
    expect(pick(PROJECT_DEFAULT)).toBe('a2')
  })

  test('Default is Default whatever the project uses', () => {
    expect(pick({ kind: 'default' })).toBe('default:claude')
  })

  test('an account is that account', () => {
    expect(pick({ kind: 'account', id: 'a1' })).toBe('a1')
  })

  test('an account that is not offered is none', () => {
    expect(pick({ kind: 'account', id: 'gone' })).toBeUndefined()
  })

  test('no choices, no choice', () => {
    expect(selectedChoice([], PROJECT_DEFAULT)).toBeUndefined()
  })
})

const agent = (id: AgentType, name: string, overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name,
  installHint: '',
  updateHint: '',
  docsUrl: '',
  models: [],
  installed: true,
  supportsStreaming: true,
  supportsResume: true,
  supportsPlanMode: false,
  supportsModelSelection: true,
  supportsEffort: false,
  supportsSkills: false,
  supportsAttachments: false,
  supportsFork: false,
  accountSupport: null,
  ...overrides,
})

const claude = agent('claude', 'Claude Code')
const codex = agent('codex', 'Codex')

const rowsOf = (list: AgentInfo[], projectId: string | undefined = 'p1') =>
  agentRows(list, projectId).map((r) => ({ key: r.key, name: r.name, detail: r.detail }))

describe('agentRows', () => {
  test('an agent without accounts is one row, named and keyed by itself', () => {
    expect(rowsOf([claude, codex])).toEqual([
      { key: 'claude', name: 'Claude Code', detail: null },
      { key: 'codex', name: 'Codex', detail: null },
    ])
    expect(agentRows([claude], 'p1')[0].choice).toBeNull()
  })

  test('an agent with accounts is a row for each choice, named after its account', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta, work] }))

    expect(rowsOf([claude, codex])).toEqual([
      { key: 'default:claude', name: 'Claude Code · Default', detail: null },
      { key: 'a1', name: 'Claude Code · Acme', detail: null },
      { key: 'a2', name: 'Claude Code · Beta', detail: null },
      { key: 'default:codex', name: 'Codex · Default', detail: null },
      { key: 'c1', name: 'Codex · Work', detail: null },
    ])
  })

  test('each row has the choice it stands for', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))

    expect(agentRows([claude], 'p1').map((r) => r.choice?.selection)).toEqual([{ kind: 'default' }, { kind: 'account', id: 'a1' }])
  })

  test('the project account comes first in its harness, the harnesses stay in order', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta, work], projectAccounts: [binding('p1', 'claude', 'a2')] }))

    expect(rowsOf([codex, claude]).map((r) => r.key)).toEqual(['default:codex', 'c1', 'a2', 'default:claude', 'a1'])
  })

  test('the Default row says who the harness is signed in as, when known', () => {
    applySnapshot(makeSnapshot({
      accounts: [acme, work],
      defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev' }) }],
    }))

    expect(rowsOf([claude, codex])).toEqual([
      { key: 'default:claude', name: 'Claude Code · Default', detail: 'me@home.dev' },
      { key: 'a1', name: 'Claude Code · Acme', detail: null },
      { key: 'default:codex', name: 'Codex · Default', detail: null },
      { key: 'c1', name: 'Codex · Work', detail: null },
    ])
  })

  test('an agent that is not installed stays one row', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))

    expect(rowsOf([agent('claude', 'Claude Code', { installed: false })])).toEqual([{ key: 'claude', name: 'Claude Code', detail: null }])
  })
})
