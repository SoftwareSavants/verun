import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { Task, Session, AgentType } from '../types'
import * as ipc from '../lib/ipc'
import { closeTerminalsForTask } from './terminals'
import { clearTaskGitState } from './git'
import { clearProblemsForTask } from './problems'
import { fireTaskCleanup } from './editorView'
import { sessionsForTask, cleanupSessionStorage, clearSessionContextsForTask } from './sessions'
import { clearTaskContext } from './taskContext'
import { clearTaskContextStorage } from './taskContextStorage'
import { dropTaskSkills } from './commands'

// Dynamic-imported on first use: static import would pull lib/lsp.ts's
// module-level `listen(...)` side effects into test evaluation for any file
// that imports the tasks store transitively.
function stopLspClient(id: string): Promise<void> {
  return import('../lib/lsp').then(m => m.stopLspClient(id))
}

export const [tasks, setTasks] = createStore<Task[]>([])

// Track tasks currently being set up (worktree creation in progress)
const [creatingTasks, setCreatingTasks] = createSignal<Set<string>>(new Set())
const [taskErrors, setTaskErrors] = createSignal<Record<string, string>>({})

// Track tasks currently being archived
const [archivingTasks, setArchivingTasks] = createSignal<Set<string>>(new Set())

export const isTaskCreating = (id: string) => creatingTasks().has(id)
export const getTaskError = (id: string) => taskErrors()[id] ?? null
export const isTaskArchiving = (id: string) => archivingTasks().has(id)

function addCreating(id: string) {
  setCreatingTasks(prev => new Set([...prev, id]))
}
function removeCreating(id: string) {
  setCreatingTasks(prev => { const s = new Set(prev); s.delete(id); return s })
}
function addArchiving(id: string) {
  setArchivingTasks(prev => new Set([...prev, id]))
}
function removeArchiving(id: string) {
  setArchivingTasks(prev => { const s = new Set(prev); s.delete(id); return s })
}
function setTaskError(id: string, error: string) {
  setTaskErrors(prev => ({ ...prev, [id]: error }))
}
export function clearTaskError(id: string) {
  setTaskErrors(prev => { const next = { ...prev }; delete next[id]; return next })
}

export async function loadTasks(projectId: string) {
  const list = await ipc.listTasks(projectId)
  // Replace tasks for this project, keep tasks from other projects
  setTasks(prev => [...prev.filter(t => t.projectId !== projectId || (cloudImports.has(t.id) && !list.some(row => row.id === t.id))), ...list])
}

export const activeTasks = () =>
  tasks.filter(t => !t.archived)

export const tasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId)

export const activeTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && !t.archived)

export const archivedTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && t.archived)

export async function createTask(projectId: string, baseBranch?: string): Promise<{ task: Task; session: Session }> {
  const result = await ipc.createTask(projectId, baseBranch)
  setTasks(produce(t => t.unshift(result.task)))
  return result
}

/** Create a placeholder task immediately, then set up worktree in the background. */
export function startTaskCreation(projectId: string, baseBranch: string, agentType: AgentType = 'claude'): string {
  const placeholderId = crypto.randomUUID()
  const now = Date.now()

  const placeholder: Task = {
    id: placeholderId,
    projectId,
    name: null,
    worktreePath: '',
    branch: 'setting up…',
    createdAt: now,
    mergeBaseSha: null,
    portOffset: 0,
    archived: false,
    archivedAt: null,
    lastCommitMessage: null,
    parentTaskId: null,
    agentType,
  }

  setTasks(produce(t => t.unshift(placeholder)))
  addCreating(placeholderId)

  // Fire and forget — runs in background
  ipc.createTask(projectId, baseBranch, agentType).then(result => {
    // Replace placeholder with real task — upsert so the task still lands
    // if the placeholder was dropped by a concurrent loadTasks reload.
    setTasks(prev => {
      if (prev.some(t => t.id === placeholderId)) {
        return prev.map(t => t.id === placeholderId ? result.task : t)
      }
      if (prev.some(t => t.id === result.task.id)) return prev
      return [result.task, ...prev]
    })
    removeCreating(placeholderId)

    // Set up session
    import('./sessions').then(({ setSessions, setOutputItems }) => {
      import('./ui').then(({ setSelectedSessionIdForTask, selectedTaskId, setSelectedTaskId }) => {
        setSessions(produce((s: any[]) => s.push(result.session)))
        setOutputItems(result.session.id, [])
        // Only auto-select session if user is still viewing this task
        if (selectedTaskId() === placeholderId) {
          setSelectedTaskId(result.task.id)
          setSelectedSessionIdForTask(result.task.id, result.session.id)
        }
      })
    })
  }).catch(err => {
    removeCreating(placeholderId)
    setTaskError(placeholderId, String(err))
  })

  return placeholderId
}

interface CloudImportJob {
  projectId: string
  importId: string | null
  choice: ipc.CloudSessionChoice
  teleported: boolean
  running: boolean
}
const cloudImports = new Map<string, CloudImportJob>()
const [cloudPhases, setCloudPhases] = createSignal<Record<string, string>>({})
export const getCloudTaskPhase = (id: string) => cloudPhases()[id] ?? null
export const isCloudTaskImport = (id: string) => getCloudTaskPhase(id) !== null
function clearCloudImport(id: string) {
  cloudImports.delete(id)
  setCloudPhases(prev => { const next = { ...prev }; delete next[id]; return next })
}

/** Transfer the picker to an app-owned job before the dialog unmounts. */
export function startCloudTaskImport(projectId: string, importId: string, choice: ipc.CloudSessionChoice): string {
  if (cloudImports.has(importId)) return importId
  cloudImports.set(importId, { projectId, importId, choice, teleported: false, running: false })
  setTasks(prev => [{
    id: importId, projectId, name: choice.title, worktreePath: '', branch: '',
    createdAt: Date.now(), mergeBaseSha: null, portOffset: 0, archived: false,
    archivedAt: null, lastCommitMessage: null, parentTaskId: null, agentType: 'claude',
  }, ...prev])
  void runCloudTaskImport(importId)
  return importId
}

export function retryCloudTaskImport(id: string) {
  void runCloudTaskImport(id)
}

async function runCloudTaskImport(id: string) {
  const job = cloudImports.get(id)
  if (!job || job.running) return
  job.running = true
  clearTaskError(id)
  addCreating(id)
  const phase = (text: string) => setCloudPhases(prev => ({ ...prev, [id]: text }))
  phase(job.teleported ? 'Preparing local task…' : 'Importing…')
  try {
    if (!job.importId) {
      phase('Reconnecting…')
      const fresh = await ipc.beginCloudImport(job.projectId)
      job.importId = fresh.importId
      // CLI ordinals can change. Never retry against an old position or an
      // ambiguous title, since the CLI doesn't expose stable session IDs.
      const matches = fresh.sessions.filter(s => s.title === job.choice.title)
      if (matches.length !== 1) throw new Error('This session changed or has a duplicate title. Remove this task and choose it again from New Task.')
      job.choice = matches[0]
    }
    if (!job.teleported) {
      phase('Importing…')
      await ipc.selectCloudImport(job.projectId, job.importId, job.choice.index)
      job.teleported = true
    }
    phase('Preparing local task…')
    const result = await ipc.finishCloudImport(job.projectId, job.importId)
    const [{ setSessions }, ui] = await Promise.all([import('./sessions'), import('./ui')])
    setSessions(prev => [result.session, ...prev.filter(s => s.id !== result.session.id)])
    setTasks(prev => [result.task, ...prev.filter(t => t.id !== id && t.id !== result.task.id)])
    if (ui.selectedTaskId() === id) {
      ui.setSelectedTaskId(result.task.id)
      ui.setSelectedSessionIdForTask(result.task.id, result.session.id)
    }
    clearCloudImport(id)
  } catch (error) {
    if (!job.teleported && job.importId) {
      await ipc.cancelCloudImport(job.importId).catch(() => {})
      job.importId = null
    }
    phase('Import failed')
    setTaskError(id, String(error).replace(/^Error: /, ''))
  } finally {
    job.running = false
    removeCreating(id)
  }
}

/** Retry a failed task creation. */
export function retryTaskCreation(placeholderId: string, projectId: string, baseBranch: string) {
  if (cloudImports.has(placeholderId)) { retryCloudTaskImport(placeholderId); return }
  clearTaskError(placeholderId)
  addCreating(placeholderId)

  ipc.createTask(projectId, baseBranch).then(result => {
    setTasks(prev => {
      if (prev.some(t => t.id === placeholderId)) {
        return prev.map(t => t.id === placeholderId ? result.task : t)
      }
      if (prev.some(t => t.id === result.task.id)) return prev
      return [result.task, ...prev]
    })
    removeCreating(placeholderId)

    import('./sessions').then(({ setSessions, setOutputItems }) => {
      import('./ui').then(({ setSelectedSessionIdForTask, selectedTaskId, setSelectedTaskId }) => {
        setSessions(produce((s: any[]) => s.push(result.session)))
        setOutputItems(result.session.id, [])
        if (selectedTaskId() === placeholderId) {
          setSelectedTaskId(result.task.id)
          setSelectedSessionIdForTask(result.task.id, result.session.id)
        }
      })
    })
  }).catch(err => {
    removeCreating(placeholderId)
    setTaskError(placeholderId, String(err))
  })
}

/** Remove a placeholder task (e.g. after failed creation). */
export function removePlaceholderTask(id: string) {
  const cloud = cloudImports.get(id)
  if (cloud?.running) return
  if (cloud?.importId) void ipc.cancelCloudImport(cloud.importId).catch(() => {})
  clearCloudImport(id)
  clearTaskError(id)
  removeCreating(id)
  setTasks(prev => prev.filter(t => t.id !== id))
}

export async function deleteTask(id: string, deleteBranch = true, skipDestroyHook = false) {
  // Fire-and-forget — stopLspClient kills the tsgo LSP process, cancels any
  // in-flight tsgo --noEmit run, and tears down the per-task Tauri listener.
  // We don't await because the rest of the teardown doesn't depend on it.
  stopLspClient(id).catch(() => {})
  closeTerminalsForTask(id)
  clearTaskGitState(id)
  clearProblemsForTask(id)
  clearSessionContextsForTask(id)
  fireTaskCleanup(id)
  clearTaskContext(id)
  dropTaskSkills(id)
  cleanupTaskStorage(id)
  await ipc.deleteTask(id, deleteBranch, skipDestroyHook)
  setTasks(prev => prev.filter(t => t.id !== id))
}

export async function archiveTask(id: string, skipDestroyHook = false) {
  addArchiving(id)
  // Optimistic — flip the flag immediately so the sidebar (and any other
  // window via the task-removed event) reflect the archive before the
  // destroy hook finishes. Reverted on IPC failure.
  const prevArchived = tasks.find(t => t.id === id)?.archived ?? false
  setTasks(t => t.id === id, 'archived', true)
  import('./ui').then(({ selectedTaskId, setSelectedTaskId }) => {
    if (selectedTaskId() === id) setSelectedTaskId(null)
  })
  try {
    stopLspClient(id).catch(() => {})
    closeTerminalsForTask(id)
    clearTaskGitState(id)
    clearProblemsForTask(id)
    clearSessionContextsForTask(id)
    fireTaskCleanup(id)
    clearTaskContext(id)
    dropTaskSkills(id)
    cleanupTaskStorage(id)
    await ipc.archiveTask(id, skipDestroyHook)
  } catch (err) {
    setTasks(t => t.id === id, 'archived', prevArchived)
    throw err
  } finally {
    removeArchiving(id)
  }
}

export async function restoreTask(id: string) {
  await ipc.restoreTask(id)
  setTasks(t => t.id === id, 'archived', false)
}

export async function updateTaskName(id: string, name: string) {
  setTasks(t => t.id === id, 'name', name)
  ipc.renameTask(id, name)
}

export const taskById = (id: string) =>
  tasks.find(t => t.id === id)

/** Remove all localStorage keys associated with a task */
export function cleanupTaskStorage(id: string) {
  clearTaskContextStorage(id)
  for (const s of sessionsForTask(id)) {
    cleanupSessionStorage(s.id)
  }
  if (localStorage.getItem('verun:selectedTaskId') === id) {
    localStorage.removeItem('verun:selectedTaskId')
  }
}
