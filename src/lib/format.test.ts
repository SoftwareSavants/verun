import { describe, it, test, expect } from 'vitest'
import { formatCost, formatTokens, formatDurationShort, formatBytes, formatPct, formatClock, formatAgo, formatDownloadSize } from './format'

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

describe('formatClock', () => {
  const now = new Date(2026, 10, 10, 18, 0).getTime()
  test('today shows the time only', () => {
    expect(formatClock(new Date(2026, 10, 10, 14, 2).getTime(), now)).toBe('14:02')
  })
  test('yesterday says so', () => {
    expect(formatClock(new Date(2026, 10, 9, 9, 5).getTime(), now)).toBe('yesterday 09:05')
  })
  test('older shows the date', () => {
    expect(formatClock(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe('Nov 3, 09:05')
  })
})

describe('formatAgo', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime()
  it('reads as a compact age', () => {
    expect(formatAgo(now - 20_000, now)).toBe('now')
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3h')
    expect(formatAgo(now - 2 * 86400_000, now)).toBe('2d')
    expect(formatAgo(now - 20 * 86400_000, now)).toBe('Oct 22')
  })
})

describe('formatDownloadSize', () => {
  test('decimal megabytes, rounded', () => {
    expect(formatDownloadSize(574041195)).toBe('574 MB')
    expect(formatDownloadSize(1_500_000)).toBe('2 MB')
    expect(formatDownloadSize(0)).toBe('0 MB')
  })

  test('gigabytes from what would round to 1000 MB, one decimal', () => {
    expect(formatDownloadSize(999_400_000)).toBe('999 MB')
    expect(formatDownloadSize(999_600_000)).toBe('1.0 GB')
    expect(formatDownloadSize(1_624_555_275)).toBe('1.6 GB')
  })
})
