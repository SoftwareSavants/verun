import { Show, createSignal, createEffect, on, onCleanup } from 'solid-js'
import { open } from '@tauri-apps/plugin-dialog'
import { ArrowUp, X, Loader2 } from 'lucide-solid'
import { projectById } from '../store/projects'
import { agents } from '../store/agents'
import { startDraftTask } from '../store/draftTask'
import * as ipc from '../lib/ipc'
import type { AgentType } from '../types'
import { AgentPicker } from './AgentPicker'
import { Select } from './Select'
import { CloudSessionPicker } from './CloudSessionPicker'

export function NewTaskView(props: { projectId: string; onClose: () => void }) {
  const project = () => projectById(props.projectId)
  const [message, setMessage] = createSignal('')
  const [agent, setAgent] = createSignal<AgentType>('claude')
  const [baseBranch, setBaseBranch] = createSignal('main')
  const [branches, setBranches] = createSignal<string[]>([])
  const [workspace, setWorkspace] = createSignal('worktree')
  const [folder, setFolder] = createSignal<ipc.DirectoryInfo | null>(null)
  const [source, setSource] = createSignal('local')
  const [cloud, setCloud] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [choosing, setChoosing] = createSignal(false)
  const [error, setError] = createSignal('')
  const directory = () => workspace() === 'project' ? project()?.repoPath : workspace() === 'folder' ? folder()?.path : undefined
  const unavailable = () => agents.find(a => a.id === agent())?.installed === false
  let textarea!: HTMLTextAreaElement

  createEffect(on(() => [props.projectId, project()?.id], () => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    const p = project()
    setAgent(p?.defaultAgentType ?? 'claude')
    setBaseBranch(p?.baseBranch ?? 'main')
    setBranches([])
    ipc.refreshAgents().catch(() => {})
    if (p) ipc.getRepoInfo(p.repoPath).then(info => { if (!cancelled) setBranches(info.branches) }).catch(() => {})
    ipc.claudeCloudAvailability().then(result => { if (!cancelled) setCloud(result.available) }).catch(() => {})
    queueMicrotask(() => textarea?.focus())
  }))

  const chooseWorkspace = async (value: string) => {
    if (value !== 'choose') { setWorkspace(value); return }
    setChoosing(true)
    setError('')
    try {
      const path = await open({ directory: true, multiple: false, title: 'Choose task folder' })
      if (typeof path === 'string') {
        setFolder(await ipc.inspectTaskDirectory(path))
        setWorkspace('folder')
      }
    } catch (e) { setError(String(e)) }
    finally { setChoosing(false) }
  }
  const send = async () => {
    if (!message().trim() || sending() || choosing() || unavailable()) return
    setSending(true)
    setError('')
    try {
      await startDraftTask({ projectId: props.projectId, baseBranch: baseBranch(), agentType: agent(), directory: directory(), message: message().trim() })
      props.onClose()
    } catch (e) { setError(String(e)) }
    finally { setSending(false) }
  }

  return <section class="flex flex-col h-full min-h-0 bg-surface-0" aria-label="New task">
    <header class="flex items-center justify-between pt-10 px-5 pb-3 drag-region" data-tauri-drag-region>
      <div class="flex items-center gap-2 text-xs text-text-muted"><span>New task</span><span class="text-text-dim">/</span><span>{project()?.name}</span></div>
      <button class="btn-ghost no-drag" aria-label="Close draft" disabled={sending()} onClick={props.onClose}><X size={14} /></button>
    </header>
    <div class="flex-1 min-h-0 overflow-auto flex flex-col justify-center px-6 pb-16">
      <div class="w-full max-w-180 mx-auto">
        <h1 class="text-2xl font-semibold text-text-primary mb-6">What would you like to work on?</h1>
        <Show when={source() === 'local'}>
          <div class="rounded-xl bg-surface-1 ring-1 ring-outline/10 focus-within:ring-accent/40 transition-colors">
            <textarea ref={textarea} aria-label="Task prompt" placeholder="Describe a task…" value={message()} disabled={sending()}
              class="w-full min-h-32 resize-y bg-transparent text-sm text-text-primary p-4 outline-none leading-relaxed"
              onInput={e => setMessage(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() } }} />
            <div class="flex items-center justify-between px-3 pb-3 gap-3">
              <AgentPicker value={agent()} onChange={value => { if (!sending()) setAgent(value) }} projectId={props.projectId} defaultAgent={project()?.defaultAgentType} />
              <button aria-label="Send" title="Send (Enter)" disabled={!message().trim() || sending() || choosing() || unavailable()} onClick={send}
                class="w-8 h-8 rounded-lg flex items-center justify-center bg-accent text-surface-0 disabled:opacity-35 transition-opacity">
                <Show when={sending()} fallback={<ArrowUp size={16} />}><Loader2 size={16} class="animate-spin" /></Show>
              </button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 mt-3">
            <div class="min-w-40"><Select label="Run in" value={workspace()} disabled={sending() || choosing()} onChange={chooseWorkspace}
              options={[{ value: 'worktree', label: 'New worktree' }, { value: 'project', label: 'Project folder' }, ...(folder() ? [{ value: 'folder', label: folder()!.path.split('/').pop() || folder()!.path }] : []), { value: 'choose', label: 'Choose folder…' }]} /></div>
            <Show when={workspace() === 'worktree'}><div class="min-w-32"><Select label="Base branch" value={baseBranch()} disabled={sending()} onChange={setBaseBranch}
              options={[...new Set([baseBranch(), ...branches()])].map(value => ({ value, label: value }))} /></div></Show>
            <Show when={cloud()}><button class="btn-ghost text-xs" disabled={sending()} onClick={() => setSource('cloud')}>Continue from cloud</button></Show>
          </div>
          <p class="text-xs text-text-dim mt-2 break-all">{workspace() === 'worktree' ? `An isolated worktree will be created from ${baseBranch()}.` : directory()}</p>
          <Show when={workspace() !== 'worktree'}><p class="text-xs text-text-dim mt-1">Works directly in this folder. Changes are shared with other tasks using it.</p></Show>
          <Show when={unavailable()}><p class="text-xs text-text-muted mt-3">{agents.find(a => a.id === agent())?.name} is not installed. Choose an installed agent.</p></Show>
          <Show when={sending()}><p role="status" class="text-xs text-text-muted mt-3">{workspace() === 'worktree' ? 'Preparing worktree…' : 'Starting task…'}</p></Show>
        </Show>
        <Show when={cloud()}><div style={{ display: source() === 'cloud' ? undefined : 'none' }}>
          <button class="btn-ghost text-xs mb-3" onClick={() => setSource('local')}>Back to new task</button>
          <Show when={props.projectId} keyed>{projectId => <CloudSessionPicker projectId={projectId} onStarted={props.onClose} />}</Show>
        </div></Show>
        <Show when={error()}><p role="alert" class="text-sm text-red-400 mt-3">{error()}</p></Show>
      </div>
    </div>
  </section>
}
