import { createMemo } from 'solid-js'
import { TaskBoard } from './TaskBoard'
import { taskBoardState } from '../lib/taskBoard'
import { tasks, taskById, isTaskCreating, isTaskArchiving, getTaskError } from '../store/tasks'
import { projectById } from '../store/projects'
import { sessions, pendingApprovals } from '../store/sessions'
import { taskGit } from '../store/git'
import { groupState, projectGroup } from '../store/projectGroups'
import { focusOrSelectTask, setShowTaskBoard, addToast } from '../store/ui'
import * as ipc from '../lib/ipc'

export function TaskBoardPage() {
  const activity = createMemo(() => {
    const result = new Map<string, { running: boolean; error: boolean; approval: boolean }>()
    for (const session of sessions) {
      if (session.closedAt) continue
      const state = result.get(session.taskId) ?? { running: false, error: false, approval: false }
      state.running ||= session.status === 'running'
      state.error ||= session.status === 'error'
      state.approval ||= (pendingApprovals[session.id]?.length ?? 0) > 0
      result.set(session.taskId, state)
    }
    return result
  })
  const cards = createMemo(() => [...tasks].sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt)).flatMap(task => {
    const project = projectById(task.projectId)
    if (!project) return []
    const git = taskGit(task.id)
    const state = activity().get(task.id)
    return [{
      id: task.id, name: task.name || 'New task', projectId: project.id, projectName: project.name,
      groupId: projectGroup(project.id), branch: task.branch,
      ...taskBoardState({
        ...state, archived: task.archived, error: !!getTaskError(task.id) || state?.error,
        creating: isTaskCreating(task.id), archiving: isTaskArchiving(task.id),
        conflicts: git.pr?.mergeable === 'CONFLICTING',
        failedChecks: git.pr?.state === 'OPEN' && git.checks.some(c => c.status === 'FAILURE' || c.status === 'ERROR'),
        merged: git.pr?.state === 'MERGED', prOpen: git.pr?.state === 'OPEN',
      }),
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
