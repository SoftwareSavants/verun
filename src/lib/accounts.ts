import type { AccountSelection, AgentInfo, AgentType } from '../types'
import { defaultIdentity, liveAccountsFor, projectAccountId } from '../store/accounts'

/**
 * The key per-account UI state (rate limits so far) is filed under: an added
 * account's id, or `default:<agentType>` for the Default account, which each
 * harness has its own of. The backend tags `rate-limit-info` events with
 * `account_key` in src-tauri/src/accounts/mod.rs, so the two must build
 * identical strings.
 */
export function accountKey(agentType: AgentType, accountId: string | null): string {
  return accountId ?? `default:${agentType}`
}

/** No account picked: the session runs on the project's account for its harness. */
export const PROJECT_DEFAULT: AccountSelection = { kind: 'projectDefault' }

/** One account a new session can run on, as a picker lists it. */
export interface AccountChoice {
  /** `accountKey` of the account: what the picker files its row under. */
  key: string
  agentType: AgentType
  /** What starting the session with this choice sends. */
  selection: AccountSelection
  /** `Default`, or the account's label. */
  label: string
  /** The account's color. Default has none. */
  color: string | null
  /** Whether a session started without a pick would run on it. */
  isProjectDefault: boolean
}

/**
 * The accounts a new session of `agentType` can run on in a project: Default and
 * each account of the harness that can still be used, the project's own first
 * (Default first when it has none). Empty while the harness has no account, so
 * its pickers stay as they are for someone who never added one.
 */
export function accountChoicesFor(agentType: AgentType, projectId: string | null | undefined): AccountChoice[] {
  const accounts = liveAccountsFor(agentType)
  if (accounts.length === 0) return []
  const bound = projectId ? projectAccountId(projectId, agentType) : null
  const choices: AccountChoice[] = [
    {
      key: accountKey(agentType, null),
      agentType,
      selection: { kind: 'default' },
      label: 'Default',
      color: null,
      isProjectDefault: bound === null,
    },
    ...accounts.map((a): AccountChoice => ({
      key: accountKey(agentType, a.id),
      agentType,
      selection: { kind: 'account', id: a.id },
      label: a.label,
      color: a.color,
      isProjectDefault: a.id === bound,
    })),
  ]
  return [...choices.filter((c) => c.isProjectDefault), ...choices.filter((c) => !c.isProjectDefault)]
}

/**
 * The choice `selection` stands for, if the harness still offers it: the
 * project's for `projectDefault`, Default for `default`, else the account itself.
 */
export function selectedChoice(choices: AccountChoice[], selection: AccountSelection): AccountChoice | undefined {
  switch (selection.kind) {
    case 'projectDefault':
      return choices.find((c) => c.isProjectDefault)
    case 'default':
      return choices.find((c) => c.selection.kind === 'default')
    case 'account':
      return choices.find((c) => c.selection.kind === 'account' && c.selection.id === selection.id)
  }
}

/**
 * The account a session started from another one runs on: the one that session
 * runs on, explicitly. A later change of the project's account moves neither.
 */
export function inheritedSelection(accountId: string | null): AccountSelection {
  return accountId === null ? { kind: 'default' } : { kind: 'account', id: accountId }
}

/** One row of a picker's list of agents: an agent, on one of its accounts if it has any. */
export interface AgentRow {
  /** Names the row in its picker: the account's key, or the agent's id when it has no account. */
  key: string
  agent: AgentInfo
  choice: AccountChoice | null
  /** `Claude Code · Acme`: the agent, then its account if it has any. */
  name: string
  /** Who the Default login is, when the row is that and it is known. */
  detail: string | null
}

/**
 * The rows of `agents` for a picker: one for an agent without added accounts
 * (or not installed, so nothing starts on it), else one for each account
 * choice. Each row has its own models, and starts a session on its account.
 */
export function agentRows(agents: readonly AgentInfo[], projectId: string | null | undefined): AgentRow[] {
  return agents.flatMap((agent): AgentRow[] => {
    const choices = agent.installed ? accountChoicesFor(agent.id, projectId) : []
    if (choices.length === 0) return [{ key: agent.id, agent, choice: null, name: agent.name, detail: null }]
    return choices.map((choice) => ({
      key: choice.key,
      agent,
      choice,
      name: `${agent.name} · ${choice.label}`,
      detail: choice.selection.kind === 'default' ? (defaultIdentity(agent.id)?.email ?? null) : null,
    }))
  })
}
