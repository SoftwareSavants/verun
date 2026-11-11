export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function formatDurationShort(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const totalHr = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (totalHr < 24) return mins > 0 ? `${totalHr}h ${mins}m` : `${totalHr}h`
  const days = Math.floor(totalHr / 24)
  const hrs = totalHr % 24
  return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatPct(p: number): string {
  if (p < 10) {
    const oneDp = Math.round(p * 10) / 10
    if (oneDp >= 10) return `${Math.round(oneDp)}%`
    return `${oneDp.toFixed(1)}%`
  }
  return `${Math.round(p)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:02" today, "yesterday 09:05", else "Nov 3, 09:05". */
export function formatClock(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000)
  if (days === 0) return hm
  if (days === 1) return `yesterday ${hm}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`
}

/** Compact age for lists: "now", "5m", "3h", "2d", then the date. */
export function formatAgo(ts: number, now = Date.now()): string {
  const m = Math.floor((now - ts) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const date = new Date(ts)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}
