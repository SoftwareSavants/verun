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
  setTasks(prev => [...prev.filter(t => t.projectId !== projectId), ...list])
}

export const activeTasks = () =>
  tasks.filter(t => !t.archived)

export const tasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId)

export const activeTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && !t.archived)

export const archivedTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && t.archived)

// Pinned workspaces (#61) — pinned tasks (main, trunk, etc.) live in a separate
// sidebar section above regular tasks; they skip archive / merge / PR flows.
export const pinnedTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && !t.archived && t.isPinned)

export const unpinnedActiveTasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId && !t.archived && !t.isPinned)

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
    isPinned: false,
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

/** Retry a failed task creation. */
export function retryTaskCreation(placeholderId: string, projectId: string, baseBranch: string) {
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
