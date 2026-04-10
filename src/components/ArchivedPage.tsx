import { Component, For, Show, createSignal, createMemo } from 'solid-js'
import { createColumnHelper, createSolidTable, getCoreRowModel, flexRender } from '@tanstack/solid-table'
import { projects } from '../store/projects'
import { archivedTasksForProject, restoreTask } from '../store/tasks'
import { setSelectedTaskId, setSelectedProjectId, setShowArchived, addToast } from '../store/ui'
import { projectById } from '../store/projects'
import { ConfirmDialog } from './ConfirmDialog'
import { Archive, RotateCcw } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'
import type { Task } from '../types'

function formatDateGroup(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const taskDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diff = today.getTime() - taskDay.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

const columnHelper = createColumnHelper<Task>()

export const ArchivedPage: Component = () => {
  const allArchived = createMemo(() =>
    projects.flatMap(p => archivedTasksForProject(p.id))
      .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt))
  )

  const [missingDialog, setMissingDialog] = createSignal<{ worktree: boolean; branch: boolean } | null>(null)
  const [restoringIds, setRestoringIds] = createSignal<Set<string>>(new Set())

  const handleClick = async (taskId: string, projectId: string) => {
    const [worktreeExists, branchExists] = await ipc.checkTaskWorktree(taskId)
    if (!worktreeExists || !branchExists) {
      setMissingDialog({ worktree: !worktreeExists, branch: !branchExists })
      return
    }
    setSelectedTaskId(taskId)
    setSelectedProjectId(projectId)
    setShowArchived(false)
  }

  const handleRestore = async (e: MouseEvent, taskId: string) => {
    e.stopPropagation()
    setRestoringIds(prev => new Set([...prev, taskId]))
    try {
      const [worktreeExists, branchExists] = await ipc.checkTaskWorktree(taskId)
      if (!worktreeExists || !branchExists) {
        setMissingDialog({ worktree: !worktreeExists, branch: !branchExists })
        return
      }
      await restoreTask(taskId)
      addToast('Task restored', 'success')
    } finally {
      setRestoringIds(prev => { const s = new Set(prev); s.delete(taskId); return s })
    }
  }

  const columns = [
    columnHelper.accessor('name', {
      header: 'Task',
      cell: info => (
        <span class="text-sm text-text-secondary truncate block max-w-52">
          {info.getValue() || 'Unnamed task'}
        </span>
      ),
    }),
    columnHelper.accessor('projectId', {
      header: 'Project',
      cell: info => (
        <span class="text-xs text-text-dim">{projectById(info.getValue())?.name}</span>
      ),
    }),
    columnHelper.accessor('lastCommitMessage', {
      header: 'Last commit',
      cell: info => (
        <span class="text-xs text-text-dim truncate block max-w-64">
          {info.getValue() || '—'}
        </span>
      ),
    }),
    columnHelper.accessor('branch', {
      header: 'Branch',
      cell: info => (
        <span class="text-[11px] text-text-dim font-mono truncate block max-w-44">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor(row => formatDateGroup(row.archivedAt ?? row.createdAt), {
      id: 'archivedDate',
      header: 'Archived',
      cell: info => (
        <span class="text-xs text-text-dim">{info.getValue()}</span>
      ),
    }),
    columnHelper.display({
      id: 'actions',
      header: '',
      cell: info => (
        <button
          class="opacity-0 group-hover/row:opacity-100 px-2 py-1 text-[10px] font-medium rounded bg-accent/10 text-accent hover:bg-accent/20 transition-all inline-flex items-center gap-1"
          onClick={(e) => handleRestore(e as MouseEvent, info.row.original.id)}
          title="Restore task"
        >
          <RotateCcw size={10} />
          Restore
        </button>
      ),
      size: 80,
    }),
  ]

  const table = createSolidTable({
    get data() { return allArchived() },
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div class="flex-1 h-full overflow-y-auto bg-surface-0">
      <div class="max-w-5xl mx-auto px-8 py-10">
        <h1 class="text-lg font-semibold text-text-primary mb-1">Archived Tasks</h1>
        <p class="text-sm text-text-muted mb-6">Tasks that have been archived. Click to view, or restore to make active again.</p>

        <Show when={allArchived().length === 0}>
          <div class="text-center py-16">
            <Archive size={32} class="text-text-dim mx-auto mb-4" />
            <p class="text-sm text-text-dim">No archived tasks yet</p>
          </div>
        </Show>

        <Show when={allArchived().length > 0}>
          <div class="rounded-lg border border-border-subtle overflow-hidden">
            <table class="w-full border-collapse">
              <thead>
                <For each={table.getHeaderGroups()}>
                  {headerGroup => (
                    <tr class="bg-surface-1">
                      <For each={headerGroup.headers}>
                        {header => (
                          <th
                            class="text-left text-[10px] font-medium text-text-dim uppercase tracking-wider px-3 py-2.5 border-b border-border-subtle"
                            style={{ width: header.getSize() !== 150 ? `${header.getSize()}px` : undefined }}
                          >
                            {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                          </th>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </thead>
              <tbody>
                <For each={table.getRowModel().rows}>
                  {row => {
                    const restoring = () => restoringIds().has(row.original.id)
                    return (
                      <tr
                        class={clsx(
                          "group/row cursor-pointer transition-colors hover:bg-surface-2 border-b border-border-subtle last:border-b-0",
                          restoring() && "opacity-50 pointer-events-none",
                        )}
                        onClick={() => handleClick(row.original.id, row.original.projectId)}
                      >
                        <For each={row.getVisibleCells()}>
                          {cell => (
                            <td class="px-3 py-2.5">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          )}
                        </For>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>

      <ConfirmDialog
        open={!!missingDialog()}
        title="Task Unavailable"
        message={
          missingDialog()?.worktree && missingDialog()?.branch
            ? "The worktree and branch for this task no longer exist."
            : missingDialog()?.worktree
              ? "The worktree for this task no longer exists on disk."
              : "The branch for this task no longer exists in the repository."
        }
        confirmLabel="OK"
        onConfirm={() => setMissingDialog(null)}
        onCancel={() => setMissingDialog(null)}
      />
    </div>
  )
}
