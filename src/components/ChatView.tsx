import { Component, For, Show, Switch, Match, batch, createEffect, on, createSignal, onMount, onCleanup } from 'solid-js'
import { createStore, produce, reconcile, unwrap } from 'solid-js/store'
import { clsx } from 'clsx'
import { renderMarkdown, handleMarkdownLinkClick, getWorktreePath } from '../lib/markdown'
import type { OutputItem, SessionStatus, AttachmentRef } from '../types'
import { ChevronDown, ChevronRight, AlertTriangle, Copy, Check, ArrowUp, ArrowDown, X, GitBranch, RotateCw, Plus, ChevronUp, MessageCircleQuestion, Loader2, Sparkles } from 'lucide-solid'
import { FileMentionBadge } from './FileMentionBadge'
import { ImageViewer } from './ImageViewer'
import { BlobImage } from './BlobImage'
import { FileChip } from './FileChip'
import { Popover } from './Popover'
import { parseMentions } from '../lib/mentions'
import * as ipc from '../lib/ipc'
import {
  dismissSideQuestionUnread,
  openSideQuestion,
  sideQuestionPanel,
  sideQuestionState,
} from '../store/sideQuestion'
import { addToast, setSelectedTaskId, setSelectedSessionIdForTask } from '../store/ui'
import { sessionById, setSessions, loadOutputLines, loadOlderOutputLines, hasMoreOutputLines, sendMessage } from '../store/sessions'
import { planModeForSession, thinkingModeForSession, fastModeForSession } from '../store/sessionContext'
import { taskById, setTasks } from '../store/tasks'
import { formatCost, formatTokens } from '../lib/format'
import { failureText } from '../lib/accountErrors'
import { inheritedSelection } from '../lib/accounts'
import { openNewSession } from '../lib/newSession'

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function formatTokensWithCache(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  const inPart = t.input ? `${formatTokens(t.input)} in` : ''
  const outPart = t.output ? `${formatTokens(t.output)} out` : ''
  const cacheParts: string[] = []
  if (t.cacheRead) cacheParts.push(`${formatTokens(t.cacheRead)} read`)
  if (t.cacheWrite) cacheParts.push(`${formatTokens(t.cacheWrite)} write`)
  const cacheStr = cacheParts.length ? ` (${cacheParts.join(', ')} cached)` : ''
  return [inPart, outPart].filter(Boolean).join(' / ') + cacheStr
}

function renderMarkdownForTask(text: string, taskId?: string): string {
  return renderMarkdown(text, getWorktreePath(taskId))
}

interface Props {
  output: OutputItem[]
  sessionStatus?: SessionStatus
  sessionId?: string | null
  taskId?: string
  agentType?: string
  model?: string | null
}

// ---------------------------------------------------------------------------
// Stable block store — only mutates existing blocks or appends new ones
// ---------------------------------------------------------------------------

interface UserBlock {
  type: 'user'
  text: string
  images?: AttachmentRef[]
  files?: AttachmentRef[]
}
interface AssistantBlock {
  type: 'assistant'
  text: string
  durationMs?: number
  turnCost?: number
  turnTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  isLastInTurn?: boolean
  isStreaming?: boolean
  /** On-disk message uuid attached at turn end via verun_turn_snapshot. Used as the fork point. */
  messageUuid?: string
}
interface ThinkingBlock {
  type: 'thinking'
  id: string
  text: string
}
interface ToolBlock {
  type: 'tool'
  id: string
  tool: string
  input: string
  result: { text: string; isError: boolean } | undefined
}
interface SystemBlock {
  type: 'system'
  text: string
}
/**
 * Scheduled wakeup marker. Replaces the user bubble for turns Verun (or the
 * CLI) synthesised in response to a `ScheduleWakeup` tool call - the prompt
 * is the model's own note-to-self, not a human message. (issue #230)
 */
interface WakeupBlock {
  type: 'wakeup'
  prompt: string
  reason?: string
}
interface ErrorBlock {
  type: 'error'
  message: string
  raw?: string
  /** Turn marker so retry picks the right user message. */
  turnIndex: number
  /** The user message that started this turn, resent by retry. */
  retryText?: string
  /** Whether the turn produced assistant work (text, thinking, tools) before
   *  the error - retry then says "continue" instead of redoing everything. */
  hasProgress: boolean
}
interface PlanBlock {
  type: 'plan'
  items: Array<{ status: string; step: string }>
  explanation?: string
}
interface DiffBlock {
  type: 'diff'
  diff: string
}
type DisplayBlock = UserBlock | AssistantBlock | ThinkingBlock | ToolBlock | SystemBlock | WakeupBlock | ErrorBlock | PlanBlock | DiffBlock

export interface BlockBuilder {
  /** Blocks built so far. Owned by the builder - copy before handing to a store. */
  readonly blocks: DisplayBlock[]
  /** True when `items` is the array this builder has been fed, grown only at
   *  the end. False after a replace, shrink or prepend: rebuild from scratch. */
  canExtend(items: readonly OutputItem[]): boolean
  /** Fold in `items` past those already seen. Returns the indexes of blocks
   *  that were added or changed. */
  append(items: readonly OutputItem[]): Set<number>
}

/**
 * Builds display blocks from output items incrementally, so a streaming flush
 * costs the items it adds, not the whole transcript. Feeding a transcript in
 * any number of appends yields the same blocks as feeding it once.
 */
export function createBlockBuilder(): BlockBuilder {
  const blocks: DisplayBlock[] = []
  let seen = 0
  let firstItem: OutputItem | undefined
  let lastItem: OutputItem | undefined
  let dirty = new Set<number>()

  // The assistant/thinking block that consecutive deltas extend. Always the last block.
  let openText: AssistantBlock | null = null
  let openThinking: ThinkingBlock | null = null
  let toolCounter = 0
  let thinkingCounter = 0
  let turnStartTs: number | undefined
  let turnIndex = 0
  let turnUserText: string | undefined
  let turnProgress = false
  // Track whether this turn has already produced an error block so we can
  // drop the duplicate turnEnd-derived bubble (synthetic assistant + result
  // both carry the same provider error).
  let turnHasError = false
  let planIdx = -1
  let diffIdx = -1
  // The in-progress turn's last assistant block is marked streaming at the
  // end of each append; undone before the next one so later items see the
  // blocks as a full rebuild would.
  let streamingMark: { index: number; isLastInTurn?: boolean; isStreaming?: boolean } | null = null

  const push = (b: DisplayBlock) => {
    blocks.push(b)
    dirty.add(blocks.length - 1)
  }
  const touch = (b: DisplayBlock) => {
    // Mutated blocks are near the end; search backwards.
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i] === b) { dirty.add(i); return }
    }
  }
  const flushText = () => { openText = null }
  const flushThinking = () => { openThinking = null }
  const startTurn = (text: string) => {
    flushText(); flushThinking()
    turnIndex += 1
    turnHasError = false
    turnUserText = text
    turnProgress = false
  }

  const lastOpenTool = (): ToolBlock | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'tool' && !b.result) return b
      if (b.type !== 'tool') break
    }
    return undefined
  }

  const setFlag = (b: AssistantBlock, key: 'isLastInTurn' | 'isStreaming', value: boolean | undefined) => {
    if (value === undefined) delete b[key]
    else b[key] = value
  }

  const fold = (item: OutputItem) => {
    switch (item.kind) {
      case 'text':
        flushThinking()
        turnProgress = true
        if (openText) {
          openText.text += item.text
          dirty.add(blocks.length - 1)
        } else if (item.text) {
          openText = { type: 'assistant', text: item.text }
          push(openText)
        }
        break
      case 'thinking':
        flushText()
        turnProgress = true
        if (openThinking) {
          openThinking.text += item.text
          dirty.add(blocks.length - 1)
        } else if (item.text) {
          openThinking = { type: 'thinking', id: `thinking-${thinkingCounter++}`, text: item.text }
          push(openThinking)
        }
        break
      case 'userMessage':
        startTurn(item.text)
        turnStartTs = item.timestamp
        if (item.wakeupReason !== undefined) {
          push({ type: 'wakeup', prompt: item.text, reason: item.wakeupReason || undefined })
        } else {
          push({ type: 'user', text: item.text, images: item.images, files: item.files })
        }
        break
      case 'transcriptUserMessage':
        startTurn(item.text)
        if (item.isMeta) {
          push({ type: 'wakeup', prompt: item.text })
        } else {
          push({ type: 'user', text: item.text })
        }
        break
      case 'errorMessage':
        flushText(); flushThinking()
        push({ type: 'error', message: item.message, raw: item.raw, turnIndex, retryText: turnUserText, hasProgress: turnProgress })
        turnHasError = true
        break
      case 'toolStart': {
        turnProgress = true
        // Hide ExitPlanMode from the chat — it's shown as a dedicated plan overlay
        if (item.tool === 'ExitPlanMode') break
        flushText(); flushThinking()
        // Deduplicate: if the last block is an open tool with the same name AND same input,
        // it's a duplicate from control_request + content_block_start. Merge it.
        // But if inputs differ, it's a parallel call of the same tool — keep both.
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'tool' && !lastBlock.result && lastBlock.tool === item.tool
            && (!item.input || !lastBlock.input || item.input === lastBlock.input)) {
          if (item.input && !lastBlock.input) {
            lastBlock.input = item.input
            dirty.add(blocks.length - 1)
          }
        } else {
          push({ type: 'tool', id: `tool-${toolCounter++}`, tool: item.tool, input: item.input, result: undefined })
        }
        break
      }
      case 'toolResult': {
        turnProgress = true
        flushText(); flushThinking()
        const openTool = lastOpenTool()
        if (openTool) {
          openTool.result = { text: item.text, isError: item.isError }
          touch(openTool)
        } else {
          push({ type: 'tool', id: `tool-${toolCounter++}`, tool: 'Tool', input: '', result: { text: item.text, isError: item.isError } })
        }
        break
      }
      case 'system':
        flushText(); flushThinking()
        push({ type: 'system', text: item.text })
        break
      case 'turnEnd': {
        flushText(); flushThinking()
        const durationMs = (turnStartTs && item.timestamp) ? item.timestamp - turnStartTs : undefined
        const turnCost = item.cost
        const turnTokens = (item.inputTokens || item.outputTokens)
          ? { input: item.inputTokens || 0, output: item.outputTokens || 0, cacheRead: item.cacheReadTokens || 0, cacheWrite: item.cacheWriteTokens || 0 }
          : undefined
        // Mark the last assistant block in this turn
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b.type === 'assistant') {
            b.isLastInTurn = true
            if (durationMs) b.durationMs = durationMs
            if (turnCost) b.turnCost = turnCost
            if (turnTokens) b.turnTokens = turnTokens
            dirty.add(i)
            break
          }
          if (b.type === 'user' || b.type === 'wakeup') break
        }
        // Render rules:
        //   - completed         → no bubble (happy path)
        //   - interrupted       → no bubble (user already hit stop)
        //   - error + message   → one error block per turn (de-duped — the
        //                         synthetic assistant already produced one)
        //   - other non-success → show the status as a system bubble
        if (item.error) {
          if (!turnHasError) {
            push({ type: 'error', message: item.error, raw: undefined, turnIndex, retryText: turnUserText, hasProgress: turnProgress })
            turnHasError = true
          }
        } else if (item.status !== 'completed' && item.status !== 'interrupted') {
          push({ type: 'system', text: `Turn ended: ${item.status}` })
        }
        turnStartTs = undefined
        break
      }
      case 'turnSnapshot': {
        // Attach the message uuid to the most recent assistant block, walking
        // back past tools/thinking. This is the stable id for "fork from here".
        // Text still streaming into an open block isn't part of the finished
        // message, so skip it.
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b === openText || b === openThinking) continue
          if (b.type === 'assistant') {
            b.messageUuid = item.messageUuid
            dirty.add(i)
            break
          }
          if (b.type === 'user' || b.type === 'wakeup') break
        }
        break
      }
      case 'planUpdate': {
        flushText(); flushThinking()
        const existing = planIdx >= 0 ? blocks[planIdx] as PlanBlock : undefined
        if (existing) {
          existing.items = item.items
          if (item.explanation) existing.explanation = item.explanation
          dirty.add(planIdx)
        } else {
          push({ type: 'plan', items: item.items, explanation: item.explanation })
          planIdx = blocks.length - 1
        }
        break
      }
      case 'diffUpdate': {
        flushText(); flushThinking()
        const existing = diffIdx >= 0 ? blocks[diffIdx] as DiffBlock : undefined
        if (existing) {
          existing.diff = item.diff
          dirty.add(diffIdx)
        } else {
          push({ type: 'diff', diff: item.diff })
          diffIdx = blocks.length - 1
        }
        break
      }
      case 'codexPlanDelta':
      case 'codexPlanReady':
        // Codex plan-mode content lives in the floating plan viewer, not the
        // chat transcript. `sessions.ts` routes these into
        // `codexLivePlans` / `planFilePathForSession` instead.
        break
      case 'raw':
        break
    }
  }

  return {
    blocks,
    canExtend(items) {
      if (items.length < seen) return false
      if (seen === 0) return true
      return items[0] === firstItem && items[seen - 1] === lastItem
    },
    append(items) {
      dirty = new Set()
      if (items.length <= seen) return dirty
      if (streamingMark) {
        const b = blocks[streamingMark.index] as AssistantBlock
        setFlag(b, 'isLastInTurn', streamingMark.isLastInTurn)
        setFlag(b, 'isStreaming', streamingMark.isStreaming)
        dirty.add(streamingMark.index)
        streamingMark = null
      }
      for (let i = seen; i < items.length; i++) fold(items[i])
      if (seen === 0) firstItem = items[0]
      seen = items.length
      lastItem = items[seen - 1]
      // Mark the last assistant block in an in-progress turn (no turnEnd yet)
      if (turnStartTs !== undefined) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b.type === 'assistant') {
            streamingMark = { index: i, isLastInTurn: b.isLastInTurn, isStreaming: b.isStreaming }
            b.isLastInTurn = true
            b.isStreaming = true
            dirty.add(i)
            break
          }
          if (b.type === 'user' || b.type === 'wakeup') break
        }
      }
      return dirty
    },
  }
}

export function rebuildBlocks(items: readonly OutputItem[]): DisplayBlock[] {
  const builder = createBlockBuilder()
  builder.append(items)
  return builder.blocks
}

/** A copy of `b` sharing nothing mutable with the builder, safe to reconcile into a store. */
function cloneBlock(b: DisplayBlock): DisplayBlock {
  switch (b.type) {
    case 'tool': return { ...b, result: b.result && { ...b.result } }
    case 'assistant': return { ...b, turnTokens: b.turnTokens && { ...b.turnTokens } }
    case 'plan': return { ...b, items: b.items.map(s => ({ ...s })) }
    default: return { ...b }
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const CopyButton: Component<{ text: string }> = (props) => {
  const [copied, setCopied] = createSignal(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(props.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      class="p-1 rounded-md text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
      onClick={handleCopy}
      title="Copy"
    >
      <Show when={copied()} fallback={<Copy size={13} />}>
        <Check size={13} class="text-status-running" />
      </Show>
    </button>
  )
}

export const ForkButton: Component<{ sessionId: string; messageUuid: string }> = (props) => {
  const canForkWorktree = () => {
    const task = taskById(sessionById(props.sessionId)?.taskId ?? '')
    return task?.isGit !== false && !task?.existingDirectory
  }
  const [open, setOpen] = createSignal(false)
  const [submenuOpen, setSubmenuOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const close = () => {
    setOpen(false)
    setSubmenuOpen(false)
    setError(null)
  }

  const forkInTask = async () => {
    setBusy(true)
    try {
      const session = await ipc.forkSessionInTask(props.sessionId, props.messageUuid)
      setSessions(produce(s => { if (!s.find(x => x.id === session.id)) s.push(session) }))
      await loadOutputLines(session.id)
      setSelectedSessionIdForTask(session.taskId, session.id)
      addToast('Forked in this task', 'success')
      close()
    } catch (e) {
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  const forkToNewTask = async (worktreeState: 'snapshot' | 'current') => {
    setBusy(true)
    try {
      const tws = await ipc.forkSessionToNewTask(props.sessionId, props.messageUuid, worktreeState)
      setTasks(produce(t => { if (!t.find(x => x.id === tws.task.id)) t.unshift(tws.task) }))
      setSessions(produce(s => { if (!s.find(x => x.id === tws.session.id)) s.push(tws.session) }))
      await loadOutputLines(tws.session.id)
      setSelectedTaskId(tws.task.id)
      setSelectedSessionIdForTask(tws.task.id, tws.session.id)
      addToast('Forked to new task', 'success')
      close()
    } catch (e) {
      // A project whose accounts can't be read fails the fork with an account
      // error: the menu says so in words, with the account toast.
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="relative">
      <button
        class="p-1 rounded-md text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
        onClick={() => setOpen(o => !o)}
        title="Fork from this message"
        disabled={busy()}
      >
        <GitBranch size={13} />
      </button>
      <Popover
        open={open()}
        onClose={close}
        class="py-1 min-w-44 absolute bottom-full left-0 mb-1"
      >
        <button
          class="w-full flex items-center gap-2 text-left px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-35 disabled:pointer-events-none"
          disabled={busy()}
          onMouseEnter={() => setSubmenuOpen(false)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={forkInTask}
        >
          <span class="flex-1 truncate">Fork in this task</span>
        </button>
        <div
          class="relative"
          style={{ display: canForkWorktree() ? undefined : 'none' }}
          onMouseEnter={() => setSubmenuOpen(true)}
        >
          <button
            class="w-full flex items-center gap-2 text-left px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-35 disabled:pointer-events-none"
            disabled={busy()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSubmenuOpen(v => !v)}
          >
            <span class="flex-1 truncate">Fork in a new task</span>
            <ChevronRight size={11} class="text-text-dim shrink-0" />
          </button>
          <Show when={submenuOpen()}>
            <div
              class="absolute -top-1 left-[calc(100%-4px)] py-1 min-w-48 bg-surface-2 ring-1 ring-outline/8 rounded-md shadow-xl animate-in"
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                class="w-full flex items-center gap-2 text-left px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-35 disabled:pointer-events-none"
                disabled={busy()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => forkToNewTask('snapshot')}
              >
                <span class="flex-1 truncate">Code as of this message</span>
              </button>
              <button
                class="w-full flex items-center gap-2 text-left px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-35 disabled:pointer-events-none"
                disabled={busy()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => forkToNewTask('current')}
              >
                <span class="flex-1 truncate">Current code</span>
              </button>
            </div>
          </Show>
        </div>
        <Show when={error()}>
          <div class="mt-1 px-2.5 py-1 text-[10px] text-status-error border-t border-outline/8">{error()}</div>
        </Show>
      </Popover>
    </div>
  )
}

const ThinkingBlockView: Component<{ id: string; text: string }> = (props) => {
  const [expanded, setExpanded] = createSignal(expandedThinking.get(props.id) ?? false)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    expandedThinking.set(props.id, next)
  }
  return (
    <div class="px-5 py-1">
      <div class="flex-1 min-w-0">
        <button
          class="flex items-center gap-1.5 text-xs text-text-dim hover:text-text-muted transition-colors"
          onClick={toggle}
        >
          <Show when={expanded()} fallback={<ChevronRight size={11} />}>
            <ChevronDown size={11} />
          </Show>
          <span class="italic">Thinking</span>
          <Show when={!expanded()}>
            <span class="text-text-dim/60 truncate max-w-sm">
              — {props.text.split('\n')[0].slice(0, 80)}
            </span>
          </Show>
        </button>
        <Show when={expanded()}>
          <pre
            class="text-xs text-text-dim whitespace-pre-wrap font-mono leading-relaxed mt-1.5 max-h-60 overflow-y-auto pl-4 border-l border-border-subtle"
            ref={(el) => {
              const saved = thinkingScrollPositions.get(props.id)
              if (saved) requestAnimationFrame(() => { el.scrollTop = saved })
            }}
            onScroll={(e) => {
              thinkingScrollPositions.set(props.id, e.currentTarget.scrollTop)
            }}
          >
            {props.text}
          </pre>
        </Show>
      </div>
    </div>
  )
}

// Stable UI state — survives block rebuilds
const expandedThinking = new Map<string, boolean>()
const thinkingScrollPositions = new Map<string, number>()
const expandedTools = new Map<string, boolean>()
const toolScrollPositions = new Map<string, { input: number; output: number }>()

/** Format AskUserQuestion input as readable question list */
function formatQuestions(input: string): string | null {
  try {
    const parsed = JSON.parse(input)
    const qs = parsed?.questions
    if (!Array.isArray(qs)) return null
    return qs.map((q: { question: string; options?: Array<{ label: string }> }, i: number) => {
      const opts = q.options?.map((o: { label: string }) => o.label).join(', ')
      return `${i + 1}. ${q.question}${opts ? ` [${opts}]` : ''}`
    }).join('\n')
  } catch { return null }
}

const ToolBlockView: Component<{ id: string; tool: string; input: string; result?: { text: string; isError: boolean } }> = (props) => {
  const [expanded, setExpanded] = createSignal(expandedTools.get(props.id) ?? false)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    expandedTools.set(props.id, next)
  }
  const hasResult = () => !!props.result
  const isQuestion = () => props.tool === 'AskUserQuestion'

  /** Strip worktree prefix to get a project-relative path */
  const relPath = (p: string) => p.replace(/^.*\.verun\/worktrees\/[^/]+\//, '')

  const preview = () => {
    if (isQuestion()) {
      const qs = formatQuestions(props.input)
      if (qs) return qs.split('\n')[0].slice(0, 80)
    }
    if (props.input) {
      try {
        const parsed = JSON.parse(props.input)
        const tool = props.tool
        if (tool === 'Bash' && parsed.command) return parsed.command.slice(0, 80)
        if ((tool === 'Read' || tool === 'Write' || tool === 'Edit') && parsed.file_path) return relPath(parsed.file_path)
        if (tool === 'Grep' && parsed.pattern) return parsed.pattern.slice(0, 60)
        if (tool === 'Glob' && parsed.pattern) return parsed.pattern.slice(0, 60)
        if (tool === 'Agent' && parsed.prompt) return parsed.prompt.slice(0, 80)
      } catch { /* not JSON, fall through */ }
    }
    return props.input?.split('\n')[0].slice(0, 60) || ''
  }

  const inputSummary = (): string => {
    if (!props.input) return ''
    try {
      const parsed = JSON.parse(props.input)
      const tool = props.tool
      if (tool === 'Bash' && parsed.command) return `$ ${parsed.command}`
      if (tool === 'Read' && parsed.file_path) return relPath(parsed.file_path)
      if (tool === 'Write' && parsed.file_path) return relPath(parsed.file_path)
      if (tool === 'Edit' && parsed.file_path) return relPath(parsed.file_path)
      if (tool === 'Grep') return `${parsed.pattern || ''}${parsed.path ? ` in ${parsed.path}` : ''}`
      if (tool === 'Glob' && parsed.pattern) return `${parsed.pattern}${parsed.path ? ` in ${parsed.path}` : ''}`
      if (tool === 'Agent' && parsed.prompt) return parsed.prompt.slice(0, 120)
    } catch { /* not JSON */ }
    return props.input.split('\n')[0].slice(0, 100)
  }

  const hasExpandedContent = () => {
    if (isQuestion() && formatQuestions(props.input)) return true
    if (props.input) return true
    if (hasResult()) return true
    return false
  }

  return (
    <div class="px-5 py-0.5">
      <button
        class="flex items-center gap-1.5 text-xs text-text-dim hover:text-text-muted transition-colors"
        onClick={toggle}
      >
        <Show when={expanded()} fallback={<ChevronRight size={11} />}>
          <ChevronDown size={11} />
        </Show>
        <span>{props.tool}</span>
        <Show when={!expanded() && preview()}>
          <span class="text-text-dim/60 truncate max-w-md font-mono text-[11px]">
            — {preview()}
          </span>
        </Show>
      </button>
      <Show when={expanded() && hasExpandedContent()}>
        <div class="pl-4 mt-1 border-l border-border-subtle">
          <Show when={isQuestion() && formatQuestions(props.input)}>
            <pre class="text-xs text-text-muted whitespace-pre-wrap font-mono leading-relaxed mb-1 max-h-40 overflow-y-auto">
              {formatQuestions(props.input)}
            </pre>
          </Show>
          <Show when={!isQuestion() && inputSummary()}>
            <pre class="text-[11px] text-text-muted whitespace-pre-wrap font-mono leading-relaxed mb-1">
              {inputSummary()}
            </pre>
          </Show>
          <Show when={hasResult()}>
            <pre
              class={clsx(
                'text-[11px] whitespace-pre-wrap break-all font-mono leading-relaxed max-h-48 overflow-y-auto',
                props.result!.isError ? 'text-status-error/80' : 'text-text-dim'
              )}
              ref={(el) => {
                const saved = toolScrollPositions.get(props.id)
                if (saved) requestAnimationFrame(() => { el.scrollTop = saved.output })
              }}
              onScroll={(e) => {
                const prev = toolScrollPositions.get(props.id) || { input: 0, output: 0 }
                toolScrollPositions.set(props.id, { ...prev, output: e.currentTarget.scrollTop })
              }}
            >
              {props.result!.text}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// Per-render expansion state for wakeup chips. Keyed by the synthesised
// turn's prompt text; collisions only happen if the model schedules the
// exact same prompt twice, which is rare and harmless (both expand together).
const expandedWakeups = new Map<string, boolean>()

/**
 * Renders a fired `ScheduleWakeup` turn (issue #230). Visually mirrors
 * `ToolBlockView` so the chat keeps one consistent "secondary action" look
 * - a small left-aligned chevron row with an optional expanded body - rather
 * than introducing a third visual idiom for a model-driven event.
 */
const WakeupBlockView: Component<{ prompt: string; reason?: string }> = (props) => {
  const key = () => `${props.reason ?? ''}::${props.prompt}`
  const [expanded, setExpanded] = createSignal(expandedWakeups.get(key()) ?? false)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    expandedWakeups.set(key(), next)
  }
  const headline = () => props.reason ? `Wakeup fired — ${props.reason}` : 'Wakeup fired'
  return (
    <div class="px-5 py-0.5">
      <button
        class="flex items-center gap-1.5 text-xs text-text-dim hover:text-text-muted transition-colors"
        onClick={toggle}
      >
        <Show when={expanded()} fallback={<ChevronRight size={11} />}>
          <ChevronDown size={11} />
        </Show>
        <span>{headline()}</span>
        <Show when={!expanded() && props.prompt}>
          <span class="text-text-dim/60 truncate max-w-md font-mono text-[11px]">
            — {props.prompt.split('\n')[0].slice(0, 80)}
          </span>
        </Show>
      </button>
      <Show when={expanded() && props.prompt}>
        <div class="pl-4 mt-1 border-l border-border-subtle">
          <pre class="text-[11px] text-text-muted whitespace-pre-wrap font-mono leading-relaxed">
            {props.prompt}
          </pre>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search helpers — mark-based text highlighting
// ---------------------------------------------------------------------------

function getTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function highlightMatches(container: HTMLElement, query: string): HTMLElement[] {
  if (!query) return []
  const marks: HTMLElement[] = []
  const lowerQuery = query.toLowerCase()
  const textNodes = getTextNodes(container)

  for (const node of textNodes) {
    const text = node.textContent || ''
    const lowerText = text.toLowerCase()
    let idx = lowerText.indexOf(lowerQuery)
    if (idx === -1) continue

    const frag = document.createDocumentFragment()
    let lastEnd = 0
    while (idx !== -1) {
      if (idx > lastEnd) frag.appendChild(document.createTextNode(text.slice(lastEnd, idx)))
      const mark = document.createElement('mark')
      mark.className = 'chat-search-match'
      mark.textContent = text.slice(idx, idx + query.length)
      frag.appendChild(mark)
      marks.push(mark)
      lastEnd = idx + query.length
      idx = lowerText.indexOf(lowerQuery, lastEnd)
    }
    if (lastEnd < text.length) frag.appendChild(document.createTextNode(text.slice(lastEnd)))
    node.parentNode?.replaceChild(frag, node)
  }
  return marks
}

function clearHighlights(container: HTMLElement) {
  const marks = container.querySelectorAll('mark.chat-search-match')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
      parent.normalize()
    }
  })
}

// ---------------------------------------------------------------------------
// Scroll position persistence across mount/unmount (e.g. switching to file editor and back)
// ---------------------------------------------------------------------------
const savedScrollPositions = new Map<string, { scrollTop: number; autoScroll: boolean }>()

// ---------------------------------------------------------------------------
// Error banner with retry actions
// ---------------------------------------------------------------------------

/** Pretty-print a JSON blob if parseable, else return as-is. Keeps the raw
 *  details panel readable regardless of what the CLI sent. */
function prettyJson(raw?: string): string {
  if (!raw) return ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

export const ErrorBlockView: Component<{
  message: string
  raw?: string
  /** The user message that started the failed turn. */
  retryText?: string
  /** The turn did work before failing - retry says "continue" instead. */
  hasProgress?: boolean
  sessionId?: string | null
  taskId?: string
  agentType?: string
  model?: string | null
}> = (props) => {
  const [retrying, setRetrying] = createSignal(false)
  const [showDetails, setShowDetails] = createSignal(false)
  const [copiedRaw, setCopiedRaw] = createSignal(false)
  const retryMessage = () => props.retryText
  const hasProgress = () => !!props.hasProgress

  const modeArgs = (): [string | undefined, boolean | undefined, boolean | undefined, boolean | undefined] => {
    const sid = props.sessionId
    return [
      props.model ?? undefined,
      sid ? planModeForSession(sid) : undefined,
      sid ? thinkingModeForSession(sid) : undefined,
      sid ? fastModeForSession(sid) : undefined,
    ]
  }

  const retry = async () => {
    if (!props.sessionId) return
    // Mid-loop failures: resending the original prompt makes Claude redo work
    // it already did. Send "continue" so it picks up from the persisted tool
    // results instead.
    const msg = hasProgress() ? 'continue' : retryMessage()
    if (!msg) return
    setRetrying(true)
    try {
      const [model, plan, thinking, fast] = modeArgs()
      await sendMessage(props.sessionId, msg, undefined, model, plan, thinking, fast)
    } catch { /* status will update via event */ }
    setRetrying(false)
  }

  const retryNewSession = async () => {
    const msg = retryMessage()
    const tid = props.taskId
    if (!msg || !tid) return
    setRetrying(true)
    try {
      // The new session runs on the account of the one that failed.
      const failed = props.sessionId ? sessionById(props.sessionId) : undefined
      const session = await openNewSession(tid, props.agentType ?? 'claude', props.model ?? undefined, failed ? inheritedSelection(failed.accountId) : undefined)
      if (session) {
        const [model, plan, thinking, fast] = modeArgs()
        await sendMessage(session.id, msg, undefined, model, plan, thinking, fast)
      }
    } catch { /* status will update via event */ }
    setRetrying(false)
  }

  const copyRaw = async () => {
    if (!props.raw) return
    await navigator.clipboard.writeText(prettyJson(props.raw))
    setCopiedRaw(true)
    setTimeout(() => setCopiedRaw(false), 2000)
  }

  return (
    <div class="mx-5 mt-1 flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-status-error/8 ring-1 ring-status-error/15">
      <div class="flex items-start gap-2">
        <AlertTriangle size={14} class="text-status-error shrink-0 mt-0.5" />
        <span class="text-xs text-status-error whitespace-pre-wrap break-words">{props.message}</span>
      </div>
      <div class="flex items-center gap-2 ml-5.5 flex-wrap">
        <Show when={retryMessage()}>
          <button
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-status-error/12 text-status-error hover:bg-status-error/20 transition-colors disabled:opacity-50"
            onClick={retry}
            disabled={retrying()}
          >
            <RotateCw size={11} />
            {hasProgress() ? 'Continue' : 'Retry'}
          </button>
          <Show when={!hasProgress()}>
            <button
              class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-2 text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50"
              onClick={retryNewSession}
              disabled={retrying()}
            >
              <Plus size={11} />
              Retry in new session
            </button>
          </Show>
        </Show>
        <Show when={props.raw}>
          <button
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-2 text-text-secondary hover:bg-surface-3 transition-colors"
            onClick={() => setShowDetails(v => !v)}
          >
            <Show when={showDetails()} fallback={<ChevronDown size={11} />}>
              <ChevronUp size={11} />
            </Show>
            {showDetails() ? 'Hide details' : 'Show details'}
          </button>
        </Show>
      </div>
      <Show when={showDetails() && props.raw}>
        <div class="ml-5.5 mt-1 relative">
          <button
            class="absolute top-1.5 right-1.5 p-1 rounded-md text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
            onClick={copyRaw}
            title="Copy"
          >
            <Show when={copiedRaw()} fallback={<Copy size={11} />}>
              <Check size={11} class="text-status-running" />
            </Show>
          </button>
          <pre class="my-0 max-h-64 overflow-auto text-[11px] text-text-secondary bg-surface-1 rounded-md p-2 pr-7 ring-1 ring-outline/5 whitespace-pre-wrap break-words">{prettyJson(props.raw)}</pre>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ChatView
// ---------------------------------------------------------------------------

export const ChatView: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let contentRef!: HTMLDivElement
  let searchInputRef!: HTMLInputElement
  let autoScroll = true
  let scrollRafPending = false

  // Use a store for blocks so mutations are granular
  const [blocks, setBlocks] = createStore<DisplayBlock[]>([])
  let builder = createBlockBuilder()

  // Image viewer state
  const [viewerImage, setViewerImage] = createSignal<AttachmentRef | null>(null)

  // Scroll to bottom button visibility
  const [isAtBottom, setIsAtBottom] = createSignal(true)

  const hasAiTurn = () => props.output.some((i) => i.kind !== 'userMessage')
  const btwState = () => props.sessionId ? sideQuestionState(props.sessionId) : undefined
  // The pill is "sticky" (visible regardless of scroll position) when there's
  // a side question in flight or an unread answer for this session - those are
  // notification states the user shouldn't miss by scrolling away.
  const btwSticky = () => !!btwState()?.loading || !!btwState()?.unread
  const btwMode = (): 'idle' | 'loading' | 'unread' => {
    const s = btwState()
    if (s?.loading) return 'loading'
    if (s?.unread) return 'unread'
    return 'idle'
  }
  const showBtw = () =>
    props.agentType === 'claude'
    && !!props.sessionId
    && sideQuestionPanel()?.sessionId !== props.sessionId
    && (btwSticky() || (isAtBottom() && hasAiTurn()))
  // Reserve extra bottom space only when the pill would otherwise sit on top
  // of the user's last message: agent isn't streaming and the last rendered
  // block is user-authored (e.g. user interrupted a turn). Checking the last
  // *block* (not raw output) ignores trailing turnEnd/turnSnapshot items.
  const needsBtwPad = () =>
    showBtw()
    && props.sessionStatus !== 'running'
    && blocks[blocks.length - 1]?.type === 'user'

  // Search state
  const [showSearch, setShowSearch] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')
  const [matches, setMatches] = createSignal<HTMLElement[]>([])
  const [currentMatchIdx, setCurrentMatchIdx] = createSignal(-1)

  const openSearch = () => {
    setShowSearch(true)
    requestAnimationFrame(() => searchInputRef?.focus())
  }

  const closeSearch = () => {
    setShowSearch(false)
    setSearchQuery('')
    setCurrentMatchIdx(-1)
    if (contentRef) clearHighlights(contentRef)
    setMatches([])
  }

  const runSearch = (query: string) => {
    if (contentRef) clearHighlights(contentRef)
    if (!query) {
      setMatches([])
      setCurrentMatchIdx(-1)
      return
    }
    const found = highlightMatches(contentRef, query)
    setMatches(found)
    if (found.length > 0) {
      setCurrentMatchIdx(found.length - 1)
      scrollToMatch(found[found.length - 1])
    } else {
      setCurrentMatchIdx(-1)
    }
  }

  const scrollToMatch = (el: HTMLElement) => {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Briefly highlight current match
    el.classList.add('chat-search-current')
    // Remove from all others
    matches().forEach(m => { if (m !== el) m.classList.remove('chat-search-current') })
  }

  const refreshHighlights = () => {
    if (contentRef) clearHighlights(contentRef)
    const query = searchQuery()
    if (!query) {
      setMatches([])
      setCurrentMatchIdx(-1)
      return
    }
    const found = highlightMatches(contentRef, query)
    setMatches(found)
    if (found.length === 0) {
      setCurrentMatchIdx(-1)
      return
    }
    const prev = currentMatchIdx()
    const idx = prev >= 0 && prev < found.length ? prev : found.length - 1
    setCurrentMatchIdx(idx)
    found[idx].classList.add('chat-search-current')
  }

  const goToMatch = (delta: number) => {
    const m = matches()
    if (m.length === 0) return
    const next = (currentMatchIdx() + delta + m.length) % m.length
    setCurrentMatchIdx(next)
    scrollToMatch(m[next])
  }

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) goToMatch(1)
      else goToMatch(-1)
    }
  }

  // Save scroll position on unmount, restore after first block rebuild on remount
  let pendingScrollRestore: { scrollTop: number; autoScroll: boolean } | null = null
  onMount(() => {
    const sid = props.sessionId
    if (sid) {
      const saved = savedScrollPositions.get(sid)
      if (saved) {
        autoScroll = saved.autoScroll
        setIsAtBottom(saved.autoScroll)
        pendingScrollRestore = saved
      }
    }
    onCleanup(() => {
      if (sid && containerRef) {
        savedScrollPositions.set(sid, {
          scrollTop: containerRef.scrollTop,
          autoScroll,
        })
      }
    })
  })

  // Cmd+F / Ctrl+F handler
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'f') {
        // Only handle if this ChatView is visible (container in DOM)
        if (!containerRef || !containerRef.offsetParent) return
        e.preventDefault()
        if (showSearch()) {
          searchInputRef?.select()
        } else {
          openSearch()
        }
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => {
      window.removeEventListener('keydown', handler)
      // Clean up marks if component unmounts while search is open
      if (contentRef) clearHighlights(contentRef)
    })
  })

  // Each ChatView instance is keyed on sessionId by TaskPanel, so it only ever
  // sees a single session's output for its lifetime. Blocks are built
  // incrementally: a flush folds in only the items it appended and touches
  // only the blocks those changed. A replaced, shrunk or prepended output
  // (older page, trim, removed message) rebuilds from scratch.
  //
  // Keyed on the last item as well as the length: once the store trims old
  // items the length can stay put while the content moves on.
  createEffect(on(
    () => {
      const len = props.output.length
      return [len, len ? props.output[len - 1] : undefined] as const
    },
    () => {
      const output = unwrap(props.output)
      const len = output.length
      if (len === 0) {
        if (blocks.length !== 0 || builder.blocks.length !== 0) {
          builder = createBlockBuilder()
          setBlocks([])
        }
        return
      }
      let changed: boolean
      if (builder.canExtend(output)) {
        const dirty = builder.append(output)
        changed = dirty.size > 0
        if (changed) {
          batch(() => {
            for (const i of [...dirty].sort((a, b) => a - b)) {
              const copy = cloneBlock(builder.blocks[i])
              if (i < blocks.length) setBlocks(i, reconcile(copy, { merge: true }))
              else setBlocks(i, copy)
            }
          })
        }
      } else {
        builder = createBlockBuilder()
        builder.append(output)
        setBlocks(reconcile(builder.blocks.map(cloneBlock), { merge: true }))
        changed = true
      }
      if (changed) {
        if (showSearch() && searchQuery()) {
          requestAnimationFrame(() => refreshHighlights())
        }
        if (pendingScrollRestore) {
          const restore = pendingScrollRestore
          pendingScrollRestore = null
          if (!restore.autoScroll) {
            requestAnimationFrame(() => {
              if (containerRef) containerRef.scrollTop = restore.scrollTop
            })
          } else {
            scheduleAutoScroll()
          }
        } else {
          scheduleAutoScroll()
        }
      }
    }
  ))

  // Auto-scroll when session starts running (thinking dots appear)
  createEffect(on(() => props.sessionStatus, (status) => {
    if (status === 'running') scheduleAutoScroll()
  }))

  const scheduleAutoScroll = () => {
    if (!autoScroll || !containerRef || scrollRafPending) return
    scrollRafPending = true
    requestAnimationFrame(() => {
      scrollRafPending = false
      if (autoScroll && containerRef) {
        containerRef.scrollTop = containerRef.scrollHeight
      }
    })
  }

  const scrollToBottom = () => {
    if (!containerRef) return
    containerRef.scrollTo({ top: containerRef.scrollHeight, behavior: 'smooth' })
    autoScroll = true
    setIsAtBottom(true)
  }

  // Guard so the scroll-up-near-top trigger only fires once per "approach"; the
  // store's own loading flag dedupes concurrent fetches but resetting this here
  // means the user has to scroll away from the top before another page kicks in.
  let olderLoadInFlight = false
  // Tracks ChatView mount state so a pagination fetch in flight when the user
  // switches sessions doesn't end up writing scrollTop to the detached div.
  let mounted = true
  onCleanup(() => { mounted = false })
  const maybeLoadOlder = async () => {
    if (olderLoadInFlight) return
    const sid = props.sessionId
    if (!sid || !hasMoreOutputLines(sid) || !containerRef) return
    olderLoadInFlight = true
    const oldScrollHeight = containerRef.scrollHeight
    const oldScrollTop = containerRef.scrollTop
    try {
      const added = await loadOlderOutputLines(sid)
      if (!mounted) return
      if (added > 0) {
        // Two RAFs: first lets Solid commit the prepended blocks, second waits
        // until the browser has actually re-laid them out so scrollHeight is real.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!mounted || !containerRef) return
            const delta = containerRef.scrollHeight - oldScrollHeight
            if (delta > 0) containerRef.scrollTop = oldScrollTop + delta
          })
        })
      }
    } finally {
      olderLoadInFlight = false
    }
  }

  const handleScroll = () => {
    if (!containerRef || scrollRafPending) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    const distFromBottom = scrollHeight - scrollTop - clientHeight
    autoScroll = distFromBottom < 30
    setIsAtBottom(distFromBottom < 200)
    if (scrollTop < 200) void maybeLoadOlder()
  }

  const handleLinkClick = (e: MouseEvent) => handleMarkdownLinkClick(e, props.taskId)

  return (
    <div class="w-full h-full relative">
      {/* Search bar — outside scroll container */}
      <Show when={showSearch()}>
        <div class="absolute top-2 right-3 z-20 flex items-center gap-1 bg-surface-2 border border-border rounded-lg px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            class="bg-transparent text-sm text-text-primary outline-none w-52 placeholder-text-dim"
            placeholder="Find in session..."
            value={searchQuery()}
            onInput={(e) => {
              const q = e.currentTarget.value
              setSearchQuery(q)
              runSearch(q)
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <span class="text-[11px] text-text-dim whitespace-nowrap w-16 text-right">
            {searchQuery() ? (matches().length === 0 ? 'No results' : `${currentMatchIdx() + 1} of ${matches().length}`) : '\u00A0'}
          </span>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors disabled:opacity-30"
            onClick={() => goToMatch(-1)}
            disabled={matches().length === 0}
            title="Previous (Enter)"
          >
            <ArrowUp size={14} />
          </button>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors disabled:opacity-30"
            onClick={() => goToMatch(1)}
            disabled={matches().length === 0}
            title="Next (Shift+Enter)"
          >
            <ArrowDown size={14} />
          </button>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors"
            onClick={closeSearch}
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </Show>
      <div
        ref={containerRef}
        class="w-full h-full overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
        onClick={handleLinkClick}
      >
      <div
        ref={contentRef}
        class={clsx('flex flex-col gap-2 pt-4', needsBtwPad() ? 'pb-16' : 'pb-6')}
      >
        <For each={blocks}>
          {(block) => (
            <Switch>
              <Match when={block.type === 'user'}>
                {(() => {
                  const b = block as UserBlock
                  return (
                    <div class="flex flex-col items-end px-5 py-1 gap-1">
                      <Show when={b.images && b.images.length > 0}>
                        <div class="flex flex-wrap justify-end gap-1 max-w-[75%]">
                          <For each={b.images || []}>
                            {(img) => (
                              <button
                                type="button"
                                class="block cursor-pointer"
                                onClick={() => setViewerImage(img)}
                                title="Open image"
                              >
                                <BlobImage
                                  hash={img.hash}
                                  mimeType={img.mimeType}
                                  class="h-16 w-16 object-cover rounded-xl border border-border transition-all duration-150 hover:border-border-active hover:brightness-110 hover:scale-[1.03]"
                                />
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={b.files && b.files.length > 0}>
                        <div class="flex flex-wrap justify-end gap-1 max-w-[75%]">
                          <For each={b.files || []}>{(file) => <FileChip file={file} />}</For>
                        </div>
                      </Show>
                      <Show when={b.text}>
                        <div class="max-w-[75%] bg-accent/15 rounded-2xl rounded-br-lg border border-accent/10 overflow-hidden">
                          <div class="px-4 py-2.5 text-sm text-text-primary whitespace-pre-wrap leading-relaxed select-text">
                            <For each={parseMentions(b.text)}>
                              {(seg) => (
                                <Show when={seg.type === 'mention'} fallback={seg.value}>
                                  <FileMentionBadge filePath={seg.value} taskId={props.taskId} size="sm" />
                                </Show>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </div>
                  )
                })()}
              </Match>
              <Match when={block.type === 'assistant'}>
                {(() => {
                  const b = block as AssistantBlock
                  return (
                    <div class="px-5 py-1">
                      <div
                        class="text-sm text-text-primary leading-relaxed prose-verun select-text break-words overflow-hidden"
                        innerHTML={renderMarkdownForTask(b.text, props.taskId)}
                      />
                      <Show when={b.isLastInTurn}>
                        <div class="flex items-center gap-2 mt-0.5">
                          <Show when={b.durationMs}>
                            {(() => {
                              const hasCostInfo = b.turnCost || b.turnTokens
                              if (!hasCostInfo) {
                                return <span class="text-[10px] text-text-dim/50">{formatDuration(b.durationMs!)}</span>
                              }
                              const parts = [
                                b.turnCost ? formatCost(b.turnCost) : '',
                                b.turnTokens ? formatTokensWithCache(b.turnTokens) : '',
                              ].filter(Boolean).join(' · ')
                              return (
                                <span class="relative group/dur">
                                  <span class="text-[10px] text-text-dim/50 cursor-default">{formatDuration(b.durationMs!)}</span>
                                  <span class="absolute left-0 bottom-full mb-1 hidden group-hover/dur:block z-50 whitespace-nowrap px-2 py-1 rounded bg-surface-3 border border-border-active shadow-lg text-[10px] text-text-secondary">
                                    {parts}
                                  </span>
                                </span>
                              )
                            })()}
                          </Show>
                          <Show when={!b.isStreaming}>
                            <CopyButton text={b.text} />
                            <Show when={b.messageUuid && props.sessionId}>
                              <ForkButton
                                sessionId={props.sessionId!}
                                messageUuid={b.messageUuid!}
                              />
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                })()}
              </Match>
              <Match when={block.type === 'thinking'}>
                <ThinkingBlockView id={(block as ThinkingBlock).id} text={(block as ThinkingBlock).text} />
              </Match>
              <Match when={block.type === 'tool'}>
                {(() => {
                  const b = block as ToolBlock
                  return <ToolBlockView id={b.id} tool={b.tool} input={b.input} result={b.result} />
                })()}
              </Match>
              <Match when={block.type === 'system'}>
                <div class="flex justify-center px-5 py-1">
                  <span class="text-[11px] text-text-dim whitespace-pre-wrap">{(block as SystemBlock).text}</span>
                </div>
              </Match>
              <Match when={block.type === 'wakeup'}>
                {(() => {
                  const b = block as WakeupBlock
                  return <WakeupBlockView prompt={b.prompt} reason={b.reason} />
                })()}
              </Match>
              <Match when={block.type === 'error'}>
                {(() => {
                  const b = block as ErrorBlock
                  return (
                    <ErrorBlockView
                      message={b.message}
                      raw={b.raw}
                      retryText={b.retryText}
                      hasProgress={b.hasProgress}
                      sessionId={props.sessionId}
                      taskId={props.taskId}
                      agentType={props.agentType}
                      model={props.model}
                    />
                  )
                })()}
              </Match>
              <Match when={block.type === 'plan'}>
                {(() => {
                  const b = block as PlanBlock
                  return (
                    <div class="px-5 py-1">
                      <div class="max-w-full rounded-xl ring-1 ring-accent/30 bg-accent/5 px-3 py-2">
                        <div class="flex items-center justify-between mb-2">
                          <span class="text-[11px] uppercase tracking-wide text-accent font-medium">Proposed plan</span>
                        </div>
                        <Show when={b.explanation}>
                          <p class="text-xs text-text-secondary mb-2 whitespace-pre-wrap">{b.explanation}</p>
                        </Show>
                        <ul class="flex flex-col gap-1">
                          <For each={b.items}>
                            {(step) => (
                              <li class="flex items-start gap-2 text-xs text-text-primary leading-relaxed">
                                <span class="mt-0.5 shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] text-text-dim ring-1 ring-border">
                                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '·' : ' '}
                                </span>
                                <span class={step.status === 'completed' ? 'line-through text-text-dim' : ''}>{step.step}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </div>
                  )
                })()}
              </Match>
              <Match when={block.type === 'diff'}>
                {(() => {
                  const b = block as DiffBlock
                  return (
                    <div class="px-5 py-1">
                      <details class="max-w-full rounded-xl ring-1 ring-border bg-surface-2 overflow-hidden">
                        <summary class="cursor-pointer px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-dim select-none">
                          Turn diff
                        </summary>
                        <pre class="text-xs text-text-primary whitespace-pre overflow-x-auto px-3 py-2 leading-snug select-text">{b.diff}</pre>
                      </details>
                    </div>
                  )
                })()}
              </Match>
            </Switch>
          )}
        </For>

        <Show when={props.sessionStatus === 'running'}>
          <div class="px-5 py-2">
            <div class="thinking-dots">
              <span /><span /><span />
            </div>
          </div>
        </Show>

        <Show when={blocks.length === 0}>
          <div class="flex-1 flex items-center justify-center pt-20">
            <div class="text-center max-w-sm">
              <p class="text-sm text-text-secondary mb-1">New session</p>
              <p class="text-xs text-text-dim leading-relaxed">
                Describe what you want to build, fix, or explore in this worktree.
              </p>
            </div>
          </div>
        </Show>
      </div>
      </div>
      {(() => {
        // Scroll-down chevron hides when the pill is "sticky" (loading/unread)
        // so the two never stack in the same anchor point.
        const showScroll = () => !isAtBottom() && !btwSticky()
        const morph =
          'absolute bottom-0 right-0 origin-bottom-right will-change-[transform,opacity] '
          + 'transition-[opacity,transform] duration-[260ms] '
          + 'ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
        const onPillClick = () => {
          const sid = props.sessionId
          if (sid) openSideQuestion(sid)
        }
        const onDismissUnread = (e: MouseEvent) => {
          e.stopPropagation()
          const sid = props.sessionId
          if (sid) dismissSideQuestionUnread(sid)
        }
        return (
          <div class="absolute bottom-4 right-4 z-10 pointer-events-none">
            <button
              class={clsx(
                morph,
                'w-7 h-7 flex items-center justify-center rounded-full bg-surface-2 ring-1 ring-outline/10 shadow-lg text-text-dim hover:text-text-secondary hover:ring-outline/20',
                showScroll()
                  ? 'opacity-100 scale-100 pointer-events-auto'
                  : 'opacity-0 scale-75 pointer-events-none',
              )}
              onClick={scrollToBottom}
              title="Scroll to bottom"
              aria-hidden={!showScroll()}
              tabindex={showScroll() ? 0 : -1}
            >
              <ChevronDown size={15} />
            </button>
            <div
              class={clsx(
                morph,
                'h-7 flex items-stretch whitespace-nowrap rounded-full bg-surface-2 ring-1 shadow-lg text-[11px]',
                btwMode() === 'unread'
                  ? 'ring-accent/40 text-text-primary'
                  : 'ring-outline/10 text-text-dim',
                showBtw()
                  ? 'opacity-100 scale-100 pointer-events-auto'
                  : 'opacity-0 scale-75 pointer-events-none',
              )}
              aria-hidden={!showBtw()}
            >
              <button
                class={clsx(
                  'h-full px-2.5 flex items-center gap-1.5 rounded-l-full',
                  btwMode() === 'unread' ? 'rounded-r-none' : 'rounded-r-full',
                  btwMode() === 'unread'
                    ? 'hover:bg-accent/10'
                    : 'hover:text-text-secondary hover:ring-outline/20',
                )}
                onClick={onPillClick}
                title={
                  btwMode() === 'loading'
                    ? 'Side question in progress - click to reopen'
                    : btwMode() === 'unread'
                      ? 'Answer ready - click to view'
                      : 'Ask Claude an ephemeral side question (does not enter conversation history)'
                }
                tabindex={showBtw() ? 0 : -1}
              >
                <Switch>
                  <Match when={btwMode() === 'loading'}>
                    <Loader2 size={12} class="animate-spin" />
                    <span>Asking sideways...</span>
                  </Match>
                  <Match when={btwMode() === 'unread'}>
                    <Sparkles size={12} class="text-accent" />
                    <span>Answer ready</span>
                  </Match>
                  <Match when={btwMode() === 'idle'}>
                    <MessageCircleQuestion size={12} />
                    <span>
                      Ask sideways{' '}
                      <code class="ml-0.5 px-1 py-0.5 rounded bg-surface-3 text-text-dim text-[9px]">/btw</code>
                    </span>
                  </Match>
                </Switch>
              </button>
              <Show when={btwMode() === 'unread'}>
                <button
                  class="px-2 flex items-center text-text-dim hover:text-text-primary border-l-1 border-l-solid border-l-outline/15 rounded-r-full"
                  onClick={onDismissUnread}
                  title="Dismiss"
                  aria-label="Dismiss answer notification"
                  tabindex={showBtw() ? 0 : -1}
                >
                  <X size={12} />
                </button>
              </Show>
            </div>
          </div>
        )
      })()}
      <Show when={viewerImage()}>
        {(img) => (
          <ImageViewer
            open={true}
            hash={img().hash}
            mimeType={img().mimeType}
            name={img().name}
            onClose={() => setViewerImage(null)}
          />
        )}
      </Show>
    </div>
  )
}
