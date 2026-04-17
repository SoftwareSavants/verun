import { describe, expect, test } from 'vitest'
import { compareVersions, meetsVersionReq } from './agents'

describe('agent version helpers', () => {
  test('compares plain semantic versions', () => {
    expect(compareVersions('2.1.112', '2.1.111')).toBeGreaterThan(0)
    expect(compareVersions('2.1.111', '2.1.111')).toBe(0)
    expect(compareVersions('2.1.110', '2.1.111')).toBeLessThan(0)
  })

  test('extracts semantic versions from cli output text', () => {
    expect(compareVersions('v2.1.112', '2.1.111')).toBeGreaterThan(0)
    expect(compareVersions('claude 2.1.112', '2.1.111')).toBeGreaterThan(0)
    expect(compareVersions('Claude Code v2.1.112 (abc123)', '2.1.111')).toBeGreaterThan(0)
  })

  test('treats unparseable versions as not meeting requirements', () => {
    expect(Number.isNaN(compareVersions('Claude Code', '2.1.111'))).toBe(true)
    expect(meetsVersionReq('Claude Code', '2.1.111')).toBe(false)
  })
})
