import { For, Show, createMemo, type Component } from 'solid-js'
import { LoaderCircle, SquareTerminal } from 'lucide-solid'
import type { AgentProgress, OutputItem, SessionStatus } from '../types'
import { agentAction, agentTypeLabel, formatElapsed, runningBackgroundTasks, taskElapsed, useNow } from '../lib/subagents'
import { agentsOnScreen, revealAgent } from './AgentBlockView'

const isShell = (t: AgentProgress) => t.taskType === 'local_bash'

/**
 * Above the composer while a turn has ended but Claude's subagents or
 * background shells keep running: one row per task. An agent row jumps to
 * its block in the transcript.
 */
export const AgentStrip: Component<{ status: SessionStatus | undefined; items: readonly OutputItem[] }> = (props) => (
  <Show when={props.status === 'background'}>
    <AgentStripRows items={props.items} />
  </Show>
)

const AgentStripRows: Component<{ items: readonly OutputItem[] }> = (props) => {
  const running = createMemo(() => runningBackgroundTasks(props.items))
  // An agent whose block is on screen isn't repeated here; shells always are.
  const listed = createMemo(() => running().filter(t => isShell(t) || !t.toolUseId || !agentsOnScreen().has(t.toolUseId)))
  const tasks = createMemo(() => new Map(listed().map(t => [t.taskId, t])))
  // Rows keyed by task id, so a progress update re-renders a row in place.
  const ids = createMemo(() => [...tasks().keys()], undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) })
  const now = useNow()
  return (
    <Show when={running().length === 0 || listed().length > 0}>
    <div
      role="status"
      aria-label="Running in background"
      title="Running in background. Claude picks up their results when they finish; you can keep chatting."
      class="mx-4 mb-2 rounded-md bg-surface-1 ring-1 ring-outline/8 text-xs overflow-hidden"
    >
      <Show
        when={ids().length > 0}
        fallback={
          <div class="px-3 py-1.5 flex items-center gap-2 text-[11px] text-text-muted">
            <LoaderCircle size={11} class="animate-spin text-status-running shrink-0" aria-hidden="true" />
            <span>Running in background</span>
          </div>
        }
      >
        <ul class="m-0 pl-0 py-0.5 list-none">
          <For each={ids()}>
            {(id) => {
              const task = tasks().get(id)!
              const t = () => tasks().get(id) ?? task
              const type = () => isShell(t()) ? 'shell' : agentTypeLabel(t().subagentType)
              // Just what it's doing now: the block above carries the counts.
              const activity = () => isShell(t()) ? '' : agentAction(t())
              const elapsed = () => {
                const ms = taskElapsed(t(), now())
                return ms === undefined ? '' : formatElapsed(ms)
              }
              const row = () => (
                <>
                  <Show when={isShell(t())} fallback={<LoaderCircle size={11} class="shrink-0 animate-spin text-status-running" aria-hidden="true" />}>
                    <SquareTerminal size={11} class="shrink-0 text-text-dim" aria-hidden="true" />
                  </Show>
                  {/* As in its block: the task leads, the agent type follows. */}
                  <span class="truncate text-text-primary">{t().description}</span>
                  <span class="shrink-0 text-[11px] text-text-muted">{type()}</span>
                  <Show when={activity()}>
                    <span class="hidden lg:inline min-w-0 truncate text-text-muted shrink-[4]">{activity()}</span>
                  </Show>
                  <Show when={elapsed()}>
                    <span class="ml-auto shrink-0 tabular-nums text-[11px] text-text-dim">{elapsed()}</span>
                  </Show>
                </>
              )
              const rowClass = 'w-full px-3 py-1 flex items-center gap-2 min-w-0 text-left'
              return (
                <li>
                  <Show when={!isShell(t()) && t().toolUseId} fallback={<div class={rowClass}>{row()}</div>}>
                    <button
                      type="button"
                      class={`${rowClass} rounded-sm hover:bg-surface-2 outline-none focus-visible:ring-1 focus-visible:ring-accent/60`}
                      aria-label={`Show ${type()}: ${t().description ?? ''}`}
                      onClick={() => revealAgent(t().toolUseId!)}
                    >
                      {row()}
                    </button>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </div>
    </Show>
  )
}
