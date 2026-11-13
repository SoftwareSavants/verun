import { Show, createSignal, createEffect, on, onCleanup } from 'solid-js'
import { open } from '@tauri-apps/plugin-dialog'
import { ArrowUp, X, Loader2, Cloud, SquarePen, FolderOpen, GitBranch, TriangleAlert, MessageSquare, Terminal } from 'lucide-solid'
import { projectById } from '../store/projects'
import { isQuickProject } from '../store/quickTasks'
import { claudeDefaultViewMode, type SessionViewMode } from '../store/sessionViewMode'
import { agents } from '../store/agents'
import { startDraftTask } from '../store/draftTask'
import { selectedTaskId, showTaskBoard } from '../store/ui'
import { registerDictationTarget } from '../store/voice'
import { insertDictation } from '../lib/dictationInsert'
import * as ipc from '../lib/ipc'
import { failureText } from '../lib/accountErrors'
import { PROJECT_DEFAULT } from '../lib/accounts'
import type { AccountSelection, AgentType } from '../types'
import { HarnessModelPicker } from './HarnessModelPicker'
import { Select } from './Select'
import { CloudSessionPicker } from './CloudSessionPicker'
import { DictationControl } from './DictationControl'

export function NewTaskView(props: { projectId: string; onClose: () => void }) {
  const project = () => projectById(props.projectId)
  const [message, setMessage] = createSignal('')
  const [agent, setAgent] = createSignal<AgentType>('claude')
  const [model, setModel] = createSignal<string>()
  const selectedModel = () => model() ?? agents.find(a => a.id === agent())?.models?.[0]?.id
  const [account, setAccount] = createSignal<AccountSelection>(PROJECT_DEFAULT)
  const [baseBranch, setBaseBranch] = createSignal('main')
  const [branches, setBranches] = createSignal<string[]>([])
  const [currentBranch, setCurrentBranch] = createSignal('')
  const [workspace, setWorkspace] = createSignal('worktree')
  const [folder, setFolder] = createSignal<ipc.DirectoryInfo | null>(null)
  const [source, setSource] = createSignal('local')
  const [cloud, setCloud] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [choosing, setChoosing] = createSignal(false)
  const [error, setError] = createSignal('')
  const quick = () => isQuickProject(props.projectId)
  const [viewMode, setViewMode] = createSignal<SessionViewMode>(claudeDefaultViewMode())
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
    setCurrentBranch('')
    // Each project runs on its own Claude account, so the previous project's cloud access is not this one's.
    setCloud(false)
    setSource('local')
    setViewMode(claudeDefaultViewMode())
    if (isQuickProject(props.projectId) && p) {
      setWorkspace('folder')
      ipc.inspectTaskDirectory(p.repoPath).then(info => { if (!cancelled) setFolder(info) }).catch(() => {})
    } else if (workspace() === 'folder' && !folder()) {
      setWorkspace('worktree')
    }
    ipc.refreshAgents().catch(() => {})
    if (p && !isQuickProject(props.projectId)) ipc.getRepoInfo(p.repoPath).then(info => { if (!cancelled) { setBranches(info.branches); setCurrentBranch(info.currentBranch ?? '') } }).catch(() => {})
    ipc.claudeCloudAvailability(props.projectId).then(result => { if (!cancelled) setCloud(result.available) }).catch(() => {})
    queueMicrotask(() => textarea?.focus())
  }))

  // Dictation target while this box is on screen: Layout keeps the draft mounted
  // but hidden behind a selected task, and the task board hides both.
  createEffect(() => {
    if (source() !== 'local' || sending() || selectedTaskId() || showTaskBoard()) return
    onCleanup(registerDictationTarget({ id: 'new-task', sessionId: null, insert: insertDictated }))
  })
  function insertDictated(take: string) {
    const focused = !!textarea && document.activeElement === textarea
    const { text, cursor } = insertDictation(message(), take, focused ? { start: textarea.selectionStart, end: textarea.selectionEnd } : null)
    setMessage(text)
    if (focused) textarea.setSelectionRange(cursor, cursor)
  }

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
      await startDraftTask({ projectId: props.projectId, baseBranch: baseBranch(), agentType: agent(), model: selectedModel(), directory: directory(), account: account(), message: message().trim(), viewMode: agent() === 'claude' ? viewMode() : undefined })
      props.onClose()
    } catch (e) {
      // The account the task would run on can be unusable: that gets the account
      // toast, and the draft says what is wrong instead of printing the raw error.
      setError(failureText(e))
    }
    finally { setSending(false) }
  }

  const sendBlocker = () => !message().trim() ? 'Write what the agent should do' : unavailable() ? `${agents.find(a => a.id === agent())?.name} is not installed` : choosing() ? 'Choosing a folder…' : ''
  const runInOptions = () => [
    ...(quick() ? [] : [{ value: 'worktree', label: 'New worktree' }, { value: 'project', label: 'Project folder' }]),
    ...(folder() ? [{ value: 'folder', label: folder()!.path.split('/').pop() || folder()!.path }] : []),
    { value: 'choose', label: 'Choose folder…' },
  ]

  return <section class="flex flex-col h-full min-h-0 bg-surface-0" aria-label="New task">
    <header class="flex items-center justify-between pt-10 px-5 pb-3 drag-region" data-tauri-drag-region>
      <div class="flex items-center gap-2 text-xs text-text-muted"><span>New task</span><span class="text-text-dim">/</span><span class="text-text-secondary">{project()?.name}</span></div>
      <button class="btn-ghost no-drag" aria-label="Close draft" disabled={sending()} onClick={props.onClose}><X size={14} /></button>
    </header>
    <div class="flex-1 min-h-0 overflow-auto flex flex-col px-6 pt-4 sm:pt-8 pb-10">
      <div class="w-full max-w-160 mx-auto">
        <h1 class="sr-only">{quick() ? 'What should the agent look into?' : 'What should the agent do?'}</h1>
        <Show when={cloud() && !quick()}>
          <div role="group" aria-label="Task source" class="flex items-center gap-1 mb-4 border-b-1 border-b-solid border-b-outline/10 pb-2">
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
            <textarea ref={textarea} aria-label="Task prompt" placeholder={quick() ? 'What should the agent look into? e.g. find every repo under ~/code with uncommitted changes' : `What should the agent do in ${project()?.name ?? 'this project'}?`} value={message()} disabled={sending()}
              class="w-full min-h-20 max-h-64 resize-none bg-transparent text-sm text-text-primary p-4 outline-none leading-relaxed"
              onInput={e => setMessage(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() } }} />
            <div class="flex items-end gap-2 px-3 pb-3">
              <div class="flex-1 min-w-0 flex flex-wrap items-center gap-2">
              <HarnessModelPicker agent={agent()} model={selectedModel()} account={account()} projectId={props.projectId} disabled={sending()}
                onPick={(nextAgent, nextModel, nextAccount) => { setAgent(nextAgent); setModel(nextModel); setAccount(nextAccount ?? PROJECT_DEFAULT) }} />
              <span class="w-px h-4 bg-outline/10" aria-hidden="true" />
              <div class="min-w-0 flex items-center gap-1 pl-2 rounded-md bg-surface-2 ring-1 ring-outline/8">
                <Show when={workspace() === 'worktree'} fallback={<FolderOpen size={12} class="shrink-0" classList={{ 'text-status-waiting': workspace() === 'project', 'text-text-dim': workspace() !== 'project' }} />}><GitBranch size={12} class="shrink-0 text-text-dim" /></Show>
                <Select size="compact" label="Run in" value={workspace()} disabled={sending() || choosing()} onChange={chooseWorkspace} options={runInOptions()} />
              </div>
              <Show when={workspace() === 'worktree'}>
                <div class="min-w-0 flex items-center gap-1 pl-2 rounded-md bg-surface-2 ring-1 ring-outline/8" title="Base branch">
                  <span class="text-[11px] text-text-dim shrink-0">from</span>
                  <Select size="compact" label="Base branch" value={baseBranch()} disabled={sending()} onChange={setBaseBranch}
                    options={[...new Set([baseBranch(), ...branches()])].map(value => ({ value, label: value }))} />
                </div>
              </Show>
              <Show when={agent() === 'claude'}>
                <span class="w-px h-4 bg-outline/10" aria-hidden="true" />
                <span class="text-[11px] text-text-dim">open in</span>
                <div role="group" aria-label="Open the task in" class="flex items-center rounded-md bg-surface-2 ring-1 ring-outline/8 p-0.5">
                  <button type="button" aria-label="Open in chat" aria-pressed={viewMode() === 'ui'} title="Open in chat view" onClick={() => setViewMode('ui')}
                    class="h-5 px-1.5 flex items-center gap-1 rounded text-[11px] transition-colors" classList={{ 'bg-surface-0 text-text-primary ring-1 ring-outline/10': viewMode() === 'ui', 'text-text-muted hover:text-text-secondary': viewMode() !== 'ui' }}><MessageSquare size={11} />Chat</button>
                  <button type="button" aria-label="Open in terminal" aria-pressed={viewMode() === 'terminal'} title="Open in the Claude terminal" onClick={() => setViewMode('terminal')}
                    class="h-5 px-1.5 flex items-center gap-1 rounded text-[11px] transition-colors" classList={{ 'bg-surface-0 text-text-primary ring-1 ring-outline/10': viewMode() === 'terminal', 'text-text-muted hover:text-text-secondary': viewMode() !== 'terminal' }}><Terminal size={11} />Terminal</button>
                </div>
              </Show>
              </div>
              <DictationControl />
              <button aria-label="Send" title={sendBlocker() || 'Start the task (Enter) · Shift+Enter for a new line'} disabled={!!sendBlocker() || sending()} onClick={send}
                class="w-8 h-8 rounded-lg flex items-center justify-center bg-accent text-surface-0 disabled:bg-transparent disabled:ring-1 disabled:ring-outline/15 disabled:text-text-dim transition-colors">
                <Show when={sending()} fallback={<ArrowUp size={16} />}><Loader2 size={16} class="animate-spin" /></Show>
              </button>
            </div>
          </div>
          <p class="flex items-center gap-1.5 text-xs mt-2.5 min-w-0">
            <Show when={workspace() === 'worktree'}>
              <GitBranch size={12} class="shrink-0 text-text-dim" />
              <span class="text-text-muted">New branch from <span class="text-text-secondary">{baseBranch()}</span> in its own worktree. Changes stay isolated until you merge.</span>
            </Show>
            <Show when={workspace() === 'project'}>
              <TriangleAlert size={12} class="shrink-0 text-status-waiting" />
              <span class="text-text-muted">Edits {project()?.name} directly on <Show when={currentBranch()} fallback={<span>its checked-out branch</span>}><span class="font-mono text-text-secondary">{currentBranch()}</span></Show>. <span class="text-status-waiting font-medium">No isolation</span>: shared with other tasks in that folder.</span>
            </Show>
            <Show when={workspace() === 'folder' && folder()}>
              <FolderOpen size={12} class="shrink-0 text-text-dim" />
              <span class="truncate text-text-secondary" title={folder()!.path}>{folder()!.path}</span>
              <span class="shrink-0 text-text-dim">· {folder()!.isGit ? `git, on ${folder()!.branch || 'a detached HEAD'}` : 'not a git repo'} · edits in place</span>
            </Show>
          </p>
          <Show when={unavailable()}><p class="text-xs text-text-muted mt-2">{agents.find(a => a.id === agent())?.name} is not installed. Choose an installed agent.</p></Show>
          <Show when={sending()}><p role="status" class="text-xs text-text-muted mt-2">{workspace() === 'worktree' ? 'Preparing worktree…' : 'Starting task…'}</p></Show>
        </Show>
        <Show when={cloud()}><div style={{ display: source() === 'cloud' ? undefined : 'none' }}>
          <Show when={props.projectId} keyed>{projectId => <CloudSessionPicker projectId={projectId} onStarted={props.onClose} />}</Show>
        </div></Show>
        <Show when={error()}><p role="alert" class="text-sm text-red-400 mt-3">{error()}</p></Show>
      </div>
    </div>
  </section>
}
