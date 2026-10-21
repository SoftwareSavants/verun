import type { AgentType } from '../types'

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
