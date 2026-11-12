import { projectsByRecency } from '../lib/recentTasks'
import { lastActiveAt } from './lastActive'
import { projects } from './projects'
import { tasks } from './tasks'
import { pickAndAddProject, requestNewTaskForProject, selectedProjectId } from './ui'

/** Projects a draft can start in, most recently active first. */
export const draftProjectOptions = () => projectsByRecency(
  projects,
  tasks.filter(t => !t.archived).map(t => ({ projectId: t.projectId, lastActive: lastActiveAt(t) })),
).map(p => ({ value: p.id, label: p.name }))

/**
 * ⌘N and the sidebar's New task: a draft in the project you're looking at,
 * else the most recently active one. The draft can move to another project.
 */
export function openNewTask() {
  const selected = selectedProjectId()
  const projectId = selected && projects.some(p => p.id === selected) ? selected : draftProjectOptions()[0]?.value
  if (projectId) requestNewTaskForProject(projectId)
  else void pickAndAddProject()
}
