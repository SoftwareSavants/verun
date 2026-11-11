import { createMemo } from 'solid-js'
import { TaskBoard } from './TaskBoard'
import { tasks, taskById, isTaskCreating, isTaskArchiving } from '../store/tasks'
import { projectById } from '../store/projects'
import { taskStatus } from '../store/taskStatus'
import { lastActiveAt } from '../store/lastActive'
import { groupState, projectGroup } from '../store/projectGroups'
import { focusOrSelectTask, setShowTaskBoard, addToast } from '../store/ui'
import * as ipc from '../lib/ipc'

export function TaskBoardPage() {
  // Most recently active first; archived ones by when they were archived.
  const recency = (t: (typeof tasks)[number]) => t.archived ? t.archivedAt ?? t.createdAt : lastActiveAt(t)
  const cards = createMemo(() => [...tasks].sort((a, b) => recency(b) - recency(a)).flatMap(task => {
    const project = projectById(task.projectId)
    if (!project) return []
    return [{
      id: task.id, name: task.name || 'New task', projectId: project.id, projectName: project.name,
      groupId: projectGroup(project.id), branch: task.branch,
      ...taskStatus(task.id),
    }]
  }))
  const open = async (id: string) => {
    const task = taskById(id)
    if (!task) return
    if (isTaskCreating(id) || isTaskArchiving(id)) return
    try {
      if (task.archived) {
        const [exists] = await ipc.checkTaskWorktree(id)
        if (!exists) { addToast('This archived task’s folder is no longer available. Open Archives to manage it.', 'error'); return }
      }
      focusOrSelectTask(task)
    } catch (error) { addToast(String(error), 'error') }
  }
  return <TaskBoard cards={cards()} groups={groupState().groups} initialGroup={groupState().scope} onOpen={id => { void open(id) }} onClose={() => setShowTaskBoard(false)} />
}
