import { produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'
import { setProjects } from './projects'
import { requestNewTaskForProject } from './ui'

/** Quick tasks live under one reserved project (see quick_tasks.rs). */
export const QUICK_PROJECT_ID = 'quick-tasks'
export const isQuickProject = (projectId: string | null | undefined) => projectId === QUICK_PROJECT_ID

/** Open the composer for a task in any folder, creating the quick project on first use. */
export async function openQuickTask() {
  const project = await ipc.ensureQuickProject()
  setProjects(produce(list => { if (!list.some(p => p.id === project.id)) list.push(project) }))
  requestNewTaskForProject(project.id)
}

