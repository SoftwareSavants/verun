import { LSPClient, LSPPlugin, Workspace, languageServerExtensions } from '@codemirror/lsp-client'
import type { Transport, WorkspaceFile } from '@codemirror/lsp-client'
import { EditorView } from '@codemirror/view'
import { Text } from '@codemirror/state'
import { listen } from '@tauri-apps/api/event'
import * as ipc from './ipc'
import { openFilePinned } from '../store/files'
import { markProblemsLoading } from '../store/problems'
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

/** Check if a file is currently open in an editor (by relative path + worktree) */
export function isFileOpenInEditor(worktreePath: string, relativePath: string): boolean {
  return editorViews.has(`file://${worktreePath}/${relativePath}`)
}

// ── didOpen suppression ──────────────────────────────────────────────
// When didOpen is sent, vtsls clears diagnostics (empty publishDiagnostics)
// then re-analyzes (real diagnostics). We suppress the transient empty.
const recentlyOpenedFiles = new Set<string>()

/** Mark a file as recently opened — suppresses the next empty diagnostic */
export function markFileOpened(uri: string) {
  recentlyOpenedFiles.add(uri)
}

/** Clear the recently-opened flag (called when real diagnostics arrive) */
export function clearFileOpened(uri: string) {
  recentlyOpenedFiles.delete(uri)
}

/** Check if a file was just didOpen'd (transient empty should be suppressed) */
export function isFileRecentlyOpened(worktreePath: string, relativePath: string): boolean {
  return recentlyOpenedFiles.has(`file://${worktreePath}/${relativePath}`)
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
  private taskId: string

  constructor(client: LSPClient, worktreePath: string, taskId: string) {
    super(client)
    this.worktreePath = worktreePath
    this.taskId = taskId
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
    // If already open with a different view (editor was recreated), replace
    // the stale WorkspaceFile so the LSP plugin renders on the current view.
    const existing = this.getFile(uri) as VerunWorkspaceFile | undefined
    if (existing) {
      if (existing.getView() === view) return
      this.files = this.files.filter(f => f !== existing)
    }
    markFileOpened(uri)
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
    openFilePinned(this.taskId, relativePath, name)

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

// ── vtsls settings ───────────────────────────────────────────────────
// Returned when vtsls sends a workspace/configuration request during init.
// This is how enableProjectDiagnostics gets set BEFORE the service spawns
// its diagnostics server — sending didChangeConfiguration after init is too late.
const VTSLS_SETTINGS = {
  typescript: {
    tsserver: {
      experimental: { enableProjectDiagnostics: true },
    },
  },
  vtsls: {
    autoUseWorkspaceTsdk: true,
  },
}

// ── Transport ─────────────────────────────────────────────────────────
// Per-task injectors — lets us push synthetic messages into the transport
// so @codemirror/lsp-client processes them as if they came from vtsls.
const transportInjectors = new Map<string, (msg: string) => void>()

/** Inject a message into a task's transport handlers (for replaying cached diagnostics) */
export function injectLspMessage(taskId: string, message: string) {
  transportInjectors.get(taskId)?.(message)
}

function createTauriTransport(taskId: string, worktreePath: string, workspaceFolders?: Array<{ uri: string; name: string }>): Transport {
  const handlers: Array<(msg: string) => void> = []
  transportInjectors.set(taskId, (msg: string) => {
    for (const h of handlers) h(msg)
  })

  listen<LspMessagePayload>('lsp-message', (event) => {
    if (event.payload.taskId !== taskId) return

    // Intercept workspace/configuration requests from vtsls.
    // vtsls sends this during initialization to pull settings (enableProjectDiagnostics, etc).
    // @codemirror/lsp-client doesn't handle server→client requests — it responds with
    // MethodNotFound, which crashes vtsls. We handle it here at the transport level.
    try {
      const msg = JSON.parse(event.payload.message)
      if (msg.id != null && msg.method === 'workspace/configuration') {
        const items = msg.params?.items || []
        const result = items.map(() => VTSLS_SETTINGS)
        ipc.lspSend(taskId, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
        return
      }
    } catch { /* parse error — fall through to handlers */ }

    for (const h of handlers) {
      h(event.payload.message)
    }
  })

  return {
    send(message: string) {
      try {
        const msg = JSON.parse(message)
        // Inject workspaceFolders into the initialize request for monorepo support
        if (msg.method === 'initialize' && workspaceFolders?.length) {
          msg.params.workspaceFolders = workspaceFolders
          message = JSON.stringify(msg)
        }
        // When initialized is sent, vtsls starts initializeService() which spawns
        // tsserver. After 3s (enough for tsserver to start), auto-open one file
        // to trigger geterrForProject and populate the problems panel.
        if (msg.method === 'initialized') {
          setTimeout(() => autoDiscoverProjects(taskId, worktreePath), 3000)
        }
      } catch { /* not JSON — send as-is */ }
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
 * Find all tsconfig.json directories and build workspace folder entries for
 * the LSP initialize request. In monorepos, this tells vtsls about all
 * sub-projects so it can discover and analyze them from the start.
 */
async function findWorkspaceFolders(taskId: string, worktreePath: string): Promise<Array<{ uri: string; name: string }>> {
  try {
    const allFiles = await ipc.listWorktreeFiles(taskId)
    const folders: Array<{ uri: string; name: string }> = [
      { uri: `file://${worktreePath}`, name: worktreePath.split('/').pop() || 'root' },
    ]
    for (const f of allFiles) {
      if (f.endsWith('/tsconfig.json')) {
        const dir = f.slice(0, f.lastIndexOf('/'))
        folders.push({
          uri: `file://${worktreePath}/${dir}`,
          name: dir.split('/').pop() || dir,
        })
      }
    }
    return folders
  } catch {
    return [{ uri: `file://${worktreePath}`, name: worktreePath.split('/').pop() || 'root' }]
  }
}

/** Send a didOpen for a file via raw IPC. */
async function sendDidOpen(taskId: string, worktreePath: string, relPath: string): Promise<boolean> {
  try {
    const content = await ipc.readTextFile(`${worktreePath}/${relPath}`)
    const uri = `file://${worktreePath}/${relPath}`
    const ext = relPath.split('.').pop() || ''
    const languageId = ext === 'tsx' ? 'typescriptreact' : 'typescript'
    await ipc.lspSend(taskId, JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId, version: 0, text: content } },
    }))
    return true
  } catch { return false }
}

/**
 * Discover all TS projects in the worktree by chaining didOpen calls.
 * Called from the transport's send interceptor when it sees the outgoing
 * `initialized` notification — timed 3s after so vtsls has spawned tsserver.
 *
 * Flow:
 *   1. Find one .ts/.tsx file per tsconfig directory
 *   2. Open the first one, wait for publishDiagnostics to confirm service is live
 *   3. Chain the rest: open, wait 3s of diagnostic quiet, repeat
 */
async function autoDiscoverProjects(taskId: string, worktreePath: string) {
  if (!clients.has(taskId)) return

  let allFiles: string[]
  try { allFiles = await ipc.listWorktreeFiles(taskId) }
  catch { return }

  // Find all tsconfig directories (including root)
  const tsconfigDirs: string[] = []
  let hasRootTsconfig = false
  for (const f of allFiles) {
    if (f === 'tsconfig.json') { hasRootTsconfig = true; continue }
    if (f.endsWith('/tsconfig.json')) {
      tsconfigDirs.push(f.slice(0, f.lastIndexOf('/')))
    }
  }

  // Pick one representative .ts/.tsx file per tsconfig dir
  const filesToOpen: string[] = []
  const pickFile = (prefix: string) => allFiles.find(f =>
    f.startsWith(prefix) &&
    /\.(ts|tsx)$/.test(f) &&
    !f.includes('node_modules') &&
    !f.includes('.next/') &&
    !f.includes('/dist/') &&
    !f.includes('/build/')
  )

  if (hasRootTsconfig) {
    const root = pickFile('')
    if (root) filesToOpen.push(root)
  } else if (tsconfigDirs.length === 0) {
    // No tsconfigs at all — fall back to opening any TS file
    const any = pickFile('')
    if (any) filesToOpen.push(any)
  }
  for (const dir of tsconfigDirs) {
    const file = pickFile(dir + '/')
    if (file) filesToOpen.push(file)
  }
  if (filesToOpen.length === 0) return

  // Open the first file — this triggers service init confirmation
  const first = filesToOpen.shift()!
  const ok = await sendDidOpen(taskId, worktreePath, first)
  if (!ok || filesToOpen.length === 0) return

  // Chain remaining projects: wait for 3s of diagnostic quiet, then open next
  const { listen: tauriListen } = await import('@tauri-apps/api/event')
  let idx = 0

  const openNext = async () => {
    if (idx >= filesToOpen.length || !clients.has(taskId)) return
    const file = filesToOpen[idx++]
    await sendDidOpen(taskId, worktreePath, file)

    // Wait for 3s of diagnostic quiet, then move on
    let settleTimer: ReturnType<typeof setTimeout>
    const unlisten = await tauriListen<{ taskId: string; message: string }>('lsp-message', (event) => {
      if (event.payload.taskId !== taskId) return
      try {
        const msg = JSON.parse(event.payload.message)
        if (msg.method === 'textDocument/publishDiagnostics') {
          clearTimeout(settleTimer)
          settleTimer = setTimeout(onSettle, 3000)
        }
      } catch {}
    })
    const onSettle = () => { unlisten(); openNext() }
    settleTimer = setTimeout(onSettle, 3000)
  }

  openNext()
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

  // Find tsconfig.json directories for monorepo workspace folder support
  const workspaceFolders = await findWorkspaceFolders(taskId, worktreePath)

  const client = new LSPClient({
    rootUri: `file://${worktreePath}`,
    workspace: (c) => new VerunWorkspace(c, worktreePath, taskId),
    extensions: [
      ...languageServerExtensions(),
      // Advertise capabilities so vtsls sends ConfigurationRequest during init
      // (handled by the transport interceptor) and accepts workspace folder updates.
      { clientCapabilities: { workspace: { configuration: true, workspaceFolders: true } } },
    ],
  })

  client.connect(createTauriTransport(taskId, worktreePath, workspaceFolders))
  clients.set(taskId, client)

  await client.initializing

  // Mark loading so the Problems panel shows a spinner
  markProblemsLoading(taskId)

  // Also send didChangeConfiguration — the transport interceptor handles the
  // init-time workspace/configuration request (setting enableProjectDiagnostics),
  // but this notification triggers vtsls to re-analyze open files and emit
  // publishDiagnostics, which @codemirror/lsp-client needs for inline rendering.
  ipc.lspSend(taskId, JSON.stringify({
    jsonrpc: '2.0',
    method: 'workspace/didChangeConfiguration',
    params: { settings: VTSLS_SETTINGS },
  })).catch(() => {})

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
  transportInjectors.delete(taskId)
  const timer = restartTimers.get(taskId)
  if (timer) clearTimeout(timer)
  restartTimers.delete(taskId)
  await ipc.lspStop(taskId)
}

/**
 * Restart the LSP server for a task.
 */
export async function restartLspServer(taskId: string) {
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
