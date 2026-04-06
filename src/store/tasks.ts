import { createStore, produce } from 'solid-js/store'
import type { Task, Session } from '../types'
import * as ipc from '../lib/ipc'

export const [tasks, setTasks] = createStore<Task[]>([])

export async function loadTasks(projectId: string) {
  const list = await ipc.listTasks(projectId)
  // Replace tasks for this project, keep tasks from other projects
  setTasks(prev => [...prev.filter(t => t.projectId !== projectId), ...list])
}

export const tasksForProject = (projectId: string) =>
  tasks.filter(t => t.projectId === projectId)

export async function createTask(projectId: string): Promise<{ task: Task; session: Session }> {
  const result = await ipc.createTask(projectId)
  setTasks(produce(t => t.push(result.task)))
  return result
}

/** Create a task and select it + its first session immediately. No dialog needed. */
export async function quickCreateTask(projectId: string) {
  const { setSessions, setOutputItems } = await import('./sessions')
  const { setSelectedTaskId, setSelectedSessionId, addToast } = await import('./ui')
  const { produce } = await import('solid-js/store')
  try {
    const { task, session } = await createTask(projectId)
    setSelectedTaskId(task.id)
    setSessions(produce((s: any[]) => s.push(session)))
    setOutputItems(session.id, [])
    setSelectedSessionId(session.id)
  } catch (e) {
    addToast(String(e), 'error')
  }
}

export async function deleteTask(id: string) {
  await ipc.deleteTask(id)
  setTasks(prev => prev.filter(t => t.id !== id))
}

export async function updateTaskName(id: string, name: string) {
  setTasks(t => t.id === id, 'name', name)
}

export const taskById = (id: string) =>
  tasks.find(t => t.id === id)
