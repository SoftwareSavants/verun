import {
  LSPClient,
  LSPPlugin,
  Workspace,
  serverCompletion,
  signatureHelp,
  serverDiagnostics,
  formatKeymap,
  renameKeymap,
  jumpToDefinitionKeymap,
  findReferencesKeymap,
} from '@codemirror/lsp-client'
import type { Transport, WorkspaceFile } from '@codemirror/lsp-client'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { EditorView, keymap } from '@codemirror/view'
import { Text } from '@codemirror/state'
import { listen } from '@tauri-apps/api/event'
import * as ipc from './ipc'
import { openFilePinned } from '../store/files'
import { markProblemsLoading, setProjectErrors } from '../store/problems'
import { addToast } from '../store/ui'
import type { FileTreeChangedEvent } from '../types'

interface LspMessagePayload {
  taskId: string
  message: string
}

// Redirect lsp-client's reportError() from its in-editor showDialog banner
// (full-width ugly popup) to our toast system. lsp-client calls this from
// many internal operations (find definition failed, rename failed, etc).
{
  const proto = LSPPlugin.prototype as unknown as {
    reportError: (message: string, err: Error | { message?: string }) => void
  }
  proto.reportError = function reportError(message, err) {
    const detail = (err as Error)?.message ?? String(err)
    addToast(`${message}: ${detail}`, 'error', {
      id: `lsp:reportError:${message}`,
      duration: 10000,
    })
  }
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

// ── tsgo settings ────────────────────────────────────────────────────
// tsgo's workspace/configuration request asks for typescript / javascript /
// editor sections; we don't need to set anything specific. Empty object is
// the safe default — tsgo uses its own internal defaults.
const LSP_SETTINGS = {}

// ── Transport ─────────────────────────────────────────────────────────

// Sinks that receive synthesized LSP messages (e.g. publishDiagnostics that
// the pull→push shim builds from tsgo's pull responses). Listeners that
// subscribe via Tauri's `lsp-message` event don't see these — they only flow
// through here. Used by the Problems panel store.
type SyntheticLspMessageSink = (taskId: string, message: string) => void
const syntheticMessageSinks = new Set<SyntheticLspMessageSink>()
export function onSyntheticLspMessage(sink: SyntheticLspMessageSink): () => void {
  syntheticMessageSinks.add(sink)
  return () => syntheticMessageSinks.delete(sink)
}

// Per-task unlisten handles for the Tauri `lsp-message` subscription created
// inside createTauriTransport. Stored as Promises because Tauri's `listen`
// is async; stopLspClient chains a `.then` to invoke the unlisten whenever
// it resolves.
const transportUnlisten = new Map<string, Promise<UnlistenFn>>()

// ── pull→push diagnostics shim ───────────────────────────────────────
// tsgo only supports textDocument/diagnostic (pull). @codemirror/lsp-client
// only handles textDocument/publishDiagnostics (push). We bridge by firing a
// pull request after every didOpen/didChange we see going out, then
// synthesizing a publishDiagnostics from the response and injecting it back
// into the transport. From lsp-client's perspective the server is push-based.
let diagRequestCounter = 0
function nextDiagId(taskId: string): string {
  diagRequestCounter += 1
  return `verun-diag-${taskId}-${diagRequestCounter}`
}

function createTauriTransport(taskId: string, workspaceFolders?: Array<{ uri: string; name: string }>): Transport {
  const handlers: Array<(msg: string) => void> = []

  // Track pending diagnostic pulls. The latest request id per URI wins; older
  // responses are dropped so a slow tsgo doesn't overwrite a newer result.
  const pendingDiagByUri = new Map<string, string>() // uri → latest pending diag id
  const diagIdToUri = new Map<string, string>()      // diag id → uri

  const pullDiagnostics = (uri: string) => {
    const id = nextDiagId(taskId)
    pendingDiagByUri.set(uri, id)
    diagIdToUri.set(id, uri)
    ipc.lspSend(taskId, JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'textDocument/diagnostic',
      params: { textDocument: { uri } },
    })).catch(() => {})
  }

  const synthesizePublishDiagnostics = (uri: string, items: unknown[]) => {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: items ?? [] },
    })
    for (const h of handlers) h(message)
    for (const s of syntheticMessageSinks) s(taskId, message)
  }

  // Each transport registers its own Tauri event subscription. We track the
  // unlisten promise so stopLspClient can tear it down — otherwise a restart
  // would accumulate parallel listeners, each firing its own pull-diagnostic
  // request on every incoming message.
  const unlistenPromise = listen<LspMessagePayload>('lsp-message', (event) => {
    if (event.payload.taskId !== taskId) return

    let msg: any
    try { msg = JSON.parse(event.payload.message) }
    catch {
      for (const h of handlers) h(event.payload.message)
      return
    }

    // Server→client requests: lsp-client doesn't handle these and would
    // respond MethodNotFound, which tsgo treats as a fatal protocol error.
    // Reply at the transport level instead.
    if (msg.id != null && typeof msg.method === 'string') {
      if (msg.method === 'workspace/configuration') {
        const items = msg.params?.items || []
        ipc.lspSend(taskId, JSON.stringify({
          jsonrpc: '2.0', id: msg.id, result: items.map(() => LSP_SETTINGS),
        })).catch(() => {})
        return
      }
      if (msg.method === 'client/registerCapability'
          || msg.method === 'client/unregisterCapability') {
        ipc.lspSend(taskId, JSON.stringify({
          jsonrpc: '2.0', id: msg.id, result: null,
        })).catch(() => {})
        return
      }
    }

    // Intercept responses to our pull-diagnostic requests and convert them
    // into synthesized publishDiagnostics notifications.
    if (typeof msg.id === 'string' && msg.id.startsWith('verun-diag-')) {
      const uri = diagIdToUri.get(msg.id)
      diagIdToUri.delete(msg.id)
      // Drop superseded responses (a newer pull for the same URI is in flight).
      if (uri && pendingDiagByUri.get(uri) === msg.id) {
        pendingDiagByUri.delete(uri)
        const result = msg.result
        const items = result && typeof result === 'object' && 'items' in result
          ? (result as { items: unknown[] }).items
          : []
        synthesizePublishDiagnostics(uri, items)
      }
      return
    }

    // Swallow window/showMessage and surface as a toast. lsp-client's default
    // handler renders a full-width in-editor dialog. LSP spec: 1=Error,
    // 2=Warning, 3=Info, 4=Log.
    if (msg.method === 'window/showMessage') {
      const t = msg.params?.type
      if (t !== 4) {
        const text = `TypeScript server: ${msg.params?.message ?? 'unknown'}`
        const toastType: 'error' | 'info' = t === 1 ? 'error' : 'info'
        addToast(text, toastType, { id: `lsp:${taskId}:showMessage`, duration: 10000 })
      }
      return
    }

    // Mute tsgo's verbose window/logMessage stream. lsp-client passes these
    // through to console; not useful in production.
    if (msg.method === 'window/logMessage') return

    for (const h of handlers) h(event.payload.message)
  })

  // Replace any stale subscription for this task (defensive — stopLspClient
  // should have cleared it already) and store the new one.
  const prev = transportUnlisten.get(taskId)
  if (prev) prev.then(fn => fn()).catch(() => {})
  transportUnlisten.set(taskId, unlistenPromise)

  return {
    send(message: string) {
      let parsed: any
      try { parsed = JSON.parse(message) } catch { /* not JSON */ }

      if (parsed) {
        // Inject workspaceFolders into the initialize request. Single-folder
        // for the worktree root — tsgo discovers tsconfigs lazily as files
        // open, which keeps RSS proportional to what the user actually uses.
        if (parsed.method === 'initialize' && workspaceFolders?.length) {
          parsed.params.workspaceFolders = workspaceFolders
          message = JSON.stringify(parsed)
        }
      }

      ipc.lspSend(taskId, message)

      // Pull-to-push shim: after every didOpen/didChange that goes out, fire
      // a textDocument/diagnostic for the same URI. lsp-client's autoSync
      // already debounces didChange to 500ms after typing stops, so we don't
      // need our own debounce here.
      if (parsed) {
        if (parsed.method === 'textDocument/didOpen') {
          const uri = parsed.params?.textDocument?.uri
          if (typeof uri === 'string') pullDiagnostics(uri)
        } else if (parsed.method === 'textDocument/didChange') {
          const uri = parsed.params?.textDocument?.uri
          if (typeof uri === 'string') pullDiagnostics(uri)
        } else if (parsed.method === 'textDocument/didSave') {
          const uri = parsed.params?.textDocument?.uri
          if (typeof uri === 'string') pullDiagnostics(uri)
        }
      }
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
  try {
    await ipc.lspStart(taskId, worktreePath)
  } catch (e) {
    addToast(
      `tsgo failed to start: ${e instanceof Error ? e.message : String(e)}`,
      'error',
      { id: `lsp:${taskId}:start`, duration: 10000 },
    )
    throw e
  }
  worktreePaths.set(taskId, worktreePath)

  // Single-folder workspace at the worktree root. tsgo discovers per-package
  // tsconfigs lazily as the user opens files; preloading every tsconfig would
  // load each as a separate project and balloon RSS on monorepos.
  const workspaceFolders = [
    { uri: `file://${worktreePath}`, name: worktreePath.split('/').pop() || 'root' },
  ]

  const client = new LSPClient({
    rootUri: `file://${worktreePath}`,
    workspace: (c) => new VerunWorkspace(c, worktreePath, taskId),
    extensions: [
      // languageServerExtensions() bundles hoverTooltips() for types, which
      // stacks on top of lint's diagnostic hover. We want a single merged
      // tooltip (error on top, type below), implemented per-view in CodeEditor,
      // so we skip hoverTooltips() here and include everything else.
      serverCompletion(),
      keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
      signatureHelp(),
      serverDiagnostics(),
      // Advertise workspace/configuration + workspaceFolders so tsgo sends a
      // ConfigurationRequest during init (handled by the transport
      // interceptor). Diagnostics themselves are pull-only on tsgo; the
      // transport shim translates them to synthetic publishDiagnostics.
      { clientCapabilities: { workspace: { configuration: true, workspaceFolders: true } } },
    ],
  })

  client.connect(createTauriTransport(taskId, workspaceFolders))
  clients.set(taskId, client)

  await client.initializing

  // Mark loading so the Problems panel shows a spinner
  markProblemsLoading(taskId)

  // Kick off an immediate project-wide typecheck so the Problems panel
  // populates without the user having to touch any file. Subsequent runs are
  // triggered by file-tree changes (debounced below).
  ipc.tsgoCheckRun(taskId, worktreePath).catch(() => {})

  return client
}

/**
 * Check if a file extension is supported by our LSP.
 */
export function isLspSupported(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)
}

// Per-task debounce for project-wide tsgo --noEmit reruns triggered by file
// changes. Cancelled when the task's LSP shuts down.
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
const RECHECK_DEBOUNCE_MS = 3000

function scheduleProjectRecheck(taskId: string) {
  if (!worktreePaths.has(taskId)) return
  const existing = recheckTimers.get(taskId)
  if (existing) clearTimeout(existing)
  recheckTimers.set(taskId, setTimeout(() => {
    recheckTimers.delete(taskId)
    if (!clients.has(taskId)) return
    // Re-read the worktree path at firing time — if the task was torn down
    // and rebuilt during the debounce window, we want the fresh path, not
    // a stale one captured in the closure.
    const worktreePath = worktreePaths.get(taskId)
    if (!worktreePath) return
    ipc.tsgoCheckRun(taskId, worktreePath).catch(() => {})
  }, RECHECK_DEBOUNCE_MS))
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
  const unlisten = transportUnlisten.get(taskId)
  if (unlisten) {
    transportUnlisten.delete(taskId)
    unlisten.then(fn => fn()).catch(() => {})
  }
  const timer = restartTimers.get(taskId)
  if (timer) clearTimeout(timer)
  restartTimers.delete(taskId)
  const recheck = recheckTimers.get(taskId)
  if (recheck) clearTimeout(recheck)
  recheckTimers.delete(taskId)
  ipc.tsgoCheckCancel(taskId).catch(() => {})
  await ipc.lspStop(taskId)
}

/**
 * Restart the LSP server for a task.
 */
export async function restartLspServer(taskId: string) {
  const worktreePath = worktreePaths.get(taskId)
  if (!worktreePath) return

  // Go through stopLspClient so the transport's Tauri listener and all the
  // per-task timers get torn down. Otherwise each restart would leak another
  // lsp-message subscription.
  await stopLspClient(taskId)
  await getLspClient(taskId, worktreePath)
}

// Surface LSP process crashes as long toasts. Rust emits `lsp-exit` when the
// tsgo child closes stdout (abnormal or otherwise); if the client is still
// connected from our perspective, treat that as a crash.
interface LspExitPayload { taskId: string }
listen<LspExitPayload>('lsp-exit', (event) => {
  const { taskId } = event.payload
  if (!clients.has(taskId)) return
  addToast(
    'tsgo crashed — restart the task to recover',
    'error',
    { id: `lsp:${taskId}:crash`, duration: 10000 },
  )
})

// Watch for file tree changes:
//   - node_modules changes restart the LSP entirely (debounced 3s)
//   - any other change schedules a project-wide tsgo --noEmit rerun (3s)
listen<FileTreeChangedEvent>('file-tree-changed', (event) => {
  const { taskId, path } = event.payload
  if (!clients.has(taskId)) return

  if (path.includes('node_modules')) {
    const existing = restartTimers.get(taskId)
    if (existing) clearTimeout(existing)
    restartTimers.set(taskId, setTimeout(() => {
      restartTimers.delete(taskId)
      restartLspServer(taskId)
    }, 3000))
    return
  }

  // Only retypecheck on changes to source files we care about.
  if (!isLspSupported(path)) return
  scheduleProjectRecheck(taskId)
})

// Forward project-wide typecheck results into the Problems panel store.
interface TsgoCheckResultPayload {
  taskId: string
  problems: Array<{
    file: string; line: number; column: number;
    severity: 'error' | 'warning' | 'info' | 'hint';
    code: string; message: string;
  }>
  durationMs: number
  ok: boolean
}
listen<TsgoCheckResultPayload>('tsgo-check-result', (event) => {
  const { taskId, problems, ok } = event.payload
  if (!ok) return
  setProjectErrors(taskId, problems)
})
