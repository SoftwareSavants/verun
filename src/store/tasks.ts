import { createStore, produce } from 'solid-js/store'
import type { Task } from '../types'
import * as ipc from '../lib/ipc'

export const [tasks, setTasks] = createStore<Task[]>([])

export async function loadTasks(projectId: string) {
  const list = await ipc.listTasks(projectId)
  setTasks(list)
}

export async function createTask(projectId: string): Promise<Task> {
  const task = await ipc.createTask(projectId)
  setTasks(produce(t => t.push(task)))
  return task
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
