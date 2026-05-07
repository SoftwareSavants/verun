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
