import { Component, Show, For, createSignal, createEffect } from 'solid-js'
import { startTaskCreation } from '../store/tasks'
import { setSelectedTaskId, setSelectedProjectId, setSelectedSessionId, setShowArchived } from '../store/ui'
import { projectById, updateProjectDefaultAgentInStore } from '../store/projects'
import * as ipc from '../lib/ipc'
import { agents } from '../store/agents'
import type { AgentType } from '../types'
import { GitBranch, ExternalLink, Copy, Check } from 'lucide-solid'
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
  const [copied, setCopied] = createSignal(false)

  const project = () => props.projectId ? projectById(props.projectId) : null

  const selectedAgent = () => agents.find(a => a.id === agentType())
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

  const copyInstallHint = () => {
    const hint = selectedAgent()?.installHint
    if (!hint) return
    navigator.clipboard.writeText(hint).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const handleAgentChange = (agent: AgentType) => {
    setCopied(false)
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
    <Dialog open={props.open} onClose={props.onClose} onConfirm={handleCreate} width="26rem">
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
          <div class="mt-2 px-3 py-2.5 rounded-lg bg-surface-3 ring-1 ring-white/6">
            <p class="text-xs text-text-secondary mb-2">
              {selectedAgent()?.name} is not installed. Run this command to install it:
            </p>
            <button
              class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-1 ring-1 ring-white/8 hover:ring-white/14 transition-colors group text-left"
              onClick={copyInstallHint}
              title="Click to copy"
            >
              <code class="flex-1 text-[11px] text-text-secondary font-mono truncate">{selectedAgent()?.installHint}</code>
              <span class="shrink-0 text-text-dim group-hover:text-text-secondary transition-colors">
                <Show when={copied()} fallback={<Copy size={11} />}>
                  <Check size={11} class="text-green-400" />
                </Show>
              </span>
            </button>
            <Show when={selectedAgent()?.docsUrl}>
              <a
                href={selectedAgent()!.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 mt-2 text-[11px] text-text-primary hover:text-white transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={10} />
                View install docs
              </a>
            </Show>
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
