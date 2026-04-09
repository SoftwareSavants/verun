import { LSPClient, LSPPlugin, Workspace, languageServerExtensions } from '@codemirror/lsp-client'
import type { Transport, WorkspaceFile } from '@codemirror/lsp-client'
import { EditorView } from '@codemirror/view'
import { Text } from '@codemirror/state'
import { listen } from '@tauri-apps/api/event'
import * as ipc from './ipc'
import { openFile, setRightPanelTab } from '../store/files'
import type { FileTreeChangedEvent } from '../types'

interface LspMessagePayload {
  taskId: string
  message: string
}

// One LSP client per task (worktree)
const clients = new Map<string, LSPClient>()
// Track worktree paths for restart
const worktreePaths = new Map<string, string>()
// Debounce timers for node_modules restart
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── EditorView registry for cross-file go-to-definition ───────────────
// CodeEditor registers its view here when mounted; displayFile reads it
const editorViews = new Map<string, EditorView>()
// Resolvers waiting for a file to be opened
const pendingDisplayFile = new Map<string, (view: EditorView) => void>()

/** Called by CodeEditor when it mounts/creates a view for a file URI */
export function registerEditorView(fileUri: string, view: EditorView) {
  editorViews.set(fileUri, view)
  // Resolve any pending displayFile promise
  const resolver = pendingDisplayFile.get(fileUri)
  if (resolver) {
    pendingDisplayFile.delete(fileUri)
    resolver(view)
  }
}

/** Called by CodeEditor when it unmounts/destroys a view */
export function unregisterEditorView(fileUri: string) {
  editorViews.delete(fileUri)
}

// ── Custom Workspace with cross-file support ──────────────────────────

class VerunWorkspaceFile implements WorkspaceFile {
  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    private view_: EditorView,
  ) {}
  getView() { return this.view_ }
}

class VerunWorkspace extends Workspace {
  files: WorkspaceFile[] = []
  private fileVersions: Record<string, number> = {}
  private worktreePath: string

  constructor(client: LSPClient, worktreePath: string) {
    super(client)
    this.worktreePath = worktreePath
  }

  private nextVersion(uri: string) {
    return this.fileVersions[uri] = (this.fileVersions[uri] ?? -1) + 1
  }

  syncFiles() {
    const result: Array<{ changes: any; file: WorkspaceFile; prevDoc: Text }> = []
    for (const file of this.files) {
      const view = file.getView()
      if (!view) continue
      const plugin = LSPPlugin.get(view)
      if (!plugin) continue
      const changes = plugin.unsyncedChanges
      if (!changes.empty) {
        result.push({ changes, file, prevDoc: file.doc })
        file.doc = view.state.doc
        file.version = this.nextVersion(file.uri)
        plugin.clear()
      }
    }
    return result
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    // If already open, just update the view reference
    const existing = this.getFile(uri)
    if (existing) return
    const file = new VerunWorkspaceFile(uri, languageId, this.nextVersion(uri), view.state.doc, view)
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile(uri: string) {
    const file = this.getFile(uri)
    if (file) {
      this.files = this.files.filter(f => f !== file)
      this.client.didClose(uri)
    }
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    // Check if already open in an editor
    const existing = editorViews.get(uri)
    if (existing) return existing

    // Convert file:///path/to/worktree/src/foo.ts → src/foo.ts
    const prefix = `file://${this.worktreePath}/`
    if (!uri.startsWith(prefix)) return null
    const relativePath = decodeURIComponent(uri.slice(prefix.length))
    const name = relativePath.split('/').pop() || relativePath

    // Open the file in the editor
    openFile(relativePath, name)
    setRightPanelTab('files')

    // Wait for the CodeEditor to mount and register the view (max 3s)
    return new Promise<EditorView | null>((resolve) => {
      const immediate = editorViews.get(uri)
      if (immediate) { resolve(immediate); return }

      const timeout = setTimeout(() => {
        pendingDisplayFile.delete(uri)
        resolve(null)
      }, 3000)

      pendingDisplayFile.set(uri, (view) => {
        clearTimeout(timeout)
        resolve(view)
      })
    })
  }
}

// ── Transport ─────────────────────────────────────────────────────────
function createTauriTransport(taskId: string): Transport {
  const handlers: Array<(msg: string) => void> = []

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
 */
export async function getLspClient(taskId: string, worktreePath: string): Promise<LSPClient> {
  const existing = clients.get(taskId)
  if (existing?.connected) return existing

  // Start the language server process in Rust
  await ipc.lspStart(taskId, worktreePath)
  worktreePaths.set(taskId, worktreePath)

  const client = new LSPClient({
    rootUri: `file://${worktreePath}`,
    workspace: (c) => new VerunWorkspace(c, worktreePath),
    extensions: languageServerExtensions(),
  })

  client.connect(createTauriTransport(taskId))
  clients.set(taskId, client)

  await client.initializing

  return client
}

/**
 * Check if a file extension is supported by our LSP.
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
  worktreePaths.delete(taskId)
  const timer = restartTimers.get(taskId)
  if (timer) clearTimeout(timer)
  restartTimers.delete(taskId)
  await ipc.lspStop(taskId)
}

/**
 * Restart the LSP server for a task.
 */
async function restartLspServer(taskId: string) {
  const worktreePath = worktreePaths.get(taskId)
  if (!worktreePath) return

  const client = clients.get(taskId)
  if (client) {
    client.disconnect()
    clients.delete(taskId)
  }
  await ipc.lspStop(taskId)
  await getLspClient(taskId, worktreePath)
}

// Watch for node_modules changes and restart LSP (debounced 3s)
listen<FileTreeChangedEvent>('file-tree-changed', (event) => {
  const { taskId, path } = event.payload
  if (!clients.has(taskId)) return
  if (!path.includes('node_modules')) return

  const existing = restartTimers.get(taskId)
  if (existing) clearTimeout(existing)
  restartTimers.set(taskId, setTimeout(() => {
    restartTimers.delete(taskId)
    restartLspServer(taskId)
  }, 3000))
})
