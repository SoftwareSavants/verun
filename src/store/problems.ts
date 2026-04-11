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

// Debounce timers for clearing diagnostics (prevents flicker on file open)
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

    // Skip update if diagnostics haven't changed (prevents flicker on file open)
    const existing = problemMap()[taskId]?.[relativePath]
    if (problems.length === 0 && !existing) return
    if (existing && existing.length === problems.length &&
      existing.every((e, i) =>
        e.line === problems[i].line &&
        e.column === problems[i].column &&
        e.message === problems[i].message &&
        e.severity === problems[i].severity
      )) return

    // Debounce clearing: when the LSP sends empty diagnostics (e.g. during
    // file open), wait briefly — real diagnostics usually follow immediately.
    if (problems.length === 0 && existing && existing.length > 0) {
      const key = `${taskId}:${relativePath}`
      if (clearTimers.has(key)) return
      clearTimers.set(key, setTimeout(() => {
        clearTimers.delete(key)
        // Re-check: if still no diagnostics arrived, clear for real
        const current = problemMap()[taskId]?.[relativePath]
        if (current === existing) {
          setProblemMap(prev => {
            const taskProblems = { ...(prev[taskId] || {}) }
            delete taskProblems[relativePath]
            return { ...prev, [taskId]: taskProblems }
          })
        }
      }, 2000))
      return
    }

    // Cancel any pending clear for this file
    const clearKey = `${taskId}:${relativePath}`
    const pendingClear = clearTimers.get(clearKey)
    if (pendingClear) {
      clearTimeout(pendingClear)
      clearTimers.delete(clearKey)
    }

    setProblemMap(prev => {
      const taskProblems = { ...(prev[taskId] || {}) }
      taskProblems[relativePath] = problems
      return { ...prev, [taskId]: taskProblems }
    })
  })
}
