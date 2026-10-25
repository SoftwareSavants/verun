import { createStore, produce } from 'solid-js/store'
import type { McpServerStatus } from '../types'
import * as ipc from '../lib/ipc'

// sessionId → last known MCP server list (from `system/init` or `mcp_status`).
export const [mcpServers, setMcpServers] = createStore<Record<string, McpServerStatus[]>>({})
// `${sessionId}\0${serverName}` → an authenticate/reconnect is in flight.
const [pending, setPending] = createStore<Record<string, boolean>>({})

const key = (sessionId: string, name: string) => `${sessionId}\0${name}`

export function setSessionMcpServers(sessionId: string, servers: McpServerStatus[]) {
  setMcpServers(sessionId, servers)
}

export function mcpActionPending(sessionId: string, name: string): boolean {
  return !!pending[key(sessionId, name)]
}

/** Re-read live status. A stopped session keeps its last known list. */
export async function refreshMcpStatus(sessionId: string) {
  try {
    setSessionMcpServers(sessionId, await ipc.getMcpStatus(sessionId))
  } catch {
    // Not running: nothing live to ask.
  }
}

async function runAction(sessionId: string, name: string, action: () => Promise<void>): Promise<string | null> {
  setPending(produce(s => { s[key(sessionId, name)] = true }))
  try {
    await action()
    await refreshMcpStatus(sessionId)
    return null
  } catch (e) {
    return String(e)
  } finally {
    setPending(produce(s => { delete s[key(sessionId, name)] }))
  }
}

/** Opens the server's sign-in page; returns an error message on failure. */
export function authenticateMcpServer(sessionId: string, name: string) {
  return runAction(sessionId, name, () => ipc.authenticateMcpServer(sessionId, name))
}

export function reconnectMcpServer(sessionId: string, name: string) {
  return runAction(sessionId, name, () => ipc.reconnectMcpServer(sessionId, name))
}
