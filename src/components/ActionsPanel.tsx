import { Component, For, JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CircleCheck, CircleX, Loader2, MinusCircle, ChevronRight, ChevronDown,
  RefreshCw, ExternalLink, Sparkles, RotateCw, X, Copy, Check, WrapText, Maximize2, Minimize2,
} from 'lucide-solid'
import { clsx } from 'clsx'
import type { WorkflowRun, WorkflowJob, WorkflowRunState } from '../types'
import {
  actionsState, refreshWorkflowRuns, loadJobsForRun, loadJobLogs, isAnyRunActive,
  startPolling, stopPolling, buildFixPrompt,
  rerunFailedJobsForRun, rerunSingleJob,
} from '../store/actions'
import { taskGit } from '../store/git'
import { taskById } from '../store/tasks'
import { sessionsForTask, sendMessage } from '../store/sessions'
import { selectedSessionForTask } from '../store/taskContext'
import { addToast, dismissToast, setSelectedSessionId } from '../store/ui'
import { setMainView } from '../store/editorView'
import { openModelPicker } from '../store/modelPicker'
import * as ipc from '../lib/ipc'
import { formatDurationShort } from '../lib/format'
import { parseGhLogs, formatShortTime, type LogLevel, type LogLine } from '../lib/ghLogs'
import { Popover } from './Popover'

interface Props {
  taskId: string
}

function stateIcon(state: WorkflowRunState): Component<{ size: number; class?: string }> {
  switch (state) {
    case 'success': return CircleCheck
    case 'failure': return CircleX
    case 'running': return Loader2
    case 'queued': return Loader2
    case 'cancelled':
    case 'skipped': return MinusCircle
  }
}

function stateColor(state: WorkflowRunState): string {
  switch (state) {
    case 'success': return 'text-emerald-400'
    case 'failure': return 'text-red-400'
    case 'running': return 'text-amber-400'
    case 'queued': return 'text-amber-400/70'
    case 'cancelled':
    case 'skipped': return 'text-text-dim'
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const delta = Date.now() - then
  if (delta < 60_000) return 'just now'
  return `${formatDurationShort(delta)} ago`
}

function jobDuration(job: WorkflowJob): string | null {
  if (!job.startedAt) return null
  const start = Date.parse(job.startedAt)
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return formatDurationShort(Math.max(0, end - start))
}

const LineRow: Component<{ line: LogLine; wrap: boolean }> = (props) => {
  const line = props.line
  const levelAccent = () => {
    switch (line.level) {
      case 'error': return 'before:bg-red-500/70 bg-red-500/5'
      case 'warning': return 'before:bg-amber-500/60 bg-amber-500/5'
      case 'notice': return 'before:bg-sky-500/60 bg-sky-500/5'
      case 'command': return 'before:bg-accent/60'
      default: return 'before:bg-transparent'
    }
  }
  const isCommand = line.level === 'command'
  return (
    <div class={clsx(
      'relative flex gap-2 pr-2 pl-2 hover:bg-surface-2/50',
      'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:content-[""]',
      levelAccent(),
    )}>
      <Show when={line.timestamp}>
        <span class="shrink-0 whitespace-nowrap text-text-dim/60 tabular-nums select-none" title={line.timestamp!}>
          {formatShortTime(line.timestamp!)}
        </span>
      </Show>
      <Show when={isCommand}>
        <span class="shrink-0 text-accent select-none">$</span>
      </Show>
      <span class={clsx(
        'min-w-0 flex-1',
        props.wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
        line.level === 'error' && 'text-text-primary',
        line.level === 'warning' && 'text-text-primary',
        line.level === 'notice' && 'text-sky-300',
        line.level === 'debug' && 'text-text-dim',
        line.level === 'command' && 'text-accent/90',
        line.level === 'info' && 'text-text-secondary',
      )}>{line.text || ' '}</span>
    </div>
  )
}

export function firstErrorIndex(lines: LogLine[]): number {
  for (let i = 0; i < lines.length; i++) if (lines[i].level === 'error') return i
  return -1
}

export function countLevel(lines: LogLine[], level: LogLevel): number {
  let n = 0
  for (const l of lines) if (l.level === level) n++
  return n
}

const LogView: Component<{ raw: string }> = (props) => {
  const lines = createMemo(() => parseGhLogs(props.raw))
  const totalErrors = createMemo(() => countLevel(lines(), 'error'))
  const totalWarnings = createMemo(() => countLevel(lines(), 'warning'))
  const firstErr = createMemo(() => firstErrorIndex(lines()))
  const [copied, setCopied] = createSignal(false)
  const [wrap, setWrap] = createSignal(true)
  const [fullscreen, setFullscreen] = createSignal(false)
  const errorRefs = new Map<'inline' | 'fullscreen', HTMLElement>()

  const scrollTo = (mode: 'inline' | 'fullscreen') => {
    const el = errorRefs.get(mode)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const jumpToFirstError = () => {
    scrollTo(fullscreen() ? 'fullscreen' : 'inline')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      addToast('Copy failed', 'error')
    }
  }

  createEffect(() => {
    if (!fullscreen()) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false) }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })

  // Auto-scroll to the first error on initial mount (once per view).
  onMount(() => queueMicrotask(() => scrollTo('inline')))
  // When user enters fullscreen, recenter on the error in that view too.
  createEffect(() => { if (fullscreen()) queueMicrotask(() => scrollTo('fullscreen')) })

  const list = (mode: 'inline' | 'fullscreen'): JSX.Element => (
    <For each={lines()}>
      {(line, i) => {
        const isFirstErr = firstErr() === i()
        return (
          <div ref={el => { if (isFirstErr && el) errorRefs.set(mode, el) }}>
            <LineRow line={line} wrap={wrap()} />
          </div>
        )
      }}
    </For>
  )

  const toolbar = (opts: { expanded: boolean }) => (
    <div class={clsx(
      'flex items-center gap-0.5 shrink-0',
      opts.expanded
        ? 'px-2 py-1 ring-1 ring-outline/8 ring-x-0 ring-t-0 bg-surface-1/80'
        : 'px-1.5 py-1 ring-1 ring-outline/8 ring-x-0 ring-t-0 bg-surface-1/60',
    )}>
      <span class="text-[10px] text-text-dim px-1 flex items-center gap-1.5 flex-1 tabular-nums">
        <span>{lines().length} lines</span>
        <Show when={totalErrors() > 0}>
          <button
            class="text-red-400 font-semibold hover:text-red-300 hover:underline transition-colors"
            onClick={jumpToFirstError}
            title="Jump to first error"
          >{totalErrors()} err</button>
        </Show>
        <Show when={totalWarnings() > 0}>
          <span class="text-amber-400">{totalWarnings()} warn</span>
        </Show>
      </span>
      <button
        class={clsx(
          'h-6 w-6 rounded flex items-center justify-center transition-colors',
          wrap() ? 'text-sky-400 hover:bg-sky-500/10' : 'text-text-dim hover:text-text-secondary hover:bg-surface-3',
        )}
        onClick={() => setWrap(!wrap())}
        title={wrap() ? 'Disable wrap' : 'Wrap long lines'}
      >
        <WrapText size={12} />
      </button>
      <button
        class="h-6 w-6 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
        onClick={copy}
        title={copied() ? 'Copied' : 'Copy logs'}
      >
        <Show when={copied()} fallback={<Copy size={12} />}>
          <Check size={12} class="text-emerald-400" />
        </Show>
      </button>
      <button
        class="h-6 w-6 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
        onClick={() => setFullscreen(!fullscreen())}
        title={fullscreen() ? 'Exit full view (Esc)' : 'Open in full view'}
      >
        <Show when={fullscreen()} fallback={<Maximize2 size={12} />}>
          <Minimize2 size={12} />
        </Show>
      </button>
    </div>
  )

  return (
    <>
      <div class="rounded ring-1 ring-outline/8 bg-surface-0/40 flex flex-col overflow-hidden" style="height:420px">
        {toolbar({ expanded: false })}
        <div class="select-text overflow-y-auto overflow-x-hidden flex-1 min-h-0 py-0.5 text-[10.5px] font-mono leading-snug overscroll-contain">
          {list('inline')}
        </div>
      </div>
      <Show when={fullscreen()}>
        <div
          class="fixed inset-0 z-100 bg-black/60 flex items-center justify-center p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false) }}
        >
          <div class="w-full max-w-5xl max-h-[calc(100vh-3rem)] flex flex-col bg-surface-1 rounded-lg ring-1 ring-outline/8 shadow-2xl overflow-hidden">
            {toolbar({ expanded: true })}
            <div class="select-text flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-0.5 text-[10.5px] font-mono leading-snug overscroll-contain">
              {list('fullscreen')}
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}

function StateIcon(props: { state: WorkflowRunState; size: number; class?: string }) {
  const Icon = stateIcon(props.state)
  const spin = props.state === 'running' || props.state === 'queued'
  return (
    <Icon
      size={props.size}
      class={clsx('shrink-0', stateColor(props.state), spin && 'animate-spin', props.class)}
    />
  )
}

const ActionsJobRow: Component<{ taskId: string; run: WorkflowRun; job: WorkflowJob }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [fixMenuPos, setFixMenuPos] = createSignal<{ x: number; y: number } | null>(null)

  const task = () => taskById(props.taskId)
  const activeSessionId = () => {
    const picked = selectedSessionForTask(props.taskId)
    if (picked) return picked
    const list = sessionsForTask(props.taskId)
    return list[0]?.id ?? null
  }

  const duration = () => jobDuration(props.job)
  const isFailed = () => props.job.state === 'failure'
  const canOpenUrl = () => !!props.job.url
  const logs = () => actionsState[props.taskId]?.logsByJob[props.job.databaseId]

  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    if (next && isFailed() && !logs()?.text && !logs()?.loading) {
      loadJobLogs(props.taskId, props.run.databaseId, props.job.databaseId)
    }
  }

  const sendFixToSession = async (newSession: boolean) => {
    setFixMenuPos(null)

    const toastId = `fix-${props.job.databaseId}`
    const logsCached = !!actionsState[props.taskId]?.logsByJob[props.job.databaseId]?.text

    const buildPrompt = () => buildFixPrompt(props.taskId, {
      runId: props.run.databaseId,
      runNumber: props.run.number,
      workflowName: props.run.workflowName,
      jobId: props.job.databaseId,
      jobName: props.job.name,
    })

    const existingSessionId = activeSessionId()
    if (!newSession && existingSessionId) {
      setBusy('fix')
      if (!logsCached) addToast('Fetching failure context...', 'info', { id: toastId, persistent: true, loading: true })
      try {
        const prompt = await buildPrompt()
        await sendMessage(existingSessionId, prompt)
        dismissToast(toastId)
        addToast('Sent failure context to session', 'success')
      } catch (e) {
        dismissToast(toastId)
        addToast(`Fix failed: ${e}`, 'error')
      } finally {
        setBusy(null)
      }
      return
    }

    const t = task()
    if (!t) {
      addToast('Task not found', 'error')
      return
    }
    const list = sessionsForTask(props.taskId)
    const pickedId = activeSessionId()
    const current = list.find(s => s.id === pickedId) ?? list[0]
    openModelPicker({
      title: 'Fix in new session',
      placeholder: 'Select agent and model for fix session...',
      defaultAgent: current?.agentType ?? t.agentType,
      defaultModel: current?.model ?? undefined,
      onPick: async (agentType, model) => {
        setBusy('fix')
        if (!logsCached) addToast('Fetching failure context...', 'info', { id: toastId, persistent: true, loading: true })
        try {
          const [created, prompt] = await Promise.all([
            ipc.createSession(props.taskId, agentType, model),
            buildPrompt(),
          ])
          setSelectedSessionId(created.id)
          setMainView(props.taskId, 'session')
          await sendMessage(created.id, prompt)
          dismissToast(toastId)
          addToast('Started new session with failure context', 'success')
        } catch (e) {
          dismissToast(toastId)
          addToast(`Fix failed: ${e}`, 'error')
        } finally {
          setBusy(null)
        }
      },
    })
  }

  const rerunJob = async () => {
    setBusy('rerun')
    try {
      await rerunSingleJob(props.taskId, props.run.databaseId, props.job.databaseId)
      addToast('Re-run requested', 'success')
    } catch (e) {
      addToast(`Re-run failed: ${e}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const refetch = (e: MouseEvent) => {
    e.stopPropagation()
    loadJobLogs(props.taskId, props.run.databaseId, props.job.databaseId)
  }

  const hasLogs = () => !!logs()?.text && logs()!.text!.length > 0
  const logState = () => {
    const l = logs()
    if (!l) return 'none'
    if (l.loading && !l.text) return 'loading'
    if (l.error) return 'error'
    if (l.text && l.text.length > 0) return 'text'
    if (l.text === '' || l.text === null) return 'empty'
    return 'none'
  }

  return (
    <div class="group/job">
      <button
        class="w-full pl-6 pr-2 py-0.5 flex items-center gap-1.5 text-[11px] text-left hover:bg-surface-2 transition-colors"
        onClick={toggle}
      >
        <Show when={isFailed()} fallback={<span class="w-[10px] shrink-0" />}>
          {expanded()
            ? <ChevronDown size={10} class="text-text-dim shrink-0" />
            : <ChevronRight size={10} class="text-text-dim shrink-0" />}
        </Show>
        <StateIcon state={props.job.state} size={11} />
        <span class="text-text-muted truncate flex-1 min-w-0">{props.job.name}</span>

        <div
          class={clsx(
            'flex items-center gap-0.5 shrink-0 transition-opacity',
            expanded() ? 'opacity-100' : 'opacity-0 group-hover/job:opacity-100 pointer-events-none group-hover/job:pointer-events-auto',
          )}
        >
          <Show when={isFailed()}>
            <span
              role="button"
              tabindex="0"
              class="h-5 w-5 rounded flex items-center justify-center text-accent hover:bg-accent/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                if (fixMenuPos()) { setFixMenuPos(null); return }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setFixMenuPos({ x: r.right - 176, y: r.bottom + 4 })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setFixMenuPos({ x: r.right - 176, y: r.bottom + 4 })
                }
              }}
              title="Fix with Claude"
            >
              <Show when={busy() === 'fix'} fallback={<Sparkles size={11} />}>
                <Loader2 size={11} class="animate-spin" />
              </Show>
            </span>
            <span
              role="button"
              tabindex="0"
              class="h-6 w-6 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
              onClick={(e) => { e.stopPropagation(); rerunJob() }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rerunJob() } }}
              title="Re-run this job"
            >
              <Show when={busy() === 'rerun'} fallback={<RotateCw size={11} />}>
                <Loader2 size={11} class="animate-spin" />
              </Show>
            </span>
          </Show>
          <Show when={canOpenUrl()}>
            <span
              role="button"
              tabindex="0"
              class="h-6 w-6 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
              onClick={(e) => { e.stopPropagation(); openUrl(props.job.url) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openUrl(props.job.url) }}
              title="Open on GitHub"
            >
              <ExternalLink size={10} />
            </span>
          </Show>
        </div>

        <Show when={duration()}>
          <span class="text-text-dim/60 text-[10px] tabular-nums shrink-0 ml-0.5 w-7 text-right">{duration()}</span>
        </Show>
      </button>

      <Popover
        open={fixMenuPos() !== null}
        onClose={() => setFixMenuPos(null)}
        pos={fixMenuPos() ?? undefined}
        class="w-44 py-1 text-[11px]"
      >
        <button class="menu-item w-full" onClick={() => sendFixToSession(false)}>
          <Sparkles size={12} class="text-accent" />
          <span>Fix in this session</span>
        </button>
        <button class="menu-item w-full" onClick={() => sendFixToSession(true)}>
          <Sparkles size={12} class="text-accent" />
          <span>Fix in new session</span>
        </button>
      </Popover>

      <Show when={expanded() && isFailed()}>
        <div class="pl-8 pr-2 pb-1.5">
          <Show when={logState() === 'loading'}>
            <div class="flex items-center gap-1.5 py-0.5 text-[10px] text-text-dim">
              <Loader2 size={10} class="animate-spin" />
              <span>Loading logs…</span>
            </div>
          </Show>
          <Show when={logState() === 'error'}>
            <div class="text-[10px] text-red-400/80 py-0.5">
              {logs()!.error}
              {' · '}
              <button class="underline hover:text-red-400" onClick={refetch}>retry</button>
            </div>
          </Show>
          <Show when={logState() === 'empty' || logState() === 'none'}>
            <div class="text-[10px] text-text-dim/70 py-0.5 italic">
              no captured output
              {' · '}
              <button class="not-italic underline hover:text-text-secondary" onClick={refetch}>refresh</button>
            </div>
          </Show>
          <Show when={logState() === 'text'}>
            <LogView raw={logs()!.text!} />
          </Show>
          <Show when={hasLogs() && logs()?.loading}>
            <div class="flex items-center gap-1 pl-2 pt-0.5 text-[10px] text-text-dim">
              <Loader2 size={9} class="animate-spin" />
              <span>Refreshing…</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const ActionsRunRow: Component<{ taskId: string; run: WorkflowRun }> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)

  const jobs = () => actionsState[props.taskId]?.jobsByRun[props.run.databaseId] ?? null
  const hasLoadedJobs = () => jobs() !== null
  const isActive = () => props.run.state === 'running' || props.run.state === 'queued'
  const isFailed = () => props.run.state === 'failure'

  const toggle = async () => {
    const next = !expanded()
    setExpanded(next)
    if (next && !hasLoadedJobs()) {
      await loadJobsForRun(props.taskId, props.run.databaseId)
    }
  }

  const rerunFailed = async (e: MouseEvent) => {
    e.stopPropagation()
    setBusy('rerun')
    try {
      await rerunFailedJobsForRun(props.taskId, props.run.databaseId)
      addToast('Re-run requested', 'success')
    } catch (err) {
      addToast(`Re-run failed: ${err}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const cancelRun = async (e: MouseEvent) => {
    e.stopPropagation()
    setBusy('cancel')
    try {
      await ipc.cancelWorkflowRun(props.taskId, props.run.databaseId)
      addToast('Cancel requested', 'success')
      await refreshWorkflowRuns(props.taskId)
    } catch (err) {
      addToast(`Cancel failed: ${err}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  // Auto-expand failed runs so users see the failing job immediately
  createEffect(() => {
    if (isFailed() && !expanded() && !hasLoadedJobs()) {
      setExpanded(true)
      loadJobsForRun(props.taskId, props.run.databaseId)
    }
  })

  return (
    <div class="text-[11px]">
      <button
        class="group w-full px-2 py-1 flex items-center gap-1.5 hover:bg-surface-2 transition-colors text-left"
        onClick={toggle}
      >
        {expanded()
          ? <ChevronDown size={10} class="text-text-dim shrink-0" />
          : <ChevronRight size={10} class="text-text-dim shrink-0" />}
        <StateIcon state={props.run.state} size={12} />
        <div class="flex-1 min-w-0 flex items-baseline gap-1">
          <span class="text-text-secondary truncate">{props.run.workflowName}</span>
          <span class="text-text-dim/60 tabular-nums text-[10px] shrink-0">#{props.run.number}</span>
        </div>

        <div class="flex items-center gap-0.5 shrink-0 ml-0.5 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto">
          <Show when={isFailed()}>
            <span
              role="button"
              tabindex="0"
              class="h-5 px-1 rounded flex items-center gap-0.5 text-[10px] text-amber-400 hover:bg-amber-500/10 transition-colors"
              onClick={rerunFailed}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') rerunFailed(e as unknown as MouseEvent) }}
              title="Re-run failed jobs"
            >
              <Show when={busy() === 'rerun'} fallback={<RotateCw size={10} />}>
                <Loader2 size={10} class="animate-spin" />
              </Show>
            </span>
          </Show>
          <Show when={isActive()}>
            <span
              role="button"
              tabindex="0"
              class="h-5 px-1 rounded flex items-center gap-0.5 text-[10px] text-text-dim hover:bg-surface-3 transition-colors"
              onClick={cancelRun}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') cancelRun(e as unknown as MouseEvent) }}
              title="Cancel run"
            >
              <Show when={busy() === 'cancel'} fallback={<X size={10} />}>
                <Loader2 size={10} class="animate-spin" />
              </Show>
            </span>
          </Show>
          <span
            role="button"
            tabindex="0"
            class="h-6 w-6 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={(e) => { e.stopPropagation(); openUrl(props.run.url) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openUrl(props.run.url) }}
            title="Open on GitHub"
          >
            <ExternalLink size={10} />
          </span>
        </div>

        <span class="text-text-dim/60 text-[10px] shrink-0 tabular-nums" title={props.run.createdAt}>
          {relativeTime(props.run.createdAt)}
        </span>
      </button>

      <Show when={expanded()}>
        <Show when={jobs() !== null} fallback={
          <div class="pl-8 pr-2 py-1 flex items-center gap-1.5 text-[10px] text-text-dim">
            <Loader2 size={10} class="animate-spin" />
            <span>Loading jobs...</span>
          </div>
        }>
          <Show when={jobs()!.length > 0} fallback={
            <div class="pl-8 pr-2 py-1 text-[10px] text-text-dim">No jobs reported.</div>
          }>
            <For each={jobs()!}>{job => <ActionsJobRow taskId={props.taskId} run={props.run} job={job} />}</For>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export const ActionsPanel: Component<Props> = (props) => {
  const state = () => actionsState[props.taskId]
  const git = () => taskGit(props.taskId)
  const task = () => taskById(props.taskId)

  const branch = () => task()?.branch ?? ''
  const repo = () => git().github

  const onRefresh = () => {
    refreshWorkflowRuns(props.taskId)
  }

  onMount(() => {
    refreshWorkflowRuns(props.taskId).then(() => {
      if (isAnyRunActive(props.taskId)) startPolling(props.taskId)
    })
    // Refresh when window regains focus
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshWorkflowRuns(props.taskId).then(() => {
          if (isAnyRunActive(props.taskId)) startPolling(props.taskId)
        })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', onVisible)
      stopPolling(props.taskId)
    })
  })

  // Re-arm polling whenever a refresh lands runs that are active, and stop it
  // once everything settles.
  createEffect(() => {
    if (isAnyRunActive(props.taskId)) {
      startPolling(props.taskId)
    } else {
      stopPolling(props.taskId)
    }
  })

  const grouped = createMemo(() => {
    const runs = state()?.runs ?? []
    const latestByWorkflow = new Map<string, WorkflowRun>()
    const rest: WorkflowRun[] = []
    for (const r of runs) {
      if (!latestByWorkflow.has(r.workflowName)) {
        latestByWorkflow.set(r.workflowName, r)
      } else {
        rest.push(r)
      }
    }
    return { latest: Array.from(latestByWorkflow.values()), rest }
  })

  const polling = () => !!state() && isAnyRunActive(props.taskId)

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="shrink-0 px-3 py-2 flex items-center gap-2 ring-1 ring-outline/8 ring-x-0 ring-t-0">
        <Show when={repo()} fallback={
          <span class="text-[11px] text-text-dim truncate">No GitHub remote</span>
        }>
          <span class="text-[11px] text-text-secondary truncate flex-1 min-w-0" title={`${repo()!.owner}/${repo()!.name} · ${branch()}`}>
            <span class="text-text-muted">{repo()!.owner}/{repo()!.name}</span>
            <Show when={branch()}>
              <span class="text-text-dim"> · {branch()}</span>
            </Show>
          </span>
        </Show>
        <Show when={polling()}>
          <span class="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" title="Auto-refreshing every 10s" />
        </Show>
        <button
          class="h-5 w-5 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors shrink-0"
          onClick={onRefresh}
          title="Refresh now"
          disabled={state()?.loading}
        >
          <Show when={state()?.loading} fallback={<RefreshCw size={11} />}>
            <Loader2 size={11} class="animate-spin" />
          </Show>
        </button>
        <Show when={repo()}>
          <button
            class="h-5 w-5 rounded flex items-center justify-center text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors shrink-0"
            onClick={() => openUrl(`${repo()!.url}/actions?query=branch:${encodeURIComponent(branch())}`)}
            title="Open Actions on GitHub"
          >
            <ExternalLink size={11} />
          </button>
        </Show>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto scrollbar-thin">
        <Show when={state()?.error} fallback={null}>
          <div class="px-3 py-2 text-[11px] text-red-400/80">
            {state()!.error}
            <Show when={state()!.error!.includes('gh')}>
              <div class="mt-1 text-text-dim">
                Requires GitHub CLI. Run <code class="text-text-muted">gh auth login</code>.
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!state()?.error && state()?.runs.length === 0 && !state()?.loading}>
          <div class="h-full flex flex-col items-center justify-center gap-1 p-6 text-center">
            <CircleCheck size={16} class="text-text-dim/50" />
            <div class="text-[11px] text-text-dim">No workflow runs on this branch yet.</div>
          </div>
        </Show>

        <Show when={(state()?.runs.length ?? 0) > 0}>
          <div class="pt-1">
            <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-text-dim/70">Latest</div>
            <For each={grouped().latest}>
              {run => <ActionsRunRow taskId={props.taskId} run={run} />}
            </For>
            <Show when={grouped().rest.length > 0}>
              <div class="px-3 pt-2 py-1 text-[10px] uppercase tracking-wide text-text-dim/70">History</div>
              <For each={grouped().rest}>
                {run => <ActionsRunRow taskId={props.taskId} run={run} />}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
