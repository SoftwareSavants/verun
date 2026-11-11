import type { McpServerStatus } from '../types'

export function mcpServersNeedingAttention(servers: McpServerStatus[] | undefined): McpServerStatus[] {
  return (servers ?? []).filter(s => mcpServerAction(s.status) !== null)
}

export function mcpServerAction(status: string): 'authenticate' | 'reconnect' | null {
  if (status === 'needs-auth') return 'authenticate'
  if (status === 'failed') return 'reconnect'
  return null
}

export interface McpProblemGroups {
  failed: McpServerStatus[]
  signIn: McpServerStatus[]
  /** Problem servers the user chose not to see. */
  hidden: number
}

export function mcpProblemGroups(servers: McpServerStatus[] | undefined, hidden: ReadonlySet<string>): McpProblemGroups {
  const problems = mcpServersNeedingAttention(servers)
  const shown = problems.filter(s => !hidden.has(s.name))
  return {
    failed: shown.filter(s => s.status === 'failed'),
    signIn: shown.filter(s => s.status === 'needs-auth'),
    hidden: problems.length - shown.length,
  }
}

/** Connectors from a claude.ai account arrive as "claude.ai <Name>". */
export function mcpDisplayName(name: string): { name: string; source: string | undefined } {
  const m = /^claude\.ai (.+)$/.exec(name)
  return m ? { name: m[1], source: 'claude.ai' } : { name, source: undefined }
}
