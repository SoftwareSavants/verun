import type { McpServerStatus } from '../types'

export function mcpServersNeedingAttention(servers: McpServerStatus[] | undefined): McpServerStatus[] {
  return (servers ?? []).filter(s => mcpServerAction(s.status) !== null)
}

export function mcpServerAction(status: string): 'authenticate' | 'reconnect' | null {
  if (status === 'needs-auth') return 'authenticate'
  if (status === 'failed') return 'reconnect'
  return null
}
