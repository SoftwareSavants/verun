import { Component, Show, For, createSignal, createEffect } from 'solid-js'
import { startTaskCreation } from '../store/tasks'
import { setSelectedTaskId, setSelectedProjectId, setSelectedSessionId, setShowArchived } from '../store/ui'
import { projectById } from '../store/projects'
import * as ipc from '../lib/ipc'
import type { AgentType } from '../types'
import { GitBranch } from 'lucide-solid'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'
import { AgentPicker } from './AgentPicker'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

export const NewTaskDialog: Component<Props> = (props) => {
  const [baseBranch, setBaseBranch] = createSignal('main')
  const [branches, setBranches] = createSignal<string[]>([])
  const [agentType, setAgentType] = createSignal<AgentType>('claude')

  createEffect(() => {
    if (props.open && props.projectId) {
      const project = projectById(props.projectId)
      if (project) {
        const defaultBranch = project.baseBranch
        setBaseBranch(defaultBranch)
        setBranches([])
        ipc.getRepoInfo(project.repoPath).then(info => {
          const sorted = [
            ...info.branches.filter(b => b === defaultBranch),
            ...info.branches.filter(b => b !== defaultBranch),
          ]
          setBranches(sorted)
          setBaseBranch(defaultBranch)
        }).catch(() => {})
      }
    }
  })

  const handleCreate = () => {
    if (!props.projectId) return

    const placeholderId = startTaskCreation(props.projectId, baseBranch(), agentType())
    setSelectedTaskId(placeholderId)
    setSelectedProjectId(props.projectId)
    setSelectedSessionId(null)
    setShowArchived(false)
    props.onClose()
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} onConfirm={handleCreate}>
      <h2 class="text-base font-semibold text-text-primary mb-2">New Task</h2>
      <p class="text-sm text-text-muted mb-4">
        Creates a new worktree branched from the selected base. An agent session starts automatically.
      </p>

      <div class="mb-4">
        <label class="text-xs text-text-dim mb-1.5 block">Base branch</label>
        <div class="relative">
          <GitBranch size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
          <select
            class="input-base pl-8 pr-3 appearance-none cursor-pointer"
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

      <div class="mb-4">
        <AgentPicker value={agentType()} onChange={setAgentType} />
      </div>

      <DialogFooter
        onCancel={props.onClose}
        onConfirm={handleCreate}
        confirmLabel="Create Task"
        disabled={!props.projectId}
      />
    </Dialog>
  )
}
