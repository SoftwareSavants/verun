import { Component, Show, createSignal } from 'solid-js'
import { createTask } from '../store/tasks'
import { setSessions, setOutputItems } from '../store/sessions'
import { produce } from 'solid-js/store'
import { setSelectedTaskId, setSelectedSessionId, addToast } from '../store/ui'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

export const NewTaskDialog: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const handleCreate = async () => {
    if (!props.projectId) return
    setLoading(true)
    setError(null)
    try {
      const { task, session } = await createTask(props.projectId)
      setSelectedTaskId(task.id)

      setSessions(produce(s => s.push(session)))
      setOutputItems(session.id, [])
      setSelectedSessionId(session.id)

      addToast(`Created task on branch ${task.branch}`, 'success')
      props.onClose()
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
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
        onKeyDown={handleKeyDown}
      >
        <div class="bg-surface-2 border border-border rounded-xl shadow-2xl w-80 p-5 animate-in">
          <h2 class="text-base font-semibold text-text-primary mb-2">New Task</h2>
          <p class="text-sm text-text-muted mb-4">
            Creates a new worktree with an auto-generated branch. A Claude session starts automatically.
          </p>

          <Show when={error()}>
            <div class="text-xs text-status-error mb-3 bg-status-error/5 border border-status-error/10 rounded-lg px-3 py-2">{error()}</div>
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
