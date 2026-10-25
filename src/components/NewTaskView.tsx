import { Show, createSignal, createEffect, on, onCleanup } from 'solid-js'
import { open } from '@tauri-apps/plugin-dialog'
import { ArrowUp, X, Loader2, Cloud, SquarePen, FolderOpen } from 'lucide-solid'
import { projectById } from '../store/projects'
import { agents } from '../store/agents'
import { startDraftTask } from '../store/draftTask'
import * as ipc from '../lib/ipc'
import { failureText } from '../lib/accountErrors'
import { PROJECT_DEFAULT } from '../lib/accounts'
import type { AccountSelection, AgentType } from '../types'
import { HarnessModelPicker } from './HarnessModelPicker'
import { Select } from './Select'
import { CloudSessionPicker } from './CloudSessionPicker'

export function NewTaskView(props: { projectId: string; onClose: () => void }) {
  const project = () => projectById(props.projectId)
  const [message, setMessage] = createSignal('')
  const [agent, setAgent] = createSignal<AgentType>('claude')
  const [model, setModel] = createSignal<string>()
  const selectedModel = () => model() ?? agents.find(a => a.id === agent())?.models?.[0]?.id
  const [account, setAccount] = createSignal<AccountSelection>(PROJECT_DEFAULT)
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
    setModel(undefined)
    // Accounts belong to a project's harnesses: the previous project's pick is not this one's.
    setAccount(PROJECT_DEFAULT)
    setBaseBranch(p?.baseBranch ?? 'main')
    setBranches([])
    // Each project runs on its own Claude account, so the previous project's cloud access is not this one's.
    setCloud(false)
    setSource('local')
    ipc.refreshAgents().catch(() => {})
    if (p) ipc.getRepoInfo(p.repoPath).then(info => { if (!cancelled) setBranches(info.branches) }).catch(() => {})
    ipc.claudeCloudAvailability(props.projectId).then(result => { if (!cancelled) setCloud(result.available) }).catch(() => {})
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
      await startDraftTask({ projectId: props.projectId, baseBranch: baseBranch(), agentType: agent(), model: selectedModel(), directory: directory(), account: account(), message: message().trim() })
      props.onClose()
    } catch (e) {
      // The account the task would run on can be unusable: that gets the account
      // toast, and the draft says what is wrong instead of printing the raw error.
      setError(failureText(e))
    }
    finally { setSending(false) }
  }

  return <section class="flex flex-col h-full min-h-0 bg-surface-0" aria-label="New task">
    <header class="flex items-center justify-between pt-10 px-5 pb-3 drag-region" data-tauri-drag-region>
      <div class="flex items-center gap-2 text-xs text-text-muted"><span>New task</span><span class="text-text-dim">/</span><span>{project()?.name}</span></div>
      <button class="btn-ghost no-drag" aria-label="Close draft" disabled={sending()} onClick={props.onClose}><X size={14} /></button>
    </header>
    <div class="flex-1 min-h-0 overflow-auto flex flex-col px-6 pt-12 sm:pt-20 pb-12">
      <div class="w-full max-w-160 mx-auto">
        <h1 class="text-2xl font-semibold tracking-tight text-text-primary mb-2">Start a task</h1>
        <p class="text-sm text-text-muted mb-6">{project()?.name ? `What’s next for ${project()!.name}?` : 'What would you like to work on?'}</p>
        <Show when={cloud()}>
          <div role="group" aria-label="Task source" class="flex items-center gap-1 mb-5 border-b-1 border-b-solid border-b-outline/10 pb-2">
            <button aria-pressed={source() === 'local'} disabled={sending()} onClick={() => { setSource('local'); queueMicrotask(() => textarea?.focus()) }}
              class="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent"
              classList={{ 'bg-surface-2 text-text-primary': source() === 'local', 'text-text-muted hover:bg-surface-1': source() !== 'local' }}><SquarePen size={14} />Write a prompt</button>
            <button aria-pressed={source() === 'cloud'} disabled={sending()} onClick={() => setSource('cloud')}
              class="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent"
              classList={{ 'bg-surface-2 text-text-primary': source() === 'cloud', 'text-text-muted hover:bg-surface-1': source() !== 'cloud' }}><Cloud size={14} />Continue from cloud</button>
          </div>
        </Show>
        <Show when={source() === 'local'}>
          <div class="rounded-xl bg-surface-1 ring-1 ring-outline/10 focus-within:ring-accent/40 transition-colors">
            <textarea ref={textarea} aria-label="Task prompt" placeholder="Describe a task…" value={message()} disabled={sending()}
              class="w-full min-h-28 max-h-64 resize-none bg-transparent text-sm text-text-primary p-4 outline-none leading-relaxed"
              onInput={e => setMessage(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() } }} />
            <div class="flex items-center justify-between px-3 pb-3 gap-3">
              <HarnessModelPicker agent={agent()} model={selectedModel()} account={account()} projectId={props.projectId} disabled={sending()}
                onPick={(nextAgent, nextModel, nextAccount) => { setAgent(nextAgent); setModel(nextModel); setAccount(nextAccount ?? PROJECT_DEFAULT) }} />
              <button aria-label="Send" title="Send (Enter)" disabled={!message().trim() || sending() || choosing() || unavailable()} onClick={send}
                class="w-8 h-8 rounded-lg flex items-center justify-center bg-accent text-surface-0 disabled:opacity-35 transition-opacity">
                <Show when={sending()} fallback={<ArrowUp size={16} />}><Loader2 size={16} class="animate-spin" /></Show>
              </button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 mt-3">
            <span class="text-xs text-text-muted">Run in</span><div class="min-w-0"><Select size="compact" label="Run in" value={workspace()} disabled={sending() || choosing()} onChange={chooseWorkspace}
              options={[{ value: 'worktree', label: 'New worktree' }, { value: 'project', label: 'Project folder' }, ...(folder() ? [{ value: 'folder', label: folder()!.path.split('/').pop() || folder()!.path }] : []), { value: 'choose', label: 'Choose folder…' }]} /></div>
            <Show when={workspace() === 'worktree'}><div class="min-w-0"><Select size="compact" label="Base branch" value={baseBranch()} disabled={sending()} onChange={setBaseBranch}
              options={[...new Set([baseBranch(), ...branches()])].map(value => ({ value, label: value }))} /></div></Show>
          </div>
          <div class="flex items-center gap-1.5 text-xs text-text-muted mt-3 min-w-0">
            <Show when={workspace() !== 'worktree'} fallback={<span>Isolated changes on a new branch.</span>}>
              <FolderOpen size={12} class="shrink-0" />
              <span class="truncate" title={directory()}>{workspace() === 'project' ? project()?.name : directory()}</span>
              <span class="shrink-0 text-text-dim">· Shared files</span>
            </Show>
          </div>
          <Show when={unavailable()}><p class="text-xs text-text-muted mt-3">{agents.find(a => a.id === agent())?.name} is not installed. Choose an installed agent.</p></Show>
          <Show when={sending()}><p role="status" class="text-xs text-text-muted mt-3">{workspace() === 'worktree' ? 'Preparing worktree…' : 'Starting task…'}</p></Show>
        </Show>
        <Show when={cloud()}><div style={{ display: source() === 'cloud' ? undefined : 'none' }}>
          <Show when={props.projectId} keyed>{projectId => <CloudSessionPicker projectId={projectId} onStarted={props.onClose} />}</Show>
        </div></Show>
        <Show when={error()}><p role="alert" class="text-sm text-red-400 mt-3">{error()}</p></Show>
      </div>
    </div>
  </section>
}
