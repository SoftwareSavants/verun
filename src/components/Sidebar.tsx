import { Component, For, Show, createMemo } from 'solid-js'
import { projects } from '../store/projects'
import { tasks, loadTasks, createTask } from '../store/tasks'
import { selectedProjectId, setSelectedProjectId, selectedTaskId, setSelectedTaskId } from '../store/ui'
import { sessions, sessionsForTask } from '../store/sessions'
import { Plus } from 'lucide-solid'
import { clsx } from 'clsx'
import type { SessionStatus } from '../types'

const statusColor: Record<SessionStatus, string> = {
  running: 'bg-status-running',
  idle: 'bg-status-idle',
  done: 'bg-status-done',
  error: 'bg-status-error',
}

/** Derive task status from its latest session */
function taskStatus(taskId: string): SessionStatus {
  const taskSessions = sessionsForTask(taskId)
  if (taskSessions.length === 0) return 'idle'
  // If any session is running, the task is active
  const running = taskSessions.find(s => s.status === 'running')
  if (running) return 'running'
  // Otherwise use the most recent session's status
  return taskSessions[0].status as SessionStatus
}

export const Sidebar: Component = () => {
  const runningSessions = createMemo(() =>
    sessions.filter(s => s.status === 'running').length
  )

  const handleSelectProject = async (id: string) => {
    setSelectedProjectId(id)
    setSelectedTaskId(null)
    await loadTasks(id)
  }

  const handleCreateTask = async (projectId: string) => {
    const task = await createTask(projectId)
    setSelectedTaskId(task.id)
  }

  return (
    <div class="w-60 h-full bg-surface-1 border-r border-border flex flex-col">
      <div class="p-3 border-b border-border flex items-center justify-between">
        <span class="text-sm font-semibold text-gray-300">Projects</span>
      </div>

      <div class="flex-1 overflow-y-auto">
        <For each={projects}>
          {(project) => (
            <div>
              {/* Project header */}
              <button
                class={clsx(
                  'w-full text-left px-3 py-2 border-b border-border transition-colors flex items-center justify-between',
                  'hover:bg-surface-2',
                  selectedProjectId() === project.id && 'bg-surface-2'
                )}
                onClick={() => handleSelectProject(project.id)}
              >
                <span class="text-sm text-gray-200 truncate">{project.name}</span>
                <button
                  class="btn-ghost p-0.5 rounded"
                  onClick={(e) => { e.stopPropagation(); handleCreateTask(project.id) }}
                  title="New Task"
                >
                  <Plus size={14} />
                </button>
              </button>

              {/* Tasks under selected project */}
              <Show when={selectedProjectId() === project.id}>
                <For each={tasks}>
                  {(task) => {
                    const status = () => taskStatus(task.id)
                    return (
                      <button
                        class={clsx(
                          'w-full text-left pl-6 pr-3 py-1.5 border-b border-border transition-colors',
                          'hover:bg-surface-2',
                          selectedTaskId() === task.id && 'bg-surface-2'
                        )}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <div class="flex items-center gap-2">
                          <div class={clsx('w-2 h-2 rounded-full', statusColor[status()])} />
                          <span class="text-xs text-gray-300 truncate">
                            {task.name || task.branch}
                          </span>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="p-3 border-t border-border">
        <div class="text-xs text-gray-500">
          {runningSessions()} running
        </div>
      </div>
    </div>
  )
}
