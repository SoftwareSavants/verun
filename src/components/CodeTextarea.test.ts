import { describe, expect, test } from 'vitest'
import { findDollarTokenStart, VERUN_ENV_VARS } from './CodeTextarea'

// Pure helper for the CodeTextarea autocompletion source. Given the text
// leading up to the cursor, return the offset where the `$...` env-var token
// starts, or -1 if the cursor is not inside one. Lets us unit-test completion
// eligibility without spinning up a full EditorState + CompletionContext.
describe('findDollarTokenStart', () => {
  test('returns offset when cursor is inside a $token', () => {
    expect(findDollarTokenStart('echo $VE')).toBe(5)
    expect(findDollarTokenStart('$')).toBe(0)
    expect(findDollarTokenStart('pnpm run && $VERUN_')).toBe(12)
  })

  test('returns -1 when cursor is not inside a $token', () => {
    expect(findDollarTokenStart('')).toBe(-1)
    expect(findDollarTokenStart('echo hello')).toBe(-1)
    expect(findDollarTokenStart('echo $VAR ')).toBe(-1)
    expect(findDollarTokenStart('echo $V-')).toBe(-1)
  })
})

describe('VERUN_ENV_VARS', () => {
  test('exposes VERUN_REPO_PATH plus VERUN_PORT_0..9', () => {
    const labels = VERUN_ENV_VARS.map(v => v.label)
    expect(labels).toContain('$VERUN_REPO_PATH')
    for (let i = 0; i < 10; i++) expect(labels).toContain(`$VERUN_PORT_${i}`)
    expect(labels).toHaveLength(11)
  })
})
