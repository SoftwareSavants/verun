import { Component, createSignal, createEffect, on, Show, For, onCleanup } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { Upload, Download, GitPullRequest, GitMerge, Swords, Wrench, Search, ExternalLink, CircleCheck, CircleX, Clock, Circle, ChevronDown, Loader2, Eye } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import * as ipc from '../lib/ipc'
import { claudeSkills } from '../store/commands'
import { sendMessage } from '../store/sessions'
import { addToast } from '../store/ui'
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
  commitCount: number
}

// Per-task PR cache: serve instantly on switch, refresh in background
const prCache = new Map<string, { pr: PrInfo | null; checks: CiCheck[]; at: number }>()
const PR_CACHE_TTL = 30_000 // 30s — background refresh if older

export const GitActions: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [pr, setPr] = createSignal<PrInfo | null>(null)
  const [checks, setChecks] = createSignal<CiCheck[]>([])
  const [behind, setBehind] = createSignal(0)
  const [unpushed, setUnpushed] = createSignal(0)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [actionLoading, setActionLoading] = createSignal(false)

  const fetchPrAndChecks = async (taskId: string) => {
    const prInfo = await ipc.getPullRequest(taskId).catch(() => null)
    const ciChecks = prInfo
      ? await ipc.getCiChecks(taskId).catch(() => [])
      : []
    prCache.set(taskId, { pr: prInfo, checks: ciChecks, at: Date.now() })
    // Only apply if still viewing this task
    if (props.taskId === taskId) {
      setPr(prInfo)
      setChecks(ciChecks)
    }
  }

  const refresh = async (forcePrRefresh = false) => {
    const taskId = props.taskId

    // Restore cached PR data instantly, fetch fresh in background
    const cached = prCache.get(taskId)
    if (cached && !forcePrRefresh) {
      setPr(cached.pr)
      setChecks(cached.checks)
    }

    // Fast local calls — always await
    const [, branchStatus] = await Promise.all([
      ipc.checkGithub(taskId).catch(() => null),
      ipc.getBranchStatus(taskId).catch(() => [0, 0, 0] as [number, number, number]),
    ])
    setBehind(branchStatus?.[1] ?? 0)
    setUnpushed(branchStatus?.[2] ?? 0)

    // Slow gh CLI call — await if forced (after actions), background otherwise
    if (forcePrRefresh || !cached || Date.now() - cached.at > PR_CACHE_TTL) {
      if (forcePrRefresh) {
        await fetchPrAndChecks(taskId)
      } else {
        fetchPrAndChecks(taskId)
      }
    }
  }

  createEffect(on(() => props.taskId, () => {
    // Restore from cache or clear
    const cached = prCache.get(props.taskId)
    setPr(cached?.pr ?? null)
    setChecks(cached?.checks ?? [])
    setBehind(0)
    setUnpushed(0)
    setOpen(false)
    setConfirming(null)
    refresh()
  }))

  createEffect(() => {
    const unlisten = listen<{ taskId: string }>('git-status-changed', (event) => {
      if (event.payload.taskId === props.taskId) {
        prCache.delete(props.taskId) // invalidate so PR state is re-fetched
        refresh()
      }
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
    label === 'Push' || label === 'Commit & Push' || label === 'Merge PR'

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
      addToast('Pushed to remote', 'success')
      prCache.delete(props.taskId)
      await refresh(true)
    } catch (e: any) {
      send(`push to remote. The error was: ${e}`)
    }
  }

  const doMerge = async () => {
    try {
      await ipc.mergePullRequest(props.taskId)
      addToast('PR merged', 'success')
      prCache.delete(props.taskId)
      await refresh(true)
    } catch (e: any) {
      addToast(`Merge failed: ${e}`, 'error')
    }
  }

  const doMarkReady = async () => {
    try {
      await ipc.markPrReady(props.taskId)
      addToast('PR marked as ready for review', 'success')
      prCache.delete(props.taskId)
      await refresh(true)
    } catch (e: any) {
      addToast(`Failed to mark PR ready: ${e}`, 'error')
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

  const hasLocalChanges = () => props.fileCount > 0 || unpushed() > 0
  const localClean = () => !hasLocalChanges()

  const pushAction = (): GitAction =>
    props.fileCount > 0
      ? { icon: Upload, label: 'Commit & Push', message: 'commit all changes and push to remote' }
      : { icon: Upload, label: 'Push', action: doPush }
  const createPrAction = (): GitAction => ({ icon: GitPullRequest, label: 'Create PR', message: 'create a pull request with an appropriate title and description' })
  const draftPrAction = (): GitAction => ({ icon: GitPullRequest, label: 'Draft PR', message: 'create a draft pull request with an appropriate title and description' })
  const pullAction = (): GitAction => ({ icon: Download, label: 'Update Branch', message: 'this branch is behind the base branch. rebase onto the base branch to bring it up to date. Use git rebase, not merge.' })
  const resolveConflictsAction = (): GitAction => ({ icon: Swords, label: 'Resolve conflicts', message: 'rebase this branch onto the base branch and resolve any conflicts. Use git rebase, not merge. If conflicts arise during rebase, resolve them and continue with git rebase --continue' })
  const mergePrAction = (): GitAction => ({ icon: GitMerge, label: 'Merge PR', action: doMerge })
  const readyForReviewAction = (): GitAction => ({ icon: Eye, label: 'Ready for Review', action: doMarkReady })

  const isDraft = () => pr()?.isDraft ?? false
  const isBehind = () => behind() > 0

  // Smart default action based on state
  // Flow: Pull (if behind) → Push (updates existing PR) → Create PR → Ready for Review (if draft) → Resolve conflicts → Merge
  const primaryAction = (): GitAction => {
    if (failedChecks().length > 0) return { icon: Wrench, label: 'Fix CI', message: `fix the failing CI checks: ${failedChecks().map(c => c.name).join(', ')}` }
    if (isBehind() && !prDone()) return pullAction()
    if (hasOpenPr() && hasLocalChanges()) return pushAction()
    if (!hasOpenPr()) return createPrAction()
    if (isDraft() && localClean()) return readyForReviewAction()
    if (conflicts() && localClean()) return resolveConflictsAction()
    if (localClean()) return mergePrAction()
    return createPrAction()
  }

  const secondaryActions = () => {
    const primary = primaryAction()
    const hasPr = hasOpenPr()
    const draft = isDraft()
    const all: GitAction[] = [
      pullAction(),
      createPrAction(),
      draftPrAction(),
      pushAction(),
      readyForReviewAction(),
      mergePrAction(),
    ]
    if (hasReviewSkill()) {
      all.push({ icon: Search, label: 'Review', message: '/review' })
    }
    return all.filter(a => {
      if (a.label === primary.label) return false
      if (a.label === 'Update Branch' && (!isBehind() || prDone())) return false
      if ((a.label === 'Push' || a.label === 'Commit & Push') && (!hasPr || !hasLocalChanges())) return false
      if ((a.label === 'Create PR' || a.label === 'Draft PR') && hasPr) return false
      if (a.label === 'Ready for Review' && (!hasPr || !draft)) return false
      if (a.label === 'Merge PR' && (!hasPr || draft || conflicts())) return false
      if (a.label === 'Review' && !hasPr) return false
      return true
    })
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

  const hasOpenPr = () => pr()?.state === 'OPEN'
  const prDone = () => pr() && !hasOpenPr()
  const hasAnything = () => hasOpenPr() || (!prDone() && (props.commitCount > 0 || isBehind())) || props.fileCount > 0

  const PrimaryIcon = () => {
    const Icon = primaryAction().icon
    return <Icon size={12} />
  }

  return (
    <div class="relative flex items-center gap-2" ref={containerRef}>
        {/* Status badges — always visible */}
        <div class="flex items-center gap-1.5 flex-1 min-w-0 justify-end">
          <Show when={pr()}>
            <button
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-surface-3 transition-colors"
              onClick={() => openUrl(pr()!.url)}
              title={`PR #${pr()!.number}: ${pr()!.title}`}
            >
              <GitPullRequest size={11} class={
                pr()!.state === 'MERGED' ? 'text-purple-400'
                  : pr()!.state === 'CLOSED' ? 'text-red-400'
                  : pr()!.isDraft ? 'text-text-dim'
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

      <Show when={hasAnything()}>

        {/* Split button */}
        <div class="flex items-center shrink-0">
          <button
            class={`flex items-center gap-1.5 text-[11px] py-1 pr-2 ${
              secondaryActions().length > 0 ? 'rounded-r-none' : ''
            } ${
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
          <Show when={secondaryActions().length > 0}>
            <button
              class="btn-primary rounded-l-none border-l border-white/15 px-1.5 py-1"
              onClick={() => { setConfirming(null); setOpen(!open()) }}
              disabled={props.isRunning || actionLoading()}
            >
              <ChevronDown size={11} />
            </button>
          </Show>
        </div>


      {/* Dropdown */}
      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-52 bg-surface-2 border border-border-active rounded-lg shadow-xl py-1 animate-in">
          <For each={secondaryActions()}>
            {(action) => {
              const Icon = action.icon
              return (
                <button
                  class="menu-item"
                  onClick={() => runAction(action)}
                >
                  <Icon size={13} />
                  <span>{action.label}</span>
                </button>
              )
            }}
          </For>

          <Show when={failedChecks().length > 0 && primaryAction().label !== 'Fix CI'}>
            <div class="border-t border-border-subtle my-1" />
            <button
              class="menu-item !text-amber-400"
              onClick={() => send(`fix the failing CI checks: ${failedChecks().map(c => c.name).join(', ')}`)}
            >
              <Wrench size={13} />
              <span>Fix CI ({failedChecks().length} failed)</span>
            </button>
          </Show>

          {/* Links */}
          <Show when={pr()}>
            <div class="border-t border-border-subtle my-1" />
            <button
              class="menu-item"
              onClick={() => { openUrl(pr()!.url); setOpen(false) }}
            >
              <ExternalLink size={13} />
              <span>Open PR #{pr()!.number}</span>
            </button>
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
      </Show>
    </div>
  )
}
