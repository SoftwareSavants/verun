import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { taskById } from './tasks'
import type { Problem, DiagnosticSeverity } from '../types'

// LSP diagnostic severity: 1=Error, 2=Warning, 3=Information, 4=Hint
const SEVERITY_MAP: Record<number, DiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

interface LspMessagePayload {
  taskId: string
  message: string
}

// taskId → { relativePath → Problem[] }
const [problemMap, setProblemMap] = createSignal<Record<string, Record<string, Problem[]>>>({})

// ── Batched updates ──────────────────────────────────────────────────
// The LSP often sends remove→add for the same file in quick succession
// (e.g. during file open). We batch all updates and flush once per frame
// so they collapse into a single store write.

interface PendingUpdate {
  taskId: string
  relativePath: string
  problems: Problem[]
}

const pendingUpdates = new Map<string, PendingUpdate>()
let flushScheduled = false

function scheduleBatchFlush() {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(flushBatch)
}

function flushBatch() {
  flushScheduled = false
  if (pendingUpdates.size === 0) return

  const updates = [...pendingUpdates.values()]
  pendingUpdates.clear()

  setProblemMap(prev => {
    let next = prev
    for (const { taskId, relativePath, problems } of updates) {
      const existing = (next[taskId] || {})[relativePath]

      // Skip if identical
      if (problems.length > 0 && existing && existing.length === problems.length &&
        existing.every((e, i) =>
          e.line === problems[i].line &&
          e.column === problems[i].column &&
          e.message === problems[i].message &&
          e.severity === problems[i].severity
        )) continue

      // Skip noop (empty incoming, nothing stored)
      if (problems.length === 0 && !existing) continue

      // Ensure mutable top-level map
      if (next === prev) next = { ...prev }

      // Ensure mutable task entry (clone once per task per batch)
      if (!next[taskId] || next[taskId] === prev[taskId]) {
        next[taskId] = { ...(prev[taskId] || {}) }
      }

      if (problems.length > 0) {
        next[taskId][relativePath] = problems
      } else {
        delete next[taskId][relativePath]
      }
    }
    return next
  })
}

// ── Gitignore filtering ─────────────────────────────────────────────
// Project-wide typechecks walk everything inside the tsconfig include set,
// which often covers gitignored build output (.next, dist, etc) — noise we
// don't want in the Problems panel. Batch-check unknown paths via
// git check-ignore and cache the results per task.

const ignoredPaths = new Map<string, Set<string>>()   // taskId → known-ignored paths
const checkedPaths = new Map<string, Set<string>>()   // taskId → paths we've already checked
const pendingIgnoreChecks = new Map<string, Set<string>>() // taskId → paths needing a check
let ignoreCheckScheduled = false

function isKnownIgnored(taskId: string, relativePath: string): boolean {
  return ignoredPaths.get(taskId)?.has(relativePath) ?? false
}

function queueIgnoreCheck(taskId: string, relativePath: string) {
  const checked = checkedPaths.get(taskId)
  if (checked?.has(relativePath)) return

  let batch = pendingIgnoreChecks.get(taskId)
  if (!batch) { batch = new Set(); pendingIgnoreChecks.set(taskId, batch) }
  batch.add(relativePath)

  if (!ignoreCheckScheduled) {
    ignoreCheckScheduled = true
    requestAnimationFrame(flushIgnoreChecks)
  }
}

async function flushIgnoreChecks() {
  ignoreCheckScheduled = false
  const { checkGitignored } = await import('../lib/ipc')

  for (const [taskId, paths] of pendingIgnoreChecks) {
    const pathArray = [...paths]

    // Mark all as checked so we don't re-check
    let checked = checkedPaths.get(taskId)
    if (!checked) { checked = new Set(); checkedPaths.set(taskId, checked) }
    for (const p of pathArray) checked.add(p)

    try {
      const ignoredResults = await checkGitignored(taskId, pathArray)
      if (ignoredResults.length > 0) {
        let ignored = ignoredPaths.get(taskId)
        if (!ignored) { ignored = new Set(); ignoredPaths.set(taskId, ignored) }
        for (const p of ignoredResults) ignored.add(p)

        // Remove ignored files that already made it into the store
        setProblemMap(prev => {
          const taskProblems = prev[taskId]
          if (!taskProblems) return prev
          let changed = false
          const next = { ...taskProblems }
          for (const p of ignoredResults) {
            if (next[p]) { delete next[p]; changed = true }
          }
          return changed ? { ...prev, [taskId]: next } : prev
        })
      }
    } catch {
      // git check-ignore failed — let diagnostics through rather than hiding them
    }
  }
  pendingIgnoreChecks.clear()
}

// Track which tasks have received their first diagnostics (LSP still loading)
const [loadingTasks, setLoadingTasks] = createSignal<Set<string>>(new Set())

export function isProblemsLoading(taskId: string): boolean {
  return loadingTasks().has(taskId)
}

const loadingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

export function markProblemsLoading(taskId: string) {
  setLoadingTasks(prev => { const s = new Set(prev); s.add(taskId); return s })
  // Auto-clear loading if no diagnostics arrive within 15s (e.g. tsgo crashed)
  const existing = loadingTimeouts.get(taskId)
  if (existing) clearTimeout(existing)
  loadingTimeouts.set(taskId, setTimeout(() => {
    loadingTimeouts.delete(taskId)
    markProblemsReady(taskId)
  }, 15_000))
}

function markProblemsReady(taskId: string) {
  const t = loadingTimeouts.get(taskId)
  if (t) { clearTimeout(t); loadingTimeouts.delete(taskId) }
  setLoadingTasks(prev => {
    if (!prev.has(taskId)) return prev
    const s = new Set(prev); s.delete(taskId); return s
  })
}

// ── Exports ──────────────────────────────────────────────────────────

export function problemsForTask(taskId: string): Problem[] {
  const byFile = problemMap()[taskId]
  if (!byFile) return []
  const result: Problem[] = []
  for (const problems of Object.values(byFile)) {
    result.push(...problems)
  }
  return result
}

export function problemsByFileForTask(taskId: string): Record<string, Problem[]> {
  return problemMap()[taskId] || {}
}

export function problemCountForTask(taskId: string): { errors: number; warnings: number; info: number } {
  const byFile = problemMap()[taskId]
  let errors = 0, warnings = 0, info = 0
  if (!byFile) return { errors, warnings, info }
  for (const problems of Object.values(byFile)) {
    for (const p of problems) {
      if (p.severity === 'error') errors++
      else if (p.severity === 'warning') warnings++
      else info++
    }
  }
  return { errors, warnings, info }
}

export function fileHasErrors(taskId: string, relativePath: string): boolean {
  const byFile = problemMap()[taskId]
  if (!byFile) return false
  const problems = byFile[relativePath]
  if (!problems) return false
  return problems.some(p => p.severity === 'error')
}

export function fileHasWarnings(taskId: string, relativePath: string): boolean {
  const byFile = problemMap()[taskId]
  if (!byFile) return false
  const problems = byFile[relativePath]
  if (!problems) return false
  return problems.some(p => p.severity === 'warning')
}

export function pathHasErrors(taskId: string, pathPrefix: string): boolean {
  const byFile = problemMap()[taskId]
  if (!byFile) return false
  const prefix = pathPrefix ? pathPrefix + '/' : ''
  for (const [filePath, problems] of Object.entries(byFile)) {
    if (filePath.startsWith(prefix) && problems.some(p => p.severity === 'error')) {
      return true
    }
  }
  return false
}

export function pathHasWarnings(taskId: string, pathPrefix: string): boolean {
  const byFile = problemMap()[taskId]
  if (!byFile) return false
  const prefix = pathPrefix ? pathPrefix + '/' : ''
  for (const [filePath, problems] of Object.entries(byFile)) {
    if (filePath.startsWith(prefix) && problems.some(p => p.severity === 'warning')) {
      return true
    }
  }
  return false
}

// Atomic project-wide replacement, used by the `tsgo --noEmit` pipeline.
// Files currently open in an editor are left untouched — those are owned by
// the LSP pull→push shim, which is faster to react to in-flight edits than a
// debounced full-project check would be. Anything else (gitignored,
// node_modules) is filtered out the same way as the per-file path.
export interface ProjectError {
  file: string
  line: number
  column: number
  severity: DiagnosticSeverity
  code?: string
  message: string
}

// Shallow identity check: are two Problem arrays effectively the same set of
// errors? Used to short-circuit a no-op setProjectErrors call so the signal
// doesn't notify downstream consumers for nothing.
function problemsEqual(a: Problem[], b: Problem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.line !== y.line || x.column !== y.column
        || x.severity !== y.severity || x.message !== y.message
        || x.code !== y.code) return false
  }
  return true
}

export function setProjectErrors(taskId: string, errors: ProjectError[]) {
  // Drop late results for a task the user has since deleted. tsgo --noEmit
  // can take tens of seconds on a big monorepo, so a task can easily be
  // torn down in between kicking off the check and receiving the event.
  // Without this, a stale emit would re-add the task to the problems map.
  const task = taskById(taskId)
  if (!task?.worktreePath) return
  const worktreePath = task.worktreePath

  // Drop any pending per-file updates for this task — the project-wide
  // snapshot is more authoritative for files we're about to overwrite.
  for (const key of [...pendingUpdates.keys()]) {
    if (key.startsWith(`${taskId}:`)) pendingUpdates.delete(key)
  }
  markProblemsReady(taskId)

  // Bucket by file, dropping anything we already know to ignore.
  const byFile = new Map<string, Problem[]>()
  for (const err of errors) {
    if (err.file.startsWith('node_modules/')) continue
    if (isKnownIgnored(taskId, err.file)) continue
    queueIgnoreCheck(taskId, err.file)

    let bucket = byFile.get(err.file)
    if (!bucket) { bucket = []; byFile.set(err.file, bucket) }
    bucket.push({
      file: err.file,
      line: err.line,
      column: err.column,
      endLine: err.line,
      endColumn: err.column,
      severity: err.severity,
      message: err.message,
      code: err.code,
      source: 'typescript',
    })
  }

  setProblemMap(prev => {
    const prevForTask = prev[taskId] || {}
    const nextForTask: Record<string, Problem[]> = {}
    const isOpen = (relPath: string) =>
      !!lspHelpersForProjectErrors?.isFileOpenInEditor(worktreePath, relPath)

    // Carry over entries for files currently open in an editor — the LSP
    // shim owns those.
    for (const [relPath, problems] of Object.entries(prevForTask)) {
      if (isOpen(relPath)) nextForTask[relPath] = problems
    }

    // Merge in the project-wide results, but skip any file the LSP is owning.
    for (const [relPath, problems] of byFile) {
      if (isOpen(relPath)) continue
      nextForTask[relPath] = problems
    }

    // Bail out if the new state matches the previous state exactly. This is
    // the common case on a stable codebase — re-running the check after a
    // save should not churn the signal when nothing changed.
    const prevKeys = Object.keys(prevForTask)
    const nextKeys = Object.keys(nextForTask)
    if (prevKeys.length === nextKeys.length) {
      let changed = false
      for (const k of nextKeys) {
        const a = prevForTask[k], b = nextForTask[k]
        if (!a || !problemsEqual(a, b)) { changed = true; break }
      }
      if (!changed) return prev
    }

    return { ...prev, [taskId]: nextForTask }
  })
}

// Populated by initProblemsListener once the lsp module has loaded. Kept as
// a narrow interface so this module doesn't statically depend on lib/lsp.ts
// (the dynamic import pattern breaks an import cycle for tests).
let lspHelpersForProjectErrors: { isFileOpenInEditor: (w: string, r: string) => boolean } | null = null

/** Directly inject problems for demo/screenshot mode — bypasses LSP and IPC. */
export function seedDemoProblems(data: Record<string, Record<string, import('../types').Problem[]>>) {
  setProblemMap(prev => ({ ...prev, ...data }))
}

export function clearProblemsForTask(taskId: string) {
  setProblemMap(prev => {
    const next = { ...prev }
    delete next[taskId]
    return next
  })
  markProblemsReady(taskId)
  ignoredPaths.delete(taskId)
  checkedPaths.delete(taskId)
  pendingIgnoreChecks.delete(taskId)
}

// ── Initialization ───────────────────────────────────────────────────

let initialized = false

export function initProblemsListener() {
  if (initialized) return
  initialized = true

  // lsp helpers are loaded lazily so this module stays import-cycle-free for
  // tests. Start out null; the dynamic import below fills them in.
  let lspHelpers: { isFileOpenInEditor: (w: string, r: string) => boolean } | null = null

  const handleLspMessage = (taskId: string, message: string) => {
    let parsed: any
    try { parsed = JSON.parse(message) }
    catch { return }

    if (parsed.method !== 'textDocument/publishDiagnostics') return

    // First diagnostics received — LSP is done loading for this task
    markProblemsReady(taskId)

    const params = parsed.params
    if (!params?.uri || !Array.isArray(params.diagnostics)) return

    const task = taskById(taskId)
    if (!task?.worktreePath) return

    // Convert file:///path/to/worktree/src/foo.ts → src/foo.ts
    const prefix = `file://${task.worktreePath}/`
    if (!params.uri.startsWith(prefix)) return
    const relativePath = decodeURIComponent(params.uri.slice(prefix.length))

    // Skip node_modules diagnostics
    if (relativePath.startsWith('node_modules/')) return

    // Skip gitignored files (checked async, cached for future diagnostics)
    if (isKnownIgnored(taskId, relativePath)) return
    queueIgnoreCheck(taskId, relativePath)

    const problems: Problem[] = params.diagnostics.map((d: any) => ({
      file: relativePath,
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      endLine: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
      severity: SEVERITY_MAP[d.severity] || 'info',
      message: d.message || '',
      code: typeof d.code === 'object' ? d.code?.value : d.code,
      source: d.source || 'unknown',
    }))

    // Empty diagnostics for files that aren't currently open in an editor
    // are stray pushes (e.g. tsgo's tsconfig-scope diagnostics) — skip them.
    if (lspHelpers && problems.length === 0
        && !lspHelpers.isFileOpenInEditor(task.worktreePath!, relativePath)) {
      return
    }

    // Queue the update — will be flushed on the next animation frame.
    // Batches rapid remove→add cycles into a single store update.
    pendingUpdates.set(`${taskId}:${relativePath}`, { taskId, relativePath, problems })
    scheduleBatchFlush()
  }

  // Real publishDiagnostics from tsgo (e.g. tsconfig errors) arrive on the
  // raw Tauri lsp-message event. Source-file diagnostics arrive via the
  // synthetic sink registered below.
  listen<LspMessagePayload>('lsp-message', (event) => {
    handleLspMessage(event.payload.taskId, event.payload.message)
  })

  import('../lib/lsp').then(m => {
    lspHelpers = { isFileOpenInEditor: m.isFileOpenInEditor }
    lspHelpersForProjectErrors = lspHelpers
    m.onSyntheticLspMessage(handleLspMessage)
  })
}
