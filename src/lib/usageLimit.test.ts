import { describe, expect, test } from 'vitest'
import { isUsageLimit, pendingUsageLimit } from './usageLimit'
import type { OutputItem } from '../types'

const limitRaw = JSON.stringify({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true })
const limit: OutputItem = { kind: 'errorMessage', message: "You've hit your weekly limit · resets Oct 18 at 5pm (UTC)", raw: limitRaw }

describe('usage limit', () => {
  test('a rate_limit API error is a usage limit, other errors are not', () => {
    expect(isUsageLimit(limit.kind === 'errorMessage' ? limit.message : '', limitRaw)).toBe(true)
    expect(isUsageLimit("You've hit your limit · resets 3pm")).toBe(true)
    expect(isUsageLimit('Prompt is too long', JSON.stringify({ error: 'invalid_request' }))).toBe(false)
    expect(isUsageLimit('API Error: 529 overloaded')).toBe(false)
  })

  test('the limit stands until the user sends something again', () => {
    const user: OutputItem = { kind: 'transcriptUserMessage', text: 'go on' } as OutputItem
    expect(pendingUsageLimit([user, limit])).toBe(limit.kind === 'errorMessage' && limit.message)
    expect(pendingUsageLimit([user, limit, { kind: 'system', text: 'x' }])).toBeTruthy()
    expect(pendingUsageLimit([limit, user])).toBeNull()
    expect(pendingUsageLimit([user, { kind: 'errorMessage', message: 'Prompt is too long' }])).toBeNull()
    expect(pendingUsageLimit([])).toBeNull()
  })
})
