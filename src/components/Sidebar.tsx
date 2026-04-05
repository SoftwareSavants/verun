import { Component, For, Show, createSignal, createMemo } from 'solid-js'
import { projects } from '../store/projects'
import { tasks, loadTasks, deleteTask } from '../store/tasks'
import {
  selectedProjectId, setSelectedProjectId,
  selectedTaskId, setSelectedTaskId,
  setShowNewTaskDialog, setShowAddProjectDialog,
} from '../store/ui'
import { sessions, sessionsForTask } from '../store/sessions'
import { deleteProject } from '../store/projects'
import { Plus, FolderPlus } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'
import type { SessionStatus } from '../types'

const statusColor: Record<SessionStatus, string> = {
  running: 'bg-status-running',
  idle: 'bg-status-idle',
  done: 'bg-status-done',
  error: 'bg-status-error',
}

function taskStatus(taskId: string): SessionStatus {
  const taskSessions = sessionsForTask(taskId)
  if (taskSessions.length === 0) return 'idle'
  const running = taskSessions.find(s => s.status === 'running')
  if (running) return 'running'
  return taskSessions[0].status as SessionStatus
}

// Context menu
interface MenuPos { x: number; y: number }
interface MenuAction { label: string; action: () => void; danger?: boolean }

export const Sidebar: Component = () => {
  const [contextMenu, setContextMenu] = createSignal<{ pos: MenuPos; items: MenuAction[] } | null>(null)

  const statusCounts = createMemo(() => {
    const counts = { running: 0, done: 0, error: 0, idle: 0 }
    for (const s of sessions) {
      if (s.status in counts) counts[s.status as keyof typeof counts]++
    }
    return counts
  })

  const handleSelectProject = async (id: string) => {
    setSelectedProjectId(id)
    setSelectedTaskId(null)
    await loadTasks(id)
  }

  const showProjectMenu = (e: MouseEvent, projectId: string) => {
    e.preventDefault()
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Open in Finder', action: () => ipc.openInFinder(project.repoPath) },
        { label: 'Delete Project', action: () => deleteProject(projectId), danger: true },
      ],
    })
  }

  const showTaskMenu = (e: MouseEvent, taskId: string) => {
    e.preventDefault()
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Open in Finder', action: () => ipc.openInFinder(task.worktreePath) },
        { label: 'Delete Task', action: () => deleteTask(taskId), danger: true },
      ],
    })
  }

  const closeMenu = () => setContextMenu(null)

  return (
    <>
      {/* Click-away to close context menu */}
      <Show when={contextMenu()}>
        <div class="fixed inset-0 z-40" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu() }} />
        <div
          class="fixed z-50 bg-surface-2 border border-border rounded-md shadow-lg py-1 min-w-36"
          style={{ left: `${contextMenu()!.pos.x}px`, top: `${contextMenu()!.pos.y}px` }}
        >
          <For each={contextMenu()!.items}>
            {(item) => (
              <button
                class={clsx(
                  'w-full text-left px-3 py-1.5 text-xs hover:bg-surface-3 transition-colors',
                  item.danger ? 'text-status-error' : 'text-gray-300'
                )}
                onClick={() => { item.action(); closeMenu() }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="w-60 h-full bg-surface-1 border-r border-border flex flex-col">
        {/* Header */}
        <div class="p-3 border-b border-border flex items-center justify-between">
          <span class="text-sm font-semibold text-gray-300">Projects</span>
          <button
            class="btn-ghost p-1 rounded"
            onClick={() => setShowAddProjectDialog(true)}
            title="Add Project"
          >
            <FolderPlus size={16} />
          </button>
        </div>

        {/* Project + task list */}
        <div class="flex-1 overflow-y-auto">
          <For each={projects}>
            {(project) => (
              <div>
                <button
                  class={clsx(
                    'w-full text-left px-3 py-2 border-b border-border transition-colors flex items-center justify-between group',
                    'hover:bg-surface-2',
                    selectedProjectId() === project.id && 'bg-surface-2'
                  )}
                  onClick={() => handleSelectProject(project.id)}
                  onContextMenu={(e) => showProjectMenu(e, project.id)}
                >
                  <span class="text-sm text-gray-200 truncate">{project.name}</span>
                  <button
                    class="btn-ghost p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); setSelectedProjectId(project.id); setShowNewTaskDialog(true) }}
                    title="New Task"
                  >
                    <Plus size={14} />
                  </button>
                </button>

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
                          onContextMenu={(e) => showTaskMenu(e, task.id)}
                        >
                          <div class="flex items-center gap-2">
                            <div class={clsx('w-2 h-2 rounded-full shrink-0', statusColor[status()])} />
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

          {/* Empty state */}
          <Show when={projects.length === 0}>
            <div class="p-4 text-center">
              <p class="text-sm text-gray-500 mb-3">No projects yet</p>
              <button
                class="btn-primary text-xs"
                onClick={() => setShowAddProjectDialog(true)}
              >
                Add a repo
              </button>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div class="p-3 border-t border-border">
          <div class="text-xs text-gray-500 flex gap-3">
            <Show when={statusCounts().running > 0}>
              <span class="text-status-running">{statusCounts().running} running</span>
            </Show>
            <Show when={statusCounts().done > 0}>
              <span class="text-status-done">{statusCounts().done} done</span>
            </Show>
            <Show when={statusCounts().error > 0}>
              <span class="text-status-error">{statusCounts().error} error</span>
            </Show>
            <Show when={statusCounts().running === 0 && statusCounts().done === 0 && statusCounts().error === 0}>
              <span>No active sessions</span>
            </Show>
          </div>
        </div>
      </div>
    </>
  )
}
