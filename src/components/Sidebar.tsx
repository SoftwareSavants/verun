import { Component, For, Show, createSignal, createMemo, createEffect, on } from 'solid-js'
import { projects } from '../store/projects'
import { tasks, tasksForProject, loadTasks, deleteTask } from '../store/tasks'
import {
  selectedProjectId, setSelectedProjectId,
  selectedTaskId, setSelectedTaskId,
  setShowNewTaskDialog, setShowAddProjectDialog,
} from '../store/ui'
import { sessions, sessionsForTask } from '../store/sessions'
import { deleteProject } from '../store/projects'
import { ConfirmDialog } from './ConfirmDialog'
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

interface MenuPos { x: number; y: number }
interface MenuAction { label: string; action: () => void; danger?: boolean }

export const Sidebar: Component = () => {
  const [contextMenu, setContextMenu] = createSignal<{ pos: MenuPos; items: MenuAction[] } | null>(null)
  const [confirmAction, setConfirmAction] = createSignal<{ title: string; message: string; action: () => void } | null>(null)

  // Load tasks for all projects on mount / when projects change
  createEffect(on(() => projects.length, () => {
    for (const p of projects) {
      loadTasks(p.id)
    }
  }))

  const statusCounts = createMemo(() => {
    const counts = { running: 0, done: 0, error: 0, idle: 0 }
    for (const s of sessions) {
      if (s.status in counts) counts[s.status as keyof typeof counts]++
    }
    return counts
  })

  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id)
  }

  const showProjectMenu = (e: MouseEvent, projectId: string) => {
    e.preventDefault()
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'Open in Finder', action: () => ipc.openInFinder(project.repoPath) },
        { label: 'Delete Project', action: () => setConfirmAction({ title: 'Delete Project', message: 'This will delete all tasks, sessions, and worktrees for this project.', action: () => deleteProject(projectId) }), danger: true },
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
        { label: 'Delete Task', action: () => setConfirmAction({ title: 'Delete Task', message: 'This will delete all sessions and the worktree for this task.', action: () => deleteTask(taskId) }), danger: true },
      ],
    })
  }

  const closeMenu = () => setContextMenu(null)

  return (
    <>
      {/* Context menu overlay */}
      <Show when={contextMenu()}>
        <div class="fixed inset-0 z-40" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu() }} />
        <div
          class="fixed z-50 bg-surface-3 border border-border-active rounded-lg shadow-xl py-1 min-w-40 animate-in"
          style={{ left: `${contextMenu()!.pos.x}px`, top: `${contextMenu()!.pos.y}px` }}
        >
          <For each={contextMenu()!.items}>
            {(item) => (
              <button
                class={clsx(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors',
                  item.danger
                    ? 'text-status-error hover:bg-status-error/10'
                    : 'text-text-secondary hover:bg-surface-4 hover:text-text-primary'
                )}
                onClick={() => { item.action(); closeMenu() }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="h-full bg-surface-1 flex flex-col">
        {/* Titlebar drag region */}
        <div class="h-12 shrink-0 drag-region" />

        {/* Header */}
        <div class="px-4 pb-2 flex items-center justify-between no-drag">
          <span class="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Projects</span>
          <button
            class="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => setShowAddProjectDialog(true)}
            title="Add Project"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* Project + task list */}
        <div class="flex-1 overflow-y-auto px-2 no-drag">
          <For each={projects}>
            {(project) => (
              <div class="mb-1">
                <div
                  class={clsx(
                    'w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center justify-between group cursor-pointer',
                    'hover:bg-surface-2',
                    selectedProjectId() === project.id && 'bg-surface-2'
                  )}
                  onClick={() => handleSelectProject(project.id)}
                  onContextMenu={(e) => showProjectMenu(e, project.id)}
                >
                  <span class="text-sm text-text-primary truncate">{project.name}</span>
                  <button
                    class="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary"
                    onClick={(e) => { e.stopPropagation(); setSelectedProjectId(project.id); setShowNewTaskDialog(true) }}
                    title="New Task"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                <Show when={tasksForProject(project.id).length > 0}>
                  <div class="ml-2 mt-0.5">
                    <For each={tasksForProject(project.id)}>
                      {(task) => {
                        const status = () => taskStatus(task.id)
                        return (
                          <button
                            class={clsx(
                              'w-full text-left px-2 py-1 rounded-md transition-colors flex items-center gap-2',
                              'hover:bg-surface-2',
                              selectedTaskId() === task.id && 'bg-surface-2'
                            )}
                            onClick={() => setSelectedTaskId(task.id)}
                            onContextMenu={(e) => showTaskMenu(e, task.id)}
                          >
                            <div class={clsx('w-1.5 h-1.5 rounded-full shrink-0', statusColor[status()])} />
                            <span class="text-xs text-text-secondary truncate">
                              {task.name || 'New task'}
                            </span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>

          {/* Empty state */}
          <Show when={projects.length === 0}>
            <div class="px-2 py-8 text-center">
              <p class="text-sm text-text-muted mb-3">No projects yet</p>
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
        <div class="px-4 py-3 border-t border-border-subtle no-drag">
          <div class="text-[11px] flex gap-3">
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
              <span class="text-text-dim">No active sessions</span>
            </Show>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmAction()}
        title={confirmAction()?.title || ''}
        message={confirmAction()?.message || ''}
        confirmLabel="Delete"
        danger
        onConfirm={() => { confirmAction()?.action(); setConfirmAction(null) }}
        onCancel={() => setConfirmAction(null)}
      />
    </>
  )
}
