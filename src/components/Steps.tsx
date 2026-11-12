// The pieces of a step row (an icon and a sentence), the line a subagent shows
// for each of its latest steps, and the rows that fold a turn's work log.
import { For, Show, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { clsx } from 'clsx'
import {
  BookOpen, Brain, ChevronRight, CircleX, FilePen, FilePlus, FileText, FolderSearch, Globe, Layers, ListTodo, Loader2,
  MessageCircleQuestion, MessageSquareText, Plug, RotateCcw, Search, SquareTerminal, Wrench,
} from 'lucide-solid'
import type { StepKind, StepPart } from '../lib/steps'
import type { FoldRow } from '../lib/workLog'
import { formatElapsed, useNow } from '../lib/subagents'

export type StepIconKind = StepKind | 'thinking' | 'message'

const KIND_ICON: Record<StepIconKind, typeof FileText> = {
  read: FileText, edit: FilePen, write: FilePlus, search: Search, files: FolderSearch, run: SquareTerminal,
  web: Globe, todo: ListTodo, question: MessageCircleQuestion, skill: BookOpen, mcp: Plug, other: Wrench,
  thinking: Brain, message: MessageSquareText,
}

/** What kind of step, or that it is running or failed. Shape carries the status, not just color. */
export const StepIcon: Component<{ kind: StepIconKind; running?: boolean; failed?: boolean }> = (props) => (
  <span class="w-3.5 shrink-0 flex items-center justify-center">
    <Show
      when={props.running}
      fallback={
        <Show when={props.failed} fallback={<Dynamic component={KIND_ICON[props.kind]} size={13} class="text-text-dim" aria-hidden="true" />}>
          <CircleX size={13} class="text-status-error" aria-label="Failed" />
        </Show>
      }
    >
      <Loader2 size={13} class="animate-spin text-status-running" aria-label="Running" />
    </Show>
  </span>
)

const TONE: Record<Exclude<StepPart['tone'], 'path'>, string> = {
  verb: 'text-text-secondary',
  target: 'text-text-primary',
  code: 'font-mono text-[11.5px] text-text-secondary',
  dim: 'text-text-muted',
}

/** A path with its folder quieter than the file name. */
const PathText: Component<{ path: string }> = (props) => {
  const cut = () => props.path.lastIndexOf('/')
  return (
    <>
      <Show when={cut() > 0}><span class="text-text-muted">{props.path.slice(0, cut() + 1)}</span></Show>
      <span class="text-text-primary">{props.path.slice(cut() + 1)}</span>
    </>
  )
}

/** The sentence of a step, on one line that truncates at the end. */
export const StepLabel: Component<{ parts: StepPart[]; class?: string; fileOpen?: boolean }> = (props) => (
  <span class={clsx('min-w-0 truncate', props.class)} data-file-open={props.fileOpen ? '' : undefined}>
    <For each={props.parts}>
      {(p, i) => (
        <>
          <Show when={i() > 0}>{p.tone === 'code' ? '  ' : ' '}</Show>
          <Show when={p.tone === 'path'} fallback={<span class={TONE[p.tone as keyof typeof TONE]}>{p.text}</span>}>
            <PathText path={p.text} />
          </Show>
        </>
      )}
    </For>
  </span>
)

/** Lines a step added and removed, as a diff would count them. */
export const StepDiffCount: Component<{ added?: number; removed?: number }> = (props) => (
  <Show when={props.added || props.removed}>
    <span class="shrink-0 flex items-center gap-1.5 tabular-nums text-[11px]">
      <Show when={props.added}><span class="text-status-running">+{props.added}</span></Show>
      <Show when={props.removed}><span class="text-status-error">−{props.removed}</span></Show>
    </span>
  </Show>
)

/** A non-interactive step line: what a subagent did lately. */
export const StepLine: Component<{ kind: StepIconKind; parts: StepPart[]; running?: boolean; failed?: boolean }> = (props) => (
  <span class="flex items-center gap-2 min-w-0 h-5 text-[12px]">
    <StepIcon kind={props.kind} running={props.running} failed={props.failed} />
    <StepLabel parts={props.parts} />
  </span>
)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const SEP = '  ·  '

/** The ticking "Working for" of a running turn; the clock only runs while one is on screen. */
const LiveFor: Component<{ startedAt?: number }> = (props) => {
  const now = useNow()
  return <>{props.startedAt === undefined ? 'Working' : `Working for ${formatElapsed(now() - props.startedAt)}`}</>
}

/** A turn's work log under one row: how long it took (or is taking) and what it did. */
export const TurnFoldRow: Component<{ row: Extract<FoldRow, { kind: 'turn' }>; title?: string; onToggle: () => void }> = (props) => (
  <div style={{ 'padding-inline': 'var(--step-pad, 1.25rem)' }}>
    <button
      type="button"
      class="group/fold w-full flex items-center gap-2 h-7 text-left text-xs text-text-secondary hover:text-text-primary focus-visible:text-text-primary outline-none transition-colors"
      aria-expanded={props.row.open}
      title={props.title}
      onClick={props.onToggle}
    >
      <Show when={props.row.live}>
        <span class="w-3.5 shrink-0 flex items-center justify-center"><Loader2 size={13} class="animate-spin text-status-running" aria-hidden="true" /></span>
      </Show>
      <span class="shrink-0 whitespace-pre">
        <Show when={props.row.live} fallback={props.row.durationMs ? `Worked for ${formatElapsed(props.row.durationMs)}` : 'Worked'}>
          <LiveFor startedAt={props.row.startedAt} />
        </Show>
        <span class="text-text-muted">{[
          props.row.steps > 0 ? plural(props.row.steps, 'step', 'steps') : '',
          props.row.agents > 0 ? plural(props.row.agents, 'agent', 'agents') : '',
          props.row.edits > 0 ? plural(props.row.edits, 'edit', 'edits') : '',
        ].filter(Boolean).map(s => `${SEP}${s}`).join('')}</span>
        {/* Outcomes carry an icon as well as a color. */}
        <Show when={props.row.running > 0 && !props.row.live}>
          <span class="text-text-muted">{SEP}</span>
          <span class="inline-flex items-center gap-1 align-[-1px] text-status-running"><Loader2 size={11} class="animate-spin" aria-label="Still running" />{props.row.running} still running</span>
        </Show>
        <Show when={props.row.retried.length > 0}>
          <span class="text-text-muted">{SEP}</span>
          <span class="inline-flex items-center gap-1 align-[-1px] text-status-waiting">
            <RotateCcw size={11} aria-label="Fixed on retry" />
            {props.row.retried.length === 1 ? `${props.row.retried[0]} failed, then passed` : `${props.row.retried.length} steps failed, then passed`}
          </span>
        </Show>
        <Show when={props.row.failed > 0}>
          <span class="text-text-muted">{SEP}</span>
          <span class="inline-flex items-center gap-1 align-[-1px] text-status-error"><CircleX size={11} aria-label="Failed" />{props.row.failed} failed</span>
        </Show>
      </span>
      <ChevronRight size={14} class={clsx('shrink-0 text-text-muted group-hover/fold:text-text-secondary transition-transform duration-150', props.row.open && 'rotate-90')} aria-hidden="true" />
    </button>
  </div>
)

/** Older steps of the running turn, in one line. */
export const StepGroupRow: Component<{ row: Extract<FoldRow, { kind: 'group' }>; onToggle: () => void }> = (props) => (
  <div style={{ 'padding-inline': 'var(--step-pad, 1.25rem)' }}>
    <button
      type="button"
      class="group/step w-fit max-w-full flex items-center gap-2 py-[3px] px-1.5 -mx-1.5 rounded-md text-left text-[12.5px] leading-[18px] hover:bg-surface-1 focus-visible:ring-1 focus-visible:ring-accent/60 outline-none transition-colors"
      aria-expanded={props.row.open}
      onClick={props.onToggle}
    >
      <span class="w-3.5 shrink-0 flex items-center justify-center"><Layers size={13} class="text-text-dim" aria-hidden="true" /></span>
      <span class="min-w-0 truncate text-text-secondary">{props.row.label}</span>
      <Show when={props.row.failed > 0}><span class="shrink-0 text-[11px] text-status-error">{props.row.failed} failed</span></Show>
      <ChevronRight size={12} class={clsx('shrink-0 text-text-secondary transition-transform duration-150', props.row.open && 'rotate-90')} aria-hidden="true" />
    </button>
  </div>
)
