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

// Track which tasks have received their first diagnostics (LSP still loading)
const [loadingTasks, setLoadingTasks] = createSignal<Set<string>>(new Set())

export function isProblemsLoading(taskId: string): boolean {
  return loadingTasks().has(taskId)
}

export function markProblemsLoading(taskId: string) {
  setLoadingTasks(prev => { const s = new Set(prev); s.add(taskId); return s })
}

function markProblemsReady(taskId: string) {
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
  const all = problemsForTask(taskId)
  let errors = 0, warnings = 0, info = 0
  for (const p of all) {
    if (p.severity === 'error') errors++
    else if (p.severity === 'warning') warnings++
    else info++
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

export function clearProblemsForTask(taskId: string) {
  setProblemMap(prev => {
    const next = { ...prev }
    delete next[taskId]
    return next
  })
  markProblemsReady(taskId)
}

// ── Initialization ───────────────────────────────────────────────────

let initialized = false

export function initProblemsListener() {
  if (initialized) return
  initialized = true

  // Import lsp helpers here (not at module level) to avoid pulling in lsp.ts
  // side effects during module evaluation — other test files import this store
  // transitively and lsp.ts has a module-level listen() call.
  let lspHelpers: { isFileOpenInEditor: (w: string, r: string) => boolean; isFileRecentlyOpened: (w: string, r: string) => boolean; clearFileOpened: (uri: string) => void } | null = null
  import('../lib/lsp').then(m => { lspHelpers = m })

  // Listen for all LSP messages and extract publishDiagnostics.
  // With vtsls + enableProjectDiagnostics, the server sends diagnostics
  // for all project files automatically — not just open ones.
  listen<LspMessagePayload>('lsp-message', (event) => {
    const { taskId, message } = event.payload

    let parsed: any
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }

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

    // Suppress transient empty diagnostics that don't reflect real state:
    // 1. didClose: vtsls clears diagnostics for closed files — suppress if file not in editor
    // 2. didOpen: vtsls clears then re-sends — suppress if file was just opened
    // In both cases, the project diagnostics server will re-report real errors.
    if (lspHelpers && problems.length === 0) {
      if (!lspHelpers.isFileOpenInEditor(task.worktreePath!, relativePath)) return
      if (lspHelpers.isFileRecentlyOpened(task.worktreePath!, relativePath)) return
    }

    // First non-empty diagnostic after didOpen — clear the recently-opened flag
    if (lspHelpers && problems.length > 0) {
      lspHelpers.clearFileOpened(`file://${task.worktreePath}/${relativePath}`)
    }

    // Queue the update — will be flushed on the next animation frame.
    // This batches rapid remove→add cycles from the LSP into a single
    // store update, preventing flicker.
    pendingUpdates.set(`${taskId}:${relativePath}`, { taskId, relativePath, problems })
    scheduleBatchFlush()
  })
}
