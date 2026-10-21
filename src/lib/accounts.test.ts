import { describe, expect, test } from 'vitest'
import { accountKey } from './accounts'

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
