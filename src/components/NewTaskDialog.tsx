import { Component, Show, createSignal } from 'solid-js'
import { createTask } from '../store/tasks'
import { startSession } from '../store/sessions'
import { setSelectedTaskId, setSelectedSessionId, addToast } from '../store/ui'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

export const NewTaskDialog: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [result, setResult] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const handleCreate = async () => {
    if (!props.projectId) return
    setLoading(true)
    setError(null)
    try {
      const task = await createTask(props.projectId)
      setResult(task.branch)
      setSelectedTaskId(task.id)

      // Auto-start first session
      const session = await startSession(task.id)
      setSelectedSessionId(session.id)

      addToast(`Created task on branch ${task.branch}`, 'success')
      props.onClose()
      setResult(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose()
    if (e.key === 'Enter') handleCreate()
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
        onKeyDown={handleKeyDown}
      >
        <div class="bg-surface-1 border border-border rounded-lg shadow-xl w-80 p-5">
          <h2 class="text-lg font-semibold text-gray-200 mb-2">New Task</h2>
          <p class="text-sm text-gray-400 mb-4">
            A new worktree will be created with an auto-generated branch name.
            A Claude Code session will start automatically.
          </p>

          <Show when={result()}>
            <div class="text-sm text-gray-300 mb-3">
              Branch: <span class="font-mono text-accent">{result()}</span>
            </div>
          </Show>

          <Show when={error()}>
            <div class="text-xs text-status-error mb-3">{error()}</div>
          </Show>

          <div class="flex justify-end gap-2">
            <button class="btn-ghost" onClick={props.onClose}>Cancel</button>
            <button
              class="btn-primary"
              onClick={handleCreate}
              disabled={loading() || !props.projectId}
            >
              {loading() ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
