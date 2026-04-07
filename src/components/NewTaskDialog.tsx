import { Component, Show, For, createSignal, createEffect } from 'solid-js'
import { createTask } from '../store/tasks'
import { setSessions, setOutputItems } from '../store/sessions'
import { produce } from 'solid-js/store'
import { setSelectedTaskId, setSelectedProjectId, setSelectedSessionId, addToast } from '../store/ui'
import { projectById } from '../store/projects'
import * as ipc from '../lib/ipc'
import { GitBranch } from 'lucide-solid'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

export const NewTaskDialog: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [baseBranch, setBaseBranch] = createSignal('main')
  const [branches, setBranches] = createSignal<string[]>([])

  createEffect(() => {
    if (props.open && props.projectId) {
      const project = projectById(props.projectId)
      if (project) {
        const defaultBranch = project.baseBranch
        setBaseBranch(defaultBranch)
        setBranches([])
        ipc.getRepoInfo(project.repoPath).then(info => {
          // Put the default base branch first so the <select> doesn't reset to a random branch
          const sorted = [
            ...info.branches.filter(b => b === defaultBranch),
            ...info.branches.filter(b => b !== defaultBranch),
          ]
          setBranches(sorted)
          // Re-assert after DOM update so Solid picks it up
          setBaseBranch(defaultBranch)
        }).catch(() => {})
      }
    }
  })

  const handleCreate = async () => {
    if (!props.projectId) return
    setLoading(true)
    setError(null)
    try {
      const { task, session } = await createTask(props.projectId, baseBranch())
      setSelectedTaskId(task.id)
      setSelectedProjectId(props.projectId!)

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
    if (e.key === 'Enter' && !loading()) handleCreate()
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
            Creates a new worktree branched from the selected base. A Claude session starts automatically.
          </p>

          <div class="mb-4">
            <label class="text-xs text-text-dim mb-1.5 block">Base branch</label>
            <div class="relative">
              <GitBranch size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
              <select
                class="w-full bg-surface-1 border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-text-primary outline-none focus:border-border-active transition-colors appearance-none cursor-pointer"
                style={{ outline: 'none' }}
                value={baseBranch()}
                onChange={(e) => setBaseBranch(e.currentTarget.value)}
              >
                <Show when={branches().length > 0} fallback={
                  <option value={baseBranch()}>{baseBranch()}</option>
                }>
                  <For each={branches()}>
                    {(branch) => <option value={branch}>{branch}</option>}
                  </For>
                </Show>
              </select>
            </div>
          </div>

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
