import { For, Show, createMemo, createSignal, createEffect, on, onCleanup, untrack, type Component, type JSX } from 'solid-js'
import { clsx } from 'clsx'
import { LoaderCircle, CircleCheck, CircleStop, TriangleAlert, MessageCircleQuestion, ChevronRight, Ellipsis } from 'lucide-solid'
import type { AgentBlock } from './ChatView'
import { StepLine, type StepIconKind } from './Steps'
import { describeStep, type StepPart } from '../lib/steps'
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

// Agent blocks on screen, by tool use id: the strip above the composer
// doesn't repeat an agent you can already see.
const [onScreen, setOnScreen] = createSignal<ReadonlySet<string>>(new Set())
export const agentsOnScreen = onScreen
export function setAgentOnScreen(toolUseId: string, visible: boolean) {
  if (onScreen().has(toolUseId) === visible) return
  const next = new Set(onScreen())
  if (visible) next.add(toolUseId)
  else next.delete(toolUseId)
  setOnScreen(next)
}

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
          when={props.state === 'failed'}
          fallback={
            <Show
              when={props.state === 'needs-input'}
              fallback={
                <Show
                  when={props.state === 'stopped'}
                  fallback={<LoaderCircle size={size()} class="shrink-0 animate-spin text-status-running" aria-hidden="true" />}
                >
                  <CircleStop size={size()} class="shrink-0 text-text-dim" aria-hidden="true" />
                </Show>
              }
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

export type AgentChild = AgentBlock['children'][number]
const parse = (input: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(input)
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

/** One of the agent's steps as a plain line, when the transcript doesn't render its rows. */
function childLine(child: AgentChild, live: boolean, roots?: readonly string[]): { kind: StepIconKind; parts: StepPart[]; running?: boolean; failed?: boolean } {
  if (child.type === 'tool') {
    const s = describeStep(child.tool, parse(child.input), roots)
    return { kind: s.kind, parts: s.parts, running: !child.result && live, failed: !!child.result?.isError }
  }
  if (child.type === 'thinking') return { kind: 'thinking', parts: [{ text: 'Thought', tone: 'verb' }, { text: firstLine(child.text), tone: 'dim' }] }
  return { kind: 'message', parts: [{ text: firstLine(child.text), tone: 'verb' }] }
}

/** How many of a running agent's latest steps show under its header. */
const TAIL = 3
// Its step rows sit on the card's padding, and pin under nothing inside it.
const STEP_VARS = { '--step-pad': '0.625rem', '--sticky-top': '0px', '--sticky-bg': 'var(--surface-1)' }

/**
 * A Claude subagent in the transcript: one quiet panel with its task, status
 * and latest steps, opening to its whole log in a pane of its own and its report.
 */
export const AgentBlockView: Component<{
  block: AgentBlock
  /** One of its tools is waiting for approval. */
  needsInput?: boolean
  /** The session is still working, so an agent without progress data may be running. */
  sessionLive?: boolean
  /** One of the subagent's steps, rendered as the transcript renders steps. */
  renderChild?: (child: AgentChild) => JSX.Element
  /** The subagent's own actions, when no `renderChild` is given. */
  children?: JSX.Element
  /** Neighbouring agents of the same dispatch: render as one grouped list, not separate boxes. */
  joinPrev?: boolean
  joinNext?: boolean
  /** Folders its steps' paths are shown relative to. */
  roots?: readonly string[]
}> = (props) => {
  const status = createMemo(() => agentState({
    progress: props.block.progress,
    result: props.block.result,
    needsInput: props.needsInput,
    sessionLive: props.sessionLive,
  }))
  const finished = () => ['done', 'failed', 'stopped'].includes(status().state)
  const working = () => !finished()
  const [expanded, setExpanded] = createSignal(expandedAgents.get(props.block.id) ?? false)
  const setExp = (v: boolean) => {
    setExpanded(v)
    expandedAgents.set(props.block.id, v)
  }

  const now = useNow()
  const elapsed = () => {
    // Only a running agent ticks with the clock.
    const ms = taskElapsed(props.block.progress, finished() ? 0 : now())
    return ms === undefined ? '' : formatElapsed(ms)
  }
  const type = () => agentTypeLabel(props.block.subagentType)
  const finalText = () => agentFinalText(props.block.progress, props.block.result)
  // While it works: its latest steps. Done: its result, or why it stopped.
  const tail = createMemo(() => working() ? props.block.children.slice(-TAIL) : [])
  const earlier = () => props.block.children.length - tail().length
  const detail = () => {
    const s = status()
    if (s.state === 'done') return firstLine(finalText())
    if (s.state === 'failed' || s.state === 'stopped') return firstLine(props.block.progress?.error || finalText())
    if (s.starting) return 'Starting'
    return props.block.progress ? agentActivityLine(props.block.progress) : ''
  }
  const row = (child: AgentChild) => {
    if (props.renderChild) return props.renderChild(child)
    const line = createMemo(() => childLine(child, !!props.sessionLive || working(), props.roots))
    return (
      <div style={{ 'padding-inline': 'var(--step-pad)' }}>
        <StepLine kind={line().kind} parts={line().parts} running={line().running} failed={line().failed} />
      </div>
    )
  }

  let root: HTMLDivElement | undefined
  let pane: HTMLDivElement | undefined
  // The log reads from the newest step; it follows new steps while you're at its end.
  let followPane = true
  const toEnd = () => { if (pane) pane.scrollTop = pane.scrollHeight }
  createEffect(on(() => props.block.children.length, () => { if (followPane) toEnd() }, { defer: true }))

  // Whether this block is on screen, for the strip above the composer.
  const watch = (el: HTMLDivElement) => {
    root = el
    const id = props.block.toolUseId
    if (!id || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setAgentOnScreen(id, entry.isIntersecting))
    io.observe(el)
    onCleanup(() => { io.disconnect(); setAgentOnScreen(id, false) })
  }

  /** Open or close while the block's bottom edge stays where it is: it grows upward. */
  const setOpen = (open: boolean) => {
    const scroller = root?.closest<HTMLElement>('[data-chat-scroll]')
    const before = root?.getBoundingClientRect().bottom
    setExp(open)
    if (open) { followPane = true; toEnd() }
    if (scroller && root && before !== undefined) scroller.scrollTop += root.getBoundingClientRect().bottom - before
  }
  // A finished agent folds back to its result line. Toggling it afterwards sticks.
  let wasFinished = untrack(finished)
  createEffect(() => {
    const done = finished()
    if (done && !wasFinished && untrack(expanded)) setOpen(false)
    wasFinished = done
  })
  const label = () => [props.block.description, type(), AGENT_STATE_LABEL[status().state], elapsed()].filter(Boolean).join(', ')

  return (
    <div class={clsx('px-5', props.joinPrev ? 'pt-0 -mt-px' : 'pt-1', props.joinNext ? 'pb-0' : 'pb-1')}>
      <div
        ref={watch}
        data-agent-id={props.block.toolUseId}
        data-highlighted={highlighted() === props.block.toolUseId && !!props.block.toolUseId ? 'true' : undefined}
        class={clsx(
          'bg-surface-1 ring-1 transition-shadow duration-300',
          props.joinPrev && props.joinNext ? 'rounded-none'
            : props.joinPrev ? 'rounded-md rounded-t-none'
            : props.joinNext ? 'rounded-md rounded-b-none'
            : 'rounded-md',
          highlighted() === props.block.toolUseId && props.block.toolUseId ? 'ring-accent/60' : 'ring-outline/8',
        )}
      >
        <button
          type="button"
          class={clsx(
            'group/agent w-full text-left px-2.5 py-1.5 flex flex-col gap-1 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
            expanded() && 'rounded-b-none',
          )}
          aria-expanded={expanded()}
          aria-label={label()}
          onClick={() => setOpen(!expanded())}
        >
          <span class="w-full flex items-center gap-2 text-xs min-w-0">
            <span class="w-3.5 shrink-0 flex items-center justify-center"><AgentStatusIcon state={status().state} /></span>
            <Show when={props.block.description}>
              <span class="min-w-0 truncate text-text-primary">{props.block.description}</span>
            </Show>
            <span class="shrink-0 text-[11px] text-text-muted">{type()}</span>
            <span class="ml-auto shrink-0 flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span class={clsx(status().state === 'failed' && 'text-status-error')}>{AGENT_STATE_LABEL[status().state]}</span>
              <Show when={elapsed()}>
                <span aria-hidden="true">·</span>
                <span class="tabular-nums">{elapsed()}</span>
              </Show>
              <ChevronRight size={12} class={clsx('text-text-muted transition-transform duration-150', expanded() && 'rotate-90')} aria-hidden="true" />
            </span>
          </span>
          <Show when={!expanded() && tail().length === 0 && detail()}>
            <span class={clsx('pl-[22px] truncate text-[11px]', status().state === 'failed' ? 'text-status-error/80' : 'text-text-muted')}>
              {detail()}
            </span>
          </Show>
        </button>
        {/* Running: its latest steps, the same rows as its opened log. */}
        <Show when={!expanded() && tail().length > 0}>
          <div class="pb-1.5" style={STEP_VARS}>
            <Show when={earlier() > 0}>
              <div style={{ 'padding-inline': 'var(--step-pad)' }}>
                <button
                  type="button"
                  class="w-fit max-w-full flex items-center gap-2 py-[3px] px-1.5 -mx-1.5 rounded-md text-left text-[12px] leading-[18px] text-text-secondary hover:bg-surface-2 hover:text-text-primary focus-visible:ring-1 focus-visible:ring-accent/60 outline-none transition-colors"
                  onClick={() => setOpen(true)}
                >
                  <span class="w-3.5 shrink-0 flex items-center justify-center"><Ellipsis size={13} class="text-text-muted" aria-hidden="true" /></span>
                  {earlier()} earlier {earlier() === 1 ? 'step' : 'steps'}
                </button>
              </div>
            </Show>
            <For each={tail()}>{row}</For>
          </div>
        </Show>
        <Show when={expanded()}>
          <div class="border-t-1 border-t-solid border-t-outline/8">
            <div
              ref={(el) => { pane = el; requestAnimationFrame(toEnd) }}
              role="log"
              aria-label={`${props.block.description || type()} steps`}
              class="max-h-[280px] overflow-y-auto overscroll-contain py-1"
              style={STEP_VARS}
              onScroll={(e) => {
                const el = e.currentTarget
                followPane = el.scrollHeight - el.scrollTop - el.clientHeight < 24
              }}
            >
              <Show when={props.renderChild} fallback={props.children}>
                <For each={props.block.children}>{row}</For>
              </Show>
            </div>
            <Show when={finished() && finalText()}>
              <div class="mx-2.5 py-1.5 border-t-1 border-t-solid border-t-outline/8">
                <div class="text-[10px] uppercase tracking-wide text-text-dim mb-0.5">Report</div>
                <pre class="text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto select-text">{finalText()}</pre>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
