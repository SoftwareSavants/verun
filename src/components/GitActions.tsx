import { Component, createSignal, createEffect, createMemo, on, Show, For, onCleanup } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { ArrowUpFromLine, Download, GitPullRequest, GitMerge, Swords, Wrench, Search, ExternalLink, CircleCheck, CircleX, Clock, Circle, ChevronDown, Loader2, Eye, Archive } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import * as ipc from '../lib/ipc'
import { hasSkill, primeSkills, type SkillContext } from '../store/commands'
import { sessionById } from '../store/sessions'
import { sendMessage } from '../store/sessions'
import { archiveTask } from '../store/tasks'
import { addToast } from '../store/ui'
import { taskGit, refreshTaskGit, invalidateRemote, type TaskGitState } from '../store/git'
import { taskById } from '../store/tasks'
import { projectById } from '../store/projects'
import { registerDismissable } from '../lib/dismissable'

export function buildPrMessage(git: TaskGitState, base: string, isDraft: boolean): string {
  const draftPart = isDraft ? 'draft ' : ''
  const parts: string[] = []

  const uncommitted = git.status?.files ?? []
  if (uncommitted.length > 0) {
    const fileList = uncommitted
      .slice(0, 15)
      .map(f => `  ${f.status} ${f.path}`)
      .join('\n')
    const more = uncommitted.length > 15 ? `\n  ...and ${uncommitted.length - 15} more` : ''
    parts.push(`${uncommitted.length} uncommitted file${uncommitted.length === 1 ? '' : 's'}:\n${fileList}${more}`)
  }

  if (git.commits.length > 0) {
    const commitList = git.commits
      .slice(0, 10)
      .map(c => `  ${c.shortHash} ${c.message}`)
      .join('\n')
    const more = git.commits.length > 10 ? `\n  ...and ${git.commits.length - 10} more` : ''
    parts.push(`${git.commits.length} commit${git.commits.length === 1 ? '' : 's'} on this branch:\n${commitList}${more}`)
  }

  const context = parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
  const unpushed = git.branchStatus.unpushed
  const action = uncommitted.length > 0
    ? `commit all changes, push to remote, and then create a ${draftPart}pull request targeting ${base} with an appropriate title and description`
    : unpushed > 0
      ? `push to remote and then create a ${draftPart}pull request targeting ${base} with an appropriate title and description`
      : `create a ${draftPart}pull request targeting ${base} with an appropriate title and description`

  return `${action}${context}`
}

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
}

/** Reactive: does this task have any git status worth showing in the toolbar? */
export function hasGitActionsContent(taskId: string): boolean {
  const git = taskGit(taskId)
  return !!(
    git.pr ||
    (git.checks && git.checks.length > 0) ||
    git.commits.length > 0 ||
    git.branchStatus.behind > 0 ||
    (git.status?.files.length ?? 0) > 0
  )
}

export const GitActions: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [actionLoading, setActionLoading] = createSignal(false)
  const [mergePanelOpen, setMergePanelOpen] = createSignal(false)
  const [mergeFailure, setMergeFailure] = createSignal<string | null>(null)
  const [deleteBranch, setDeleteBranch] = createSignal(false)
  const [merging, setMerging] = createSignal(false)

  // Read all git state from the centralized store
  const git = () => taskGit(props.taskId)
  const baseBranch = () => {
    const task = taskById(props.taskId)
    return task ? (projectById(task.projectId)?.baseBranch ?? 'main') : 'main'
  }
  const pr = () => git().pr
  const checks = () => git().checks
  const behind = () => git().branchStatus.behind
  const unpushed = () => git().branchStatus.unpushed
  const fileCount = () => git().status?.files.length ?? 0
  const commitCount = () => git().commits.length

  createEffect(on(() => props.taskId, () => {
    setOpen(false)
    setConfirming(null)
    closeMergePanel()
    refreshTaskGit(props.taskId)
  }))

  const send = (message: string) => {
    const sid = props.sessionId
    if (!sid) return
    sendMessage(sid, message)
    setOpen(false)
  }

  const needsConfirmation = (label: string) =>
    label === 'Push' || label === 'Commit & Push' || label === 'Archive'

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
      invalidateRemote(props.taskId)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: any) {
      send(`push to remote. The error was: ${e}`)
    }
  }

  const openMergePanel = () => {
    setOpen(false)
    setMergePanelOpen(true)
    setDeleteBranch(false)
    setMergeFailure(null)
  }

  const closeMergePanel = () => {
    setMergePanelOpen(false)
    setMergeFailure(null)
  }

  const doMerge = async (force?: boolean) => {
    setMerging(true)
    try {
      await ipc.mergePullRequest(props.taskId, force, deleteBranch())
      addToast('PR merged', 'success')
      closeMergePanel()
      invalidateRemote(props.taskId)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: any) {
      if (!force) {
        setMergeFailure(String(e))
      } else {
        addToast(`Force merge failed: ${e}`, 'error')
        closeMergePanel()
      }
    } finally {
      setMerging(false)
    }
  }

  const doMarkReady = async () => {
    try {
      await ipc.markPrReady(props.taskId)
      addToast('PR marked as ready for review', 'success')
      invalidateRemote(props.taskId)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: any) {
      addToast(`Failed to mark PR ready: ${e}`, 'error')
    }
  }

  const skillContext = createMemo((): SkillContext | null => {
    const sid = props.sessionId
    const sess = sid ? sessionById(sid) : null
    const task = taskById(props.taskId)
    const project = task ? projectById(task.projectId) : null
    if (!sess || !task || !project) return null
    return {
      agentKind: sess.agentType,
      projectRoot: project.repoPath,
      taskId: task.id,
      worktreePath: task.worktreePath,
    }
  })
  createEffect(on(skillContext, ctx => {
    if (ctx) primeSkills(ctx)
  }))
  const hasReviewSkill = () => {
    const ctx = skillContext()
    return ctx ? hasSkill('review', ctx) : false
  }
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

  const hasLocalChanges = () => fileCount() > 0 || unpushed() > 0
  const localClean = () => !hasLocalChanges()

  const pushAction = (): GitAction =>
    fileCount() > 0
      ? { icon: ArrowUpFromLine, label: 'Commit & Push', message: 'commit all changes and push to remote' }
      : { icon: ArrowUpFromLine, label: 'Push', action: doPush }
  const createPrAction = (): GitAction => ({ icon: GitPullRequest, label: 'Create PR', message: buildPrMessage(git(), baseBranch(), false) })
  const draftPrAction = (): GitAction => ({ icon: GitPullRequest, label: 'Draft PR', message: buildPrMessage(git(), baseBranch(), true) })
  const pullAction = (): GitAction => ({ icon: Download, label: 'Update Branch', message: `this branch is behind ${baseBranch()}. rebase onto ${baseBranch()} to bring it up to date. Use git rebase, not merge.` })
  const resolveConflictsAction = (): GitAction => ({ icon: Swords, label: 'Resolve conflicts', message: `rebase this branch onto ${baseBranch()} and resolve any conflicts. Use git rebase, not merge. If conflicts arise during rebase, resolve them and continue with git rebase --continue` })
  const mergePrAction = (): GitAction => ({ icon: GitMerge, label: 'Merge PR', action: async () => openMergePanel() })
  const readyForReviewAction = (): GitAction => ({ icon: Eye, label: 'Ready for Review', action: doMarkReady })
  const archiveAction = (): GitAction => ({ icon: Archive, label: 'Archive', action: async () => { await archiveTask(props.taskId) } })

  const isDraft = () => pr()?.isDraft ?? false
  const isBehind = () => behind() > 0
  const prMerged = () => pr()?.state === 'MERGED'

  // Smart default action based on state
  // Flow: Pull (if behind) → Push (updates existing PR) → Create PR → Ready for Review (if draft) → Resolve conflicts → Merge
  const primaryAction = (): GitAction => {
    if (prMerged() && localClean()) return archiveAction()
    if (prMerged()) return pushAction()
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
  const anyPanelOpen = () => open() || mergePanelOpen()
  const closeAllPanels = () => { setOpen(false); closeMergePanel() }
  const handleClickOutside = (e: MouseEvent) => {
    if (anyPanelOpen() && containerRef && !containerRef.contains(e.target as Node)) {
      closeAllPanels()
    }
  }
  createEffect(() => {
    if (anyPanelOpen()) {
      document.addEventListener('mousedown', handleClickOutside)
      const unregister = registerDismissable(closeAllPanels)
      onCleanup(() => {
        document.removeEventListener('mousedown', handleClickOutside)
        unregister()
      })
    }
  })

  const hasOpenPr = () => pr()?.state === 'OPEN'
  const prClosed = () => pr()?.state === 'CLOSED'
  const prDone = () => prMerged()
  const hasAnything = () => hasOpenPr() || prMerged() || prClosed() || (!prDone() && (commitCount() > 0 || isBehind())) || fileCount() > 0

  const PrimaryIcon = () => {
    return <Dynamic component={primaryAction().icon} size={12} />
  }

  return (
    <div class="relative flex items-center gap-1" ref={containerRef}>
        <Show when={pr() || ciSummary()}>
          {/* Status badges */}
          <div class="flex items-center gap-1.5 shrink-0">
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
        </Show>

      <Show when={hasAnything()}>

        {/* Split button */}
        <div
          class={`toolbar-chrome flex items-stretch shrink-0 overflow-hidden transition-colors ${
            confirming() === primaryAction().label
              ? 'ring-amber-500/60 text-amber-300'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <button
            class={`flex items-center gap-1 px-2 text-[11px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${
              confirming() === primaryAction().label
                ? 'hover:bg-amber-500/10'
                : 'hover:bg-surface-2'
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
            <span class={`w-px self-stretch ${confirming() === primaryAction().label ? 'bg-amber-500/40' : 'bg-outline/8'}`} />
            <button
              class={`flex items-center px-1.5 transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                confirming() === primaryAction().label ? 'hover:bg-amber-500/10' : 'hover:bg-surface-2'
              }`}
              onClick={() => { setConfirming(null); closeMergePanel(); setOpen(!open()) }}
              disabled={props.isRunning || actionLoading()}
            >
              <ChevronDown size={11} />
            </button>
          </Show>
        </div>


      {/* Dropdown */}
      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-52 bg-surface-2 border border-slate-700 rounded-lg shadow-xl py-1 animate-in">
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

      <Show when={mergePanelOpen()}>
        <div class="absolute right-0 top-full mt-1 z-50 w-56 bg-surface-2 border border-slate-700 rounded-lg shadow-xl py-3 px-3 flex flex-col gap-2.5 animate-in">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteBranch()}
              onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
              class="accent-accent w-3.5 h-3.5"
            />
            <span class="text-[13px] text-text-secondary">Delete remote branch</span>
          </label>

          <Show when={mergeFailure()} fallback={
            <button
              class="w-full h-7 flex items-center justify-center gap-1 px-2 rounded text-[11px] btn-primary transition-colors disabled:opacity-40"
              onClick={() => doMerge()}
              disabled={merging()}
            >
              <Show when={merging()} fallback={<>Merge</>}>
                <Loader2 size={11} class="animate-spin" />
                <span>Merging...</span>
              </Show>
            </button>
          }>
            <button
              class="w-full h-7 flex items-center justify-center gap-1 px-2 rounded text-[11px] bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-40"
              onClick={() => doMerge(true)}
              disabled={merging()}
            >
              <Show when={merging()} fallback={<>Force Merge</>}>
                <Loader2 size={11} class="animate-spin" />
                <span>Merging...</span>
              </Show>
            </button>
          </Show>

          <Show when={mergeFailure()}>
            <p class="text-[11px] text-red-400 m-0">
              {mergeFailure()!.toLowerCase().includes('policy') || mergeFailure()!.toLowerCase().includes('protection')
                ? 'Branch protection is blocking this merge. Use force merge to bypass.'
                : `Merge failed. Use force merge to retry with admin privileges.`}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}
