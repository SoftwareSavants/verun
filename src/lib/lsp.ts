import { LSPClient, languageServerExtensions } from '@codemirror/lsp-client'
import type { Transport } from '@codemirror/lsp-client'
import { listen } from '@tauri-apps/api/event'
import * as ipc from './ipc'

interface LspMessagePayload {
  taskId: string
  message: string
}

// One LSP client per task (worktree)
const clients = new Map<string, LSPClient>()

function createTauriTransport(taskId: string): Transport {
  const handlers: Array<(msg: string) => void> = []

  // Listen for messages from the LSP server (via Rust backend)
  listen<LspMessagePayload>('lsp-message', (event) => {
    if (event.payload.taskId === taskId) {
      for (const h of handlers) {
        h(event.payload.message)
      }
    }
  })

  return {
    send(message: string) {
      ipc.lspSend(taskId, message)
    },
    subscribe(handler: (msg: string) => void) {
      handlers.push(handler)
    },
    unsubscribe(handler: (msg: string) => void) {
      const i = handlers.indexOf(handler)
      if (i >= 0) handlers.splice(i, 1)
    },
  }
}

/**
 * Get or create an LSP client for a task's worktree.
 * The client is lazily initialized on first call.
 */
export async function getLspClient(taskId: string, worktreePath: string): Promise<LSPClient> {
  const existing = clients.get(taskId)
  if (existing?.connected) return existing

  // Start the language server process in Rust
  await ipc.lspStart(taskId, worktreePath)

  const client = new LSPClient({
    rootUri: `file://${worktreePath}`,
    extensions: languageServerExtensions(),
  })

  client.connect(createTauriTransport(taskId))
  clients.set(taskId, client)

  // Wait for initialization handshake to complete
  await client.initializing

  return client
}

/**
 * Check if a file extension is supported by our LSP (TypeScript/JavaScript).
 */
export function isLspSupported(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)
}

/**
 * Stop and clean up the LSP client for a task.
 */
export async function stopLspClient(taskId: string) {
  const client = clients.get(taskId)
  if (client) {
    client.disconnect()
    clients.delete(taskId)
  }
  await ipc.lspStop(taskId)
}
