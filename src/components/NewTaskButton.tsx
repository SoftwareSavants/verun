import { SquarePen } from 'lucide-solid'
import { openNewTask } from '../store/newTask'
import { newTaskProjectId, selectedTaskId, showArchived, showSettings, showTaskBoard } from '../store/ui'

/** Starts a task from either sidebar view; the draft's header can move it to another project. */
export function NewTaskButton() {
  const onScreen = () => !!newTaskProjectId() && !selectedTaskId() && !showTaskBoard() && !showSettings() && !showArchived()
  return (
    <button type="button" title="New task (⌘N)" aria-keyshortcuts="Meta+N" aria-current={onScreen() ? 'page' : undefined} onClick={openNewTask}
      class="w-full px-2 py-1.5 flex items-center gap-2 rounded-md text-xs text-text-secondary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
      classList={{ 'bg-surface-3 text-text-primary': onScreen() }}>
      <SquarePen size={14} class="shrink-0" />
      <span class="flex-1 text-left">New task</span>
      <kbd class="text-[10px] font-mono text-text-dim">⌘N</kbd>
    </button>
  )
}
