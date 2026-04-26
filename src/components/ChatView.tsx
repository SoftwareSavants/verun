import { Component, For, Show, Switch, Match, createEffect, on, createSignal, onMount, onCleanup } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { clsx } from 'clsx'
import { renderMarkdown, handleMarkdownLinkClick, getWorktreePath } from '../lib/markdown'
import type { OutputItem, SessionStatus, AttachmentRef } from '../types'
import { ChevronDown, ChevronRight, AlertTriangle, Copy, Check, ArrowUp, ArrowDown, X, GitBranch, RotateCw, Plus, ChevronUp } from 'lucide-solid'
import { FileMentionBadge } from './FileMentionBadge'
import { ImageViewer } from './ImageViewer'
import { BlobImage } from './BlobImage'
import { Popover } from './Popover'
import { parseMentions } from '../lib/mentions'
import * as ipc from '../lib/ipc'
import { addToast, setSelectedTaskId, setSelectedSessionIdForTask } from '../store/ui'
import { setSessions, loadOutputLines, loadOlderOutputLines, hasMoreOutputLines, sendMessage, createSession } from '../store/sessions'
import { planModeForSession, thinkingModeForSession, fastModeForSession } from '../store/sessionContext'
import { setTasks } from '../store/tasks'
import { setMainView } from '../store/editorView'
import { formatCost, formatTokens } from '../lib/format'

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
interface ErrorBlock {
  type: 'error'
  message: string
  raw?: string
  /** Turn marker so retry picks the right user message. */
  turnIndex: number
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
type DisplayBlock = UserBlock | AssistantBlock | ThinkingBlock | ToolBlock | SystemBlock | ErrorBlock | PlanBlock | DiffBlock

export function rebuildBlocks(items: OutputItem[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  let currentText = ''
  let currentThinking = ''

  const flushText = () => {
    if (currentText) {
      blocks.push({ type: 'assistant', text: currentText })
      currentText = ''
    }
  }
  const flushThinking = () => {
    if (currentThinking) {
      blocks.push({ type: 'thinking', id: `thinking-${thinkingCounter++}`, text: currentThinking })
      currentThinking = ''
    }
  }

  const lastOpenTool = (): ToolBlock | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'tool' && !b.result) return b
      if (b.type !== 'tool') break
    }
    return undefined
  }

  let toolCounter = 0
  let thinkingCounter = 0
  let turnStartTs: number | undefined
  let turnIndex = 0
  // Track whether this turn has already produced an error block so we can
  // drop the duplicate turnEnd-derived bubble (synthetic assistant + result
  // both carry the same provider error).
  let turnHasError = false

  for (const item of items) {
    switch (item.kind) {
      case 'text':
        flushThinking()
        currentText += item.text
        break
      case 'thinking':
        flushText()
        currentThinking += item.text
        break
      case 'userMessage':
        flushText(); flushThinking()
        turnStartTs = item.timestamp
        turnIndex += 1
        turnHasError = false
        blocks.push({ type: 'user', text: item.text, images: item.images })
        break
      case 'errorMessage':
        flushText(); flushThinking()
        blocks.push({ type: 'error', message: item.message, raw: item.raw, turnIndex })
        turnHasError = true
        break
      case 'toolStart': {
        // Hide ExitPlanMode from the chat — it's shown as a dedicated plan overlay
        if (item.tool === 'ExitPlanMode') break
        flushText(); flushThinking()
        // Deduplicate: if the last block is an open tool with the same name AND same input,
        // it's a duplicate from control_request + content_block_start. Merge it.
        // But if inputs differ, it's a parallel call of the same tool — keep both.
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'tool' && !lastBlock.result && lastBlock.tool === item.tool
            && (!item.input || !lastBlock.input || item.input === lastBlock.input)) {
          if (item.input && !lastBlock.input) lastBlock.input = item.input
        } else {
          blocks.push({ type: 'tool', id: `tool-${toolCounter++}`, tool: item.tool, input: item.input, result: undefined })
        }
        break
      }
      case 'toolResult': {
        flushText(); flushThinking()
        const openTool = lastOpenTool()
        if (openTool) {
          openTool.result = { text: item.text, isError: item.isError }
        } else {
          blocks.push({ type: 'tool', id: `tool-${toolCounter++}`, tool: 'Tool', input: '', result: { text: item.text, isError: item.isError } })
        }
        break
      }
      case 'system':
        flushText(); flushThinking()
        blocks.push({ type: 'system', text: item.text })
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
          if (blocks[i].type === 'assistant') {
            const ab = blocks[i] as AssistantBlock
            ab.isLastInTurn = true
            if (durationMs) ab.durationMs = durationMs
            if (turnCost) ab.turnCost = turnCost
            if (turnTokens) ab.turnTokens = turnTokens
            break
          }
          if (blocks[i].type === 'user') break
        }
        // Render rules:
        //   - completed         → no bubble (happy path)
        //   - interrupted       → no bubble (user already hit stop)
        //   - error + message   → one error block per turn (de-duped — the
        //                         synthetic assistant already produced one)
        //   - other non-success → show the status as a system bubble
        if (item.error) {
          if (!turnHasError) {
            blocks.push({ type: 'error', message: item.error, raw: undefined, turnIndex })
            turnHasError = true
          }
        } else if (item.status !== 'completed' && item.status !== 'interrupted') {
          blocks.push({ type: 'system', text: `Turn ended: ${item.status}` })
        }
        turnStartTs = undefined
        break
      }
      case 'turnSnapshot': {
        // Attach the message uuid to the most recent assistant block, walking
        // back past tools/thinking. This is the stable id for "fork from here".
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b.type === 'assistant') {
            ;(b as AssistantBlock).messageUuid = item.messageUuid
            break
          }
          if (b.type === 'user') break
        }
        break
      }
      case 'planUpdate': {
        flushText(); flushThinking()
        const existing = blocks.find(b => b.type === 'plan') as PlanBlock | undefined
        if (existing) {
          existing.items = item.items
          if (item.explanation) existing.explanation = item.explanation
        } else {
          blocks.push({ type: 'plan', items: item.items, explanation: item.explanation })
        }
        break
      }
      case 'diffUpdate': {
        flushText(); flushThinking()
        const existing = blocks.find(b => b.type === 'diff') as DiffBlock | undefined
        if (existing) {
          existing.diff = item.diff
        } else {
          blocks.push({ type: 'diff', diff: item.diff })
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
  flushText(); flushThinking()
  // Mark the last assistant block in an in-progress turn (no turnEnd yet)
  if (turnStartTs !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'assistant') {
        (blocks[i] as AssistantBlock).isLastInTurn = true
        ;(blocks[i] as AssistantBlock).isStreaming = true
        break
      }
      if (blocks[i].type === 'user') break
    }
  }
  return blocks
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

const ForkButton: Component<{ sessionId: string; messageUuid: string }> = (props) => {
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
      setError(String(e))
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
      setError(String(e))
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

/** Walk `output` and return the text of the user message that started the
 *  given 1-based turn. Retry always resends the correct message even for
 *  historical error blocks further up the transcript. */
function userMessageForTurn(output: OutputItem[], turnIndex: number): string | undefined {
  let seen = 0
  for (const item of output) {
    if (item.kind === 'userMessage') {
      seen += 1
      if (seen === turnIndex) return item.text
    }
  }
  return undefined
}

/** Pretty-print a JSON blob if parseable, else return as-is. Keeps the raw
 *  details panel readable regardless of what the CLI sent. */
function prettyJson(raw?: string): string {
  if (!raw) return ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

const ErrorBlockView: Component<{
  message: string
  raw?: string
  turnIndex: number
  output: OutputItem[]
  sessionId?: string | null
  taskId?: string
  agentType?: string
  model?: string | null
}> = (props) => {
  const [retrying, setRetrying] = createSignal(false)
  const [showDetails, setShowDetails] = createSignal(false)
  const [copiedRaw, setCopiedRaw] = createSignal(false)
  const retryMessage = () => userMessageForTurn(props.output, props.turnIndex)

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
    const msg = retryMessage()
    if (!msg || !props.sessionId) return
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
      const session = await createSession(tid, props.agentType ?? 'claude', props.model ?? undefined)
      setSelectedSessionIdForTask(tid, session.id)
      setMainView(tid, 'session')
      const [model, plan, thinking, fast] = modeArgs()
      await sendMessage(session.id, msg, undefined, model, plan, thinking, fast)
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
            Retry
          </button>
          <button
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-2 text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50"
            onClick={retryNewSession}
            disabled={retrying()}
          >
            <Plus size={11} />
            Retry in new session
          </button>
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
  let lastItemCount = 0

  // Image viewer state
  const [viewerImage, setViewerImage] = createSignal<AttachmentRef | null>(null)

  // Scroll to bottom button visibility
  const [isAtBottom, setIsAtBottom] = createSignal(true)

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
  // sees a single session's output for its lifetime. Rebuild blocks whenever
  // the output length changes.
  createEffect(on(
    () => props.output.length,
    (len) => {
      if (len === 0) {
        if (lastItemCount !== 0) {
          setBlocks([])
          lastItemCount = 0
        }
        return
      }
      if (len !== lastItemCount) {
        const newBlocks = rebuildBlocks(props.output)
        setBlocks(reconcile(newBlocks, { merge: true }))
        lastItemCount = len
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
      <div ref={contentRef} class="flex flex-col gap-2 pt-4 pb-6">
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
              <Match when={block.type === 'error'}>
                {(() => {
                  const b = block as ErrorBlock
                  return (
                    <ErrorBlockView
                      message={b.message}
                      raw={b.raw}
                      turnIndex={b.turnIndex}
                      output={props.output}
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
      <Show when={!isAtBottom()}>
        <button
          class="absolute bottom-4 right-4 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-surface-2 ring-1 ring-outline/10 shadow-lg text-text-dim hover:text-text-secondary hover:ring-outline/20 transition-colors"
          onClick={scrollToBottom}
          title="Scroll to bottom"
        >
          <ChevronDown size={15} />
        </button>
      </Show>
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
