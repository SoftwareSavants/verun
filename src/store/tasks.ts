import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { Task, Session } from '../types'
import * as ipc from '../lib/ipc'
import { closeTerminalsForTask } from './terminals'
import { clearTaskGitState } from './git'
import { clearProblemsForTask } from './problems'
import { fireTaskCleanup } from './files'

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

export async function createTask(projectId: string, baseBranch?: string): Promise<{ task: Task; session: Session }> {
  const result = await ipc.createTask(projectId, baseBranch)
  setTasks(produce(t => t.unshift(result.task)))
  return result
}

/** Create a placeholder task immediately, then set up worktree in the background. */
export function startTaskCreation(projectId: string, baseBranch: string): string {
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
  }

  setTasks(produce(t => t.unshift(placeholder)))
  addCreating(placeholderId)

  // Fire and forget — runs in background
  ipc.createTask(projectId, baseBranch).then(result => {
    // Replace placeholder with real task
    setTasks(prev => prev.map(t => t.id === placeholderId ? result.task : t))
    removeCreating(placeholderId)

    // Set up session
    import('./sessions').then(({ setSessions, setOutputItems }) => {
      import('./ui').then(({ setSelectedSessionId, selectedTaskId }) => {
        setSessions(produce((s: any[]) => s.push(result.session)))
        setOutputItems(result.session.id, [])
        // Only auto-select session if user is still viewing this task
        if (selectedTaskId() === placeholderId) {
          // Update selectedTaskId to the real task ID if it changed
          import('./ui').then(({ setSelectedTaskId }) => {
            setSelectedTaskId(result.task.id)
            setSelectedSessionId(result.session.id)
          })
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
    setTasks(prev => prev.map(t => t.id === placeholderId ? result.task : t))
    removeCreating(placeholderId)

    import('./sessions').then(({ setSessions, setOutputItems }) => {
      import('./ui').then(({ setSelectedSessionId, selectedTaskId, setSelectedTaskId }) => {
        setSessions(produce((s: any[]) => s.push(result.session)))
        setOutputItems(result.session.id, [])
        if (selectedTaskId() === placeholderId) {
          setSelectedTaskId(result.task.id)
          setSelectedSessionId(result.session.id)
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
  closeTerminalsForTask(id)
  clearTaskGitState(id)
  clearProblemsForTask(id)
  fireTaskCleanup(id)
  await ipc.deleteTask(id, deleteBranch, skipDestroyHook)
  setTasks(prev => prev.filter(t => t.id !== id))
}

export async function archiveTask(id: string, skipDestroyHook = false) {
  addArchiving(id)
  try {
    closeTerminalsForTask(id)
    clearTaskGitState(id)
    clearProblemsForTask(id)
    await ipc.archiveTask(id, skipDestroyHook)
    setTasks(t => t.id === id, 'archived', true)
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
