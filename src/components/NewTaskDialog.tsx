import { Component, Show, For, createSignal, createEffect, createResource } from 'solid-js'
import { startTaskCreation } from '../store/tasks'
import { setSelectedTaskId, setSelectedProjectId, setSelectedSessionId, setShowArchived } from '../store/ui'
import { projectById, updateProjectDefaultAgentInStore } from '../store/projects'
import * as ipc from '../lib/ipc'
import type { AgentType } from '../types'
import { GitBranch, Terminal, ExternalLink } from 'lucide-solid'
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

  const [agents] = createResource(ipc.listAvailableAgents, { initialValue: [] })

  const project = () => props.projectId ? projectById(props.projectId) : null

  const selectedAgent = () => agents().find(a => a.id === agentType())
  const agentNotInstalled = () => {
    const a = selectedAgent()
    return a ? !a.installed : false
  }

  createEffect(() => {
    if (props.open && props.projectId) {
      const p = project()
      if (p) {
        setAgentType(p.defaultAgentType ?? 'claude')
        const defaultBranch = p.baseBranch
        setBaseBranch(defaultBranch)
        setBranches([])
        ipc.getRepoInfo(p.repoPath).then(info => {
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

  const handleAgentChange = (agent: AgentType) => {
    setAgentType(agent)
    const p = project()
    if (p) {
      updateProjectDefaultAgentInStore(p.id, agent)
      ipc.updateProjectDefaultAgent(p.id, agent).catch(() => {})
    }
  }

  const handleCreate = () => {
    if (!props.projectId || agentNotInstalled()) return
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
        <label class="text-xs text-text-dim mb-1.5 block">Agent</label>
        <AgentPicker
          value={agentType()}
          onChange={handleAgentChange}
          projectId={props.projectId}
          defaultAgent={project()?.defaultAgentType ?? 'claude'}
        />
        <Show when={agentNotInstalled()}>
          <div class="mt-2 px-3 py-2.5 rounded-lg bg-amber-500/8 ring-1 ring-amber-500/20 flex items-start gap-2.5">
            <Terminal size={13} class="text-amber-400 shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <p class="text-xs text-amber-300/90 leading-relaxed">
                {selectedAgent()?.name} is not installed. Install it to create a task.
              </p>
              <div class="flex items-center gap-1.5 mt-1.5">
                <code class="text-[11px] text-amber-200/70 font-mono">{selectedAgent()?.installHint}</code>
              </div>
              <Show when={selectedAgent()?.docsUrl}>
                <a
                  href={selectedAgent()!.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 mt-1.5 text-[11px] text-amber-400 hover:text-amber-300 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={10} />
                  View install docs
                </a>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <DialogFooter
        onCancel={props.onClose}
        onConfirm={handleCreate}
        confirmLabel="Create Task"
        disabled={!props.projectId || agentNotInstalled()}
      />
    </Dialog>
  )
}
