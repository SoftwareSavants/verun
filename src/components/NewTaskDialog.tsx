import { Component, Show, createSignal, createEffect } from 'solid-js'
import { startTaskCreation, setTasks } from '../store/tasks'
import { setSessions } from '../store/sessions'
import { setSelectedTaskId, setSelectedProjectId, setSelectedSessionIdForTask, setShowArchived } from '../store/ui'
import { projectById, updateProjectDefaultAgentInStore } from '../store/projects'
import * as ipc from '../lib/ipc'
import { agents } from '../store/agents'
import type { AgentType, TaskWithSession } from '../types'
import { ExternalLink, Copy, Check } from 'lucide-solid'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'
import { AgentPicker } from './AgentPicker'
import { Select } from './Select'
import { CloudSessionPicker } from './CloudSessionPicker'

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
  const [source, setSource] = createSignal<'local' | 'cloud'>('local')
  const [importing, setImporting] = createSignal(false)
  const [cloudAvailability, setCloudAvailability] = createSignal<{ available: boolean; reason: string | null } | null>(null)

  const imported = (result: TaskWithSession) => {
    setTasks(prev => [result.task, ...prev.filter(t => t.id !== result.task.id)])
    setSessions(prev => [result.session, ...prev.filter(s => s.id !== result.session.id)])
    setSelectedTaskId(result.task.id)
    setSelectedProjectId(result.task.projectId)
    setSelectedSessionIdForTask(result.task.id, result.session.id)
    setShowArchived(false)
    setImporting(false)
    props.onClose()
  }

  const project = () => props.projectId ? projectById(props.projectId) : null

  const selectedAgent = () => agents.find(a => a.id === agentType())
  const agentNotInstalled = () => {
    const a = selectedAgent()
    return a ? !a.installed : false
  }

  createEffect(() => {
    if (props.open && props.projectId) {
      setSource('local')
      setImporting(false)
      setCloudAvailability(null)
      ipc.claudeCloudAvailability().then(setCloudAvailability).catch(() => {
        setCloudAvailability({ available: false, reason: 'Unable to check Claude cloud access.' })
      })
      ipc.refreshAgents().catch(() => {})
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
  }

  const handleCreate = () => {
    if (!props.projectId || agentNotInstalled()) return
    if (source() === 'cloud') return
    const p = project()
    if (p) {
      updateProjectDefaultAgentInStore(p.id, agentType())
      ipc.updateProjectDefaultAgent(p.id, agentType()).catch(() => {})
    }
    const placeholderId = startTaskCreation(props.projectId, baseBranch(), agentType())
    setSelectedTaskId(placeholderId)
    setSelectedProjectId(props.projectId)
    setSelectedSessionIdForTask(placeholderId, null)
    setShowArchived(false)
    props.onClose()
  }

  return (
    <>
    <Dialog open={props.open} onClose={() => { if (!importing()) props.onClose() }} onConfirm={source() === 'local' ? handleCreate : undefined} width="30rem">
      <h2 class="text-base font-semibold text-text-primary mb-2">New Task</h2>
      <p class="text-sm text-text-muted mb-4">
        {source() === 'cloud' ? 'Continue a Claude cloud conversation with its code in a new local task.' : 'Creates a new worktree branched from the selected base. An agent session starts automatically.'}
      </p>

      <div class="mb-4">
        <label for="task-source" class="text-xs text-text-dim mb-1.5 block">Start from</label>
        <Select id="task-source" label="Start from" disabled={importing()} value={source()}
          options={[{ value: 'local', label: 'Local' }, { value: 'cloud', label: 'Claude cloud session', disabled: !cloudAvailability()?.available }]}
          onChange={value => {
            setSource(value as 'local' | 'cloud')
            if (value === 'cloud') setAgentType('claude')
          }} />
        <Show when={!cloudAvailability()?.available}>
          <p class="text-xs text-text-dim mt-1.5">{cloudAvailability()?.reason ?? 'Checking Claude cloud access…'}</p>
        </Show>
      </div>
      <Show when={source() === 'local'}>
      <div class="mb-4">
        <label for="base-branch" class="text-xs text-text-dim mb-1.5 block">Base branch</label>
        <Select id="base-branch" label="Base branch" value={baseBranch()} onChange={setBaseBranch}
          options={(branches().length ? branches() : [baseBranch()]).map(branch => ({ value: branch, label: branch }))} />
      </div>
      </Show>

      <Show when={source() === 'local'}>
      <div class="mb-4">
        <label class="text-xs text-text-dim mb-1.5 block">Agent</label>
        <AgentPicker
          value={agentType()}
          onChange={handleAgentChange}
          projectId={props.projectId}
          defaultAgent={project()?.defaultAgentType ?? 'claude'}
        />
        <Show when={agentNotInstalled()}>
          <div class="mt-2 px-3 py-2.5 rounded-lg bg-surface-3 ring-1 ring-outline/6">
            <p class="text-xs text-text-secondary mb-2">
              {selectedAgent()?.name} is not installed. Run this command to install it:
            </p>
            <button
              class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-1 ring-1 ring-outline/8 hover:ring-outline/14 transition-colors group text-left"
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
      </Show>

      <Show when={props.open && source() === 'cloud' && props.projectId}>
        <CloudSessionPicker projectId={props.projectId!} onReady={imported} onBusyChange={setImporting} />
      </Show>
      <Show when={source() === 'local'} fallback={<div class="flex justify-end"><button class="btn-ghost" disabled={importing()} onClick={props.onClose}>Cancel</button></div>}>
      <DialogFooter
        onCancel={props.onClose}
        onConfirm={handleCreate}
        confirmLabel="Create Task"
        disabled={!props.projectId || agentNotInstalled()}
      />
      </Show>
    </Dialog>
    </>
  )
}
