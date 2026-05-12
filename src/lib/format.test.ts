import { describe, it, expect } from 'vitest'
import { formatCost, formatTokens, formatDurationShort, formatBytes, formatPct } from './format'

describe('formatCost', () => {
  it('uses 4 decimals for sub-cent amounts', () => {
    expect(formatCost(0.0012)).toBe('$0.0012')
    expect(formatCost(0.0001)).toBe('$0.0001')
  })

  it('uses 3 decimals for amounts under $1', () => {
    expect(formatCost(0.25)).toBe('$0.250')
    expect(formatCost(0.999)).toBe('$0.999')
  })

  it('uses 2 decimals for amounts >= $1', () => {
    expect(formatCost(1)).toBe('$1.00')
    expect(formatCost(31.59)).toBe('$31.59')
    expect(formatCost(1234.5)).toBe('$1234.50')
  })
})

describe('formatTokens', () => {
  it('shows raw value under 1000', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(435)).toBe('435')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses k suffix between 1k and 1M', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(172_000)).toBe('172.0k')
    expect(formatTokens(999_900)).toBe('999.9k')
  })

  it('uses M suffix at 1M and above', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(24_657_100)).toBe('24.7M')
    expect(formatTokens(1_390_900)).toBe('1.4M')
    expect(formatTokens(999_000_000)).toBe('999.0M')
  })

  it('uses B suffix at 1B and above', () => {
    expect(formatTokens(1_000_000_000)).toBe('1.0B')
    expect(formatTokens(2_500_000_000)).toBe('2.5B')
  })
})

describe('formatDurationShort', () => {
  it('returns "now" for zero or negative', () => {
    expect(formatDurationShort(0)).toBe('now')
    expect(formatDurationShort(-1000)).toBe('now')
  })

  it('shows minutes under an hour', () => {
    expect(formatDurationShort(60_000)).toBe('1m')
    expect(formatDurationShort(51 * 60_000)).toBe('51m')
  })

  it('shows hours and minutes past an hour', () => {
    expect(formatDurationShort(3_600_000)).toBe('1h')
    expect(formatDurationShort(3_600_000 + 15 * 60_000)).toBe('1h 15m')
  })

  it('shows days past 24h', () => {
    expect(formatDurationShort(24 * 3_600_000)).toBe('1d')
    expect(formatDurationShort(3 * 24 * 3_600_000 + 5 * 3_600_000)).toBe('3d 5h')
  })
})

describe('formatBytes', () => {
  it('shows raw bytes under 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('uses KB at 1 KiB and above', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(10 * 1024)).toBe('10.0 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
  })
  it('uses MB at 1 MiB and above', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
  })
  it('uses GB at 1 GiB and above', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB')
    expect(formatBytes(Math.round(1.234 * 1024 ** 3))).toBe('1.23 GB')
  })
})

describe('formatPct', () => {
  it('uses 1 decimal under 10%', () => {
    expect(formatPct(0)).toBe('0.0%')
    expect(formatPct(1.234)).toBe('1.2%')
    expect(formatPct(9.95)).toBe('10%')
  })
  it('uses 0 decimals at 10% and above', () => {
    expect(formatPct(10)).toBe('10%')
    expect(formatPct(99.6)).toBe('100%')
    expect(formatPct(420)).toBe('420%')
  })
})
