export type PluginType = 'mcp' | 'lsp'

const TYPE_LABELS: Record<PluginType, string> = {
  mcp: 'MCP',
  lsp: 'LSP',
}

// Conservative: only flag types we can identify with very high precision from
// the description text. Other types (skill / agent / commands / hooks) leak
// false positives because plugins frequently mention them in passing without
// being one. Better to show no chip than the wrong chip.
export function detectPluginType(description: string): PluginType | null {
  const text = description.toLowerCase()
  if (/\bmcp\s+server|model context protocol/.test(text)) return 'mcp'
  if (/\blanguage\s+server\b|\blsp\s+(server|integration)/.test(text)) return 'lsp'
  return null
}

export function pluginTypeLabel(type: PluginType): string {
  return TYPE_LABELS[type]
}

export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}M`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}K`
  }
  return String(n)
}
