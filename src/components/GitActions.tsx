import { Component, createSignal, createEffect, on, Show, For, onCleanup } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { GitCommit, Upload, GitPullRequest, GitMerge, Swords, Wrench, Search, ExternalLink, CircleCheck, CircleX, Clock, Circle, ChevronDown, Loader2 } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import * as ipc from '../lib/ipc'
import { claudeSkills } from '../store/commands'
import { sendMessage } from '../store/sessions'
import type { PrInfo, CiCheck } from '../types'

interface GitAction {
  icon: Component<{ size: number }>
  label: string
  message?: string
  action?: () => Promise<void>
}

interface Props {
  taskId: string
  sessionId: string | null
  isRunning?: boolean
  fileCount: number
}

export const GitActions: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [pr, setPr] = createSignal<PrInfo | null>(null)
  const [checks, setChecks] = createSignal<CiCheck[]>([])
  const [branchUrl, setBranchUrl] = createSignal<string | null>(null)
  const [pushed, setPushed] = createSignal(false)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [actionLoading, setActionLoading] = createSignal(false)

  const refresh = async () => {
    const [, prInfo, brUrl] = await Promise.all([
      ipc.checkGithub(props.taskId).catch(() => null),
      ipc.getPullRequest(props.taskId).catch(() => null),
      ipc.getBranchUrl(props.taskId).catch(() => null),
    ])

    setPr(prInfo)
    setBranchUrl(brUrl)
    setPushed(!!brUrl)

    if (prInfo) {
      const ciChecks = await ipc.getCiChecks(props.taskId).catch(() => [])
      setChecks(ciChecks)
    } else {
      setChecks([])
    }
  }

  createEffect(on(() => props.taskId, () => { refresh() }))

  createEffect(() => {
    const unlisten = listen<{ taskId: string }>('git-status-changed', (event) => {
      if (event.payload.taskId === props.taskId) refresh()
    })
    onCleanup(() => { unlisten.then(fn => fn()) })
  })

  const send = (message: string) => {
    const sid = props.sessionId
    if (!sid) return
    sendMessage(sid, message)
    setOpen(false)
  }

  const needsConfirmation = (label: string) =>
    label === 'Push' || label === 'Merge PR'

  const runAction = async (a: GitAction) => {
    if (needsConfirmation(a.label) && confirming() !== a.label) {
      setConfirming(a.label)
      setTimeout(() => setConfirming(null), 3000)
      return
    }
    setConfirming(null)
    setActionLoading(true)
    try {
      if (a.action) {
        await a.action()
        setOpen(false)
        refresh()
      } else if (a.message) {
        send(a.message)
      }
    } finally {
      setActionLoading(false)
    }
  }

  const doPush = async () => {
    try {
      await ipc.gitPush(props.taskId)
      refresh()
    } catch (e: any) {
      // Fall back to Claude if direct push fails
      send(`push to remote. The error was: ${e}`)
    }
  }

  const hasReviewSkill = () => claudeSkills().some(s => s.name === 'review')
  const conflicts = () => pr()?.mergeable === 'CONFLICTING'
  const failedChecks = () => checks().filter(c => c.status === 'FAILURE' || c.status === 'ERROR')
  const pendingChecks = () => checks().filter(c => c.status === 'PENDING' || c.status === 'QUEUED' || c.status === 'IN_PROGRESS')
  const passedChecks = () => checks().filter(c => c.status === 'SUCCESS')

  const ciSummary = () => {
    const f = failedChecks().length
    const p = pendingChecks().length
    const s = passedChecks().length
    if (f > 0) return { icon: CircleX, color: 'text-red-400', label: `${f} failed` }
    if (p > 0) return { icon: Clock, color: 'text-amber-400', label: `${p} pending` }
    if (s > 0) return { icon: CircleCheck, color: 'text-emerald-400', label: `${s} passed` }
    return null
  }

  // Smart default action based on state
  const primaryAction = (): GitAction => {
    if (conflicts()) return { icon: Swords, label: 'Resolve conflicts', message: 'resolve all merge conflicts' }
    if (failedChecks().length > 0) return { icon: Wrench, label: 'Fix CI', message: `fix the failing CI checks: ${failedChecks().map(c => c.name).join(', ')}` }
    if (props.fileCount > 0) return { icon: GitCommit, label: 'Commit', message: 'commit all changes with a descriptive message' }
    if (!pushed()) return { icon: Upload, label: 'Push', action: doPush }
    if (!pr()) return { icon: GitPullRequest, label: 'Create PR', message: 'create a pull request with an appropriate title and description' }
    if (pr()?.state === 'OPEN') return { icon: GitMerge, label: 'Merge PR', message: 'merge the pull request for this branch' }
    return { icon: GitCommit, label: 'Commit', message: 'commit all changes with a descriptive message' }
  }

  const secondaryActions = () => {
    const primary = primaryAction()
    const all: GitAction[] = [
      { icon: GitCommit, label: 'Commit', message: 'commit all changes with a descriptive message' },
      { icon: Upload, label: 'Push', action: doPush },
      { icon: GitPullRequest, label: 'Create PR', message: 'create a pull request with an appropriate title and description' },
      { icon: GitMerge, label: 'Merge PR', message: 'merge the pull request for this branch' },
    ]
    if (hasReviewSkill()) {
      all.push({ icon: Search, label: 'Review', message: '/review' })
    }
    return all.filter(a => a.label !== primary.label)
  }

  // Close dropdown on outside click
  let containerRef: HTMLDivElement | undefined
  const handleClickOutside = (e: MouseEvent) => {
    if (open() && containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }
  createEffect(() => {
    if (open()) {
      document.addEventListener('mousedown', handleClickOutside)
      onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))
    }
  })

  const PrimaryIcon = () => {
    const Icon = primaryAction().icon
    return <Icon size={12} />
  }

  return (
    <div class="relative flex items-center gap-2" ref={containerRef}>
        {/* Split button */}
        <div class="flex items-center">
          <button
            class={`flex items-center gap-1.5 text-[11px] rounded-r-none pr-2 ${
              confirming() === primaryAction().label
                ? 'btn-primary bg-amber-600 hover:bg-amber-500'
                : 'btn-primary'
            }`}
            onClick={() => runAction(primaryAction())}
            disabled={props.isRunning || actionLoading()}
          >
            <Show when={actionLoading()} fallback={<PrimaryIcon />}>
              <Loader2 size={12} class="animate-spin" />
            </Show>
            <span>
              {confirming() === primaryAction().label
                ? `Confirm ${primaryAction().label}?`
                : primaryAction().label}
            </span>
          </button>
          <button
            class="btn-primary rounded-l-none border-l border-white/15 px-1.5"
            onClick={() => { setConfirming(null); setOpen(!open()) }}
            disabled={props.isRunning || actionLoading()}
          >
            <ChevronDown size={11} />
          </button>
        </div>

        {/* Status badges */}
        <div class="flex items-center gap-1.5 flex-1 min-w-0">
          <Show when={pr()}>
            <button
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-surface-3 transition-colors"
              onClick={() => openUrl(pr()!.url)}
              title={`PR #${pr()!.number}: ${pr()!.title}`}
            >
              <GitPullRequest size={11} class={
                pr()!.state === 'MERGED' ? 'text-purple-400'
                  : pr()!.state === 'CLOSED' ? 'text-red-400'
                  : 'text-emerald-400'
              } />
              <span class="text-text-dim">#{pr()!.number}</span>
            </button>
          </Show>

          <Show when={ciSummary()}>
            {(summary) => {
              const Icon = summary().icon
              return (
                <span class={`flex items-center gap-0.5 text-[10px] ${summary().color}`} title={summary().label}>
                  <Icon size={11} />
                  <span>{summary().label}</span>
                </span>
              )
            }}
          </Show>
        </div>

        {/* GitHub link */}
        <Show when={pr()}>
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => openUrl(pr()!.url)}
            title="Open PR"
          >
            <ExternalLink size={11} />
          </button>
        </Show>
        <Show when={!pr() && branchUrl()}>
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => openUrl(branchUrl()!)}
            title="Open on GitHub"
          >
            <ExternalLink size={11} />
          </button>
        </Show>

      {/* Dropdown */}
      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-52 bg-surface-2 border border-border-active rounded-lg shadow-xl py-1 animate-in">
          <For each={secondaryActions()}>
            {(action) => {
              const Icon = action.icon
              return (
                <button
                  class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                  onClick={() => runAction(action)}
                >
                  <Icon size={13} />
                  <span>{action.label}</span>
                </button>
              )
            }}
          </For>

          {/* Conditional actions */}
          <Show when={conflicts() && primaryAction().label !== 'Resolve conflicts'}>
            <div class="border-t border-border-subtle my-1" />
            <button
              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-amber-400 hover:bg-surface-3 transition-colors"
              onClick={() => send('resolve all merge conflicts')}
            >
              <Swords size={13} />
              <span>Resolve conflicts</span>
            </button>
          </Show>

          <Show when={failedChecks().length > 0 && primaryAction().label !== 'Fix CI'}>
            <div class="border-t border-border-subtle my-1" />
            <button
              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-amber-400 hover:bg-surface-3 transition-colors"
              onClick={() => send(`fix the failing CI checks: ${failedChecks().map(c => c.name).join(', ')}`)}
            >
              <Wrench size={13} />
              <span>Fix CI ({failedChecks().length} failed)</span>
            </button>
          </Show>

          {/* Links */}
          <Show when={pr() || branchUrl()}>
            <div class="border-t border-border-subtle my-1" />
            <Show when={pr()}>
              <button
                class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                onClick={() => { openUrl(pr()!.url); setOpen(false) }}
              >
                <ExternalLink size={13} />
                <span>Open PR #{pr()!.number}</span>
              </button>
            </Show>
            <Show when={branchUrl()}>
              <button
                class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                onClick={() => { openUrl(branchUrl()!); setOpen(false) }}
              >
                <ExternalLink size={13} />
                <span>Open on GitHub</span>
              </button>
            </Show>
          </Show>

          {/* CI check details */}
          <Show when={checks().length > 0}>
            <div class="border-t border-border-subtle my-1" />
            <div class="px-3 py-1 text-[10px] text-text-dim font-medium">CI Checks</div>
            <For each={checks()}>
              {(check) => (
                <button
                  class="w-full flex items-center gap-2 px-3 py-1 text-[11px] text-text-secondary hover:bg-surface-3 transition-colors"
                  onClick={() => { if (check.url) openUrl(check.url); setOpen(false) }}
                >
                  <span class={
                    check.status === 'SUCCESS' ? 'text-emerald-400'
                      : check.status === 'FAILURE' || check.status === 'ERROR' ? 'text-red-400'
                      : 'text-amber-400'
                  }>
                    {check.status === 'SUCCESS' ? <CircleCheck size={11} />
                      : check.status === 'FAILURE' || check.status === 'ERROR' ? <CircleX size={11} />
                      : <Circle size={11} />
                    }
                  </span>
                  <span class="truncate">{check.name}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}
