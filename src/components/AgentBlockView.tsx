import { Show, createMemo, createSignal, createEffect, untrack, type Component, type JSX } from 'solid-js'
import { clsx } from 'clsx'
import { LoaderCircle, CircleCheck, TriangleAlert, MessageCircleQuestion, ChevronRight, ChevronDown } from 'lucide-solid'
import type { AgentBlock } from './ChatView'
import {
  AGENT_STATE_LABEL,
  agentActivityLine,
  agentTypeLabel,
  agentFinalText,
  agentState,
  formatElapsed,
  taskElapsed,
  useNow,
  type AgentStateKind,
} from '../lib/subagents'

// Expansion survives block re-renders and rebuilds; keyed by the block's UI id.
const expandedAgents = new Map<string, boolean>()

// The agent block the strip last pointed at, briefly highlighted.
const [highlighted, setHighlighted] = createSignal<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined

/** Scroll the transcript to an agent's block and briefly highlight it. */
export function revealAgent(toolUseId: string) {
  const el = [...document.querySelectorAll('[data-agent-id]')].find(e => e.getAttribute('data-agent-id') === toolUseId)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setHighlighted(toolUseId)
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => setHighlighted(null), 1600)
}

export const AgentStatusIcon: Component<{ state: AgentStateKind; size?: number }> = (props) => {
  const size = () => props.size ?? 12
  return (
    <Show
      when={props.state === 'done'}
      fallback={
        <Show
          when={props.state === 'failed' || props.state === 'stopped'}
          fallback={
            <Show
              when={props.state === 'needs-input'}
              fallback={<LoaderCircle size={size()} class="shrink-0 animate-spin text-status-running" aria-hidden="true" />}
            >
              <MessageCircleQuestion size={size()} class="shrink-0 text-status-waiting" aria-hidden="true" />
            </Show>
          }
        >
          <TriangleAlert size={size()} class="shrink-0 text-status-error" aria-hidden="true" />
        </Show>
      }
    >
      <CircleCheck size={size()} class="shrink-0 text-status-done" aria-hidden="true" />
    </Show>
  )
}

const firstLine = (s: string | undefined) => (s ?? '').trim().split('\n')[0] ?? ''

/**
 * A Claude subagent in the transcript: one quiet panel with its status, task
 * and live progress, expanding to its own actions and final report.
 */
export const AgentBlockView: Component<{
  block: AgentBlock
  /** One of its tools is waiting for approval. */
  needsInput?: boolean
  /** The session is still working, so an agent without progress data may be running. */
  sessionLive?: boolean
  /** The subagent's own actions, rendered by the transcript. */
  children?: JSX.Element
}> = (props) => {
  const status = createMemo(() => agentState({
    progress: props.block.progress,
    result: props.block.result,
    needsInput: props.needsInput,
    sessionLive: props.sessionLive,
  }))
  const finished = () => ['done', 'failed', 'stopped'].includes(status().state)
  const [expanded, setExpanded] = createSignal(expandedAgents.get(props.block.id) ?? false)
  const setExp = (v: boolean) => {
    setExpanded(v)
    expandedAgents.set(props.block.id, v)
  }
  // A finished agent folds back to its result line. Toggling it afterwards sticks.
  let wasFinished = untrack(finished)
  createEffect(() => {
    const done = finished()
    if (done && !wasFinished) setExp(false)
    wasFinished = done
  })

  const now = useNow()
  const elapsed = () => {
    // Only a running agent ticks with the clock.
    const ms = taskElapsed(props.block.progress, finished() ? 0 : now())
    return ms === undefined ? '' : formatElapsed(ms)
  }
  const type = () => agentTypeLabel(props.block.subagentType)
  const finalText = () => agentFinalText(props.block.progress, props.block.result)

  const detail = () => {
    const s = status()
    if (s.state === 'done') return firstLine(finalText())
    if (s.state === 'failed' || s.state === 'stopped') {
      const reason = firstLine(props.block.progress?.error || finalText())
      return reason
    }
    if (s.starting) return 'Starting'
    return props.block.progress ? agentActivityLine(props.block.progress) : ''
  }
  const label = () => [type(), props.block.description, AGENT_STATE_LABEL[status().state], elapsed()].filter(Boolean).join(', ')

  return (
    <div class="px-5 py-1">
      <div
        data-agent-id={props.block.toolUseId}
        data-highlighted={highlighted() === props.block.toolUseId && !!props.block.toolUseId ? 'true' : undefined}
        class={clsx(
          'rounded-md bg-surface-1 ring-1 transition-shadow duration-300',
          highlighted() === props.block.toolUseId && props.block.toolUseId ? 'ring-accent/60' : 'ring-outline/8',
        )}
      >
        <button
          type="button"
          class="w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
          aria-expanded={expanded()}
          aria-label={label()}
          onClick={() => setExp(!expanded())}
        >
          <span class="w-full flex items-center gap-1.5 text-xs min-w-0">
            <Show when={expanded()} fallback={<ChevronRight size={11} class="shrink-0 text-text-dim" aria-hidden="true" />}>
              <ChevronDown size={11} class="shrink-0 text-text-dim" aria-hidden="true" />
            </Show>
            <AgentStatusIcon state={status().state} />
            <span class="shrink-0 font-mono text-[11px] text-text-secondary">{type()}</span>
            <Show when={props.block.description}>
              <span class="truncate text-text-primary">{props.block.description}</span>
            </Show>
            <span class="ml-auto shrink-0 flex items-center gap-1.5 text-[11px] text-text-dim">
              <span>{AGENT_STATE_LABEL[status().state]}</span>
              <Show when={elapsed()}>
                <span aria-hidden="true">·</span>
                <span class="tabular-nums">{elapsed()}</span>
              </Show>
            </span>
          </span>
          <Show when={detail()}>
            <span
              class={clsx(
                'pl-[29px] truncate text-[11px]',
                status().state === 'failed' || status().state === 'stopped' ? 'text-status-error/80' : 'text-text-muted',
              )}
            >
              {detail()}
            </span>
          </Show>
        </button>
        <Show when={expanded()}>
          <div class="pb-1.5">
            {props.children}
            <Show when={finished() && finalText()}>
              <div class="mx-2.5 mt-1 pt-1.5 border-t-1 border-t-solid border-t-outline/8">
                <div class="text-[10px] uppercase tracking-wide text-text-dim mb-0.5">Report</div>
                <pre class="text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto select-text">{finalText()}</pre>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
