import { createStore, produce } from 'solid-js/store'
import type { Task, Session } from '../types'
import * as ipc from '../lib/ipc'

export const [tasks, setTasks] = createStore<Task[]>([])

export async function loadTasks(projectId: string) {
  const list = await ipc.listTasks(projectId)
  setTasks(list)
}

export async function createTask(projectId: string): Promise<{ task: Task; session: Session }> {
  const result = await ipc.createTask(projectId)
  setTasks(produce(t => t.push(result.task)))
  return result
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
