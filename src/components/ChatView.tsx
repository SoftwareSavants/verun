import { Component, For, Show, Switch, Match, createEffect, on, createSignal, onMount, onCleanup } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { clsx } from 'clsx'
import { renderMarkdown, handleMarkdownLinkClick, getWorktreePath } from '../lib/markdown'
import type { OutputItem, SessionStatus } from '../types'
import { ChevronDown, ChevronRight, AlertTriangle, Copy, Check, ArrowUp, ArrowDown, X, GitBranch, RotateCw, Plus } from 'lucide-solid'
import { FileMentionBadge } from './FileMentionBadge'
import { ImageViewer } from './ImageViewer'
import { BlobImage } from './BlobImage'
import { Popover } from './Popover'
import { parseMentions } from '../lib/mentions'
import * as ipc from '../lib/ipc'
import { addToast, setSelectedTaskId, setSelectedSessionId } from '../store/ui'
import { setSessions, loadOutputLines, sendMessage, createSession, taskPlanMode, taskThinkingMode, taskFastMode } from '../store/sessions'
import { setTasks } from '../store/tasks'

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

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
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
  sessionError?: string
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
  images?: Array<{ mimeType: string; data: Uint8Array }>
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
type DisplayBlock = UserBlock | AssistantBlock | ThinkingBlock | ToolBlock | SystemBlock

function rebuildBlocks(items: OutputItem[]): DisplayBlock[] {
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
        blocks.push({ type: 'user', text: item.text, images: item.images })
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
        if (item.status !== 'completed') {
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
      setSelectedSessionId(session.id)
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
      setSelectedSessionId(tws.session.id)
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
              class="absolute -top-1 left-[calc(100%-4px)] py-1 min-w-48 bg-surface-2 ring-1 ring-white/8 rounded-md shadow-xl animate-in"
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
          <div class="mt-1 px-2.5 py-1 text-[10px] text-status-error border-t border-white/8">{error()}</div>
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

function getLastUserMessage(output: OutputItem[]): string | undefined {
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i].kind === 'userMessage') return (output[i] as { kind: 'userMessage'; text: string }).text
  }
  return undefined
}

const ErrorBanner: Component<{
  error?: string
  output: OutputItem[]
  sessionId?: string | null
  taskId?: string
  agentType?: string
  model?: string | null
}> = (props) => {
  const [retrying, setRetrying] = createSignal(false)
  const lastMessage = () => getLastUserMessage(props.output)

  const modeArgs = (): [string | undefined, boolean | undefined, boolean | undefined, boolean | undefined] => {
    const tid = props.taskId
    return [
      props.model ?? undefined,
      tid ? taskPlanMode[tid] ?? undefined : undefined,
      tid ? taskThinkingMode[tid] ?? undefined : undefined,
      tid ? taskFastMode[tid] ?? undefined : undefined,
    ]
  }

  const retry = async () => {
    const msg = lastMessage()
    if (!msg || !props.sessionId) return
    setRetrying(true)
    try {
      const [model, plan, thinking, fast] = modeArgs()
      await sendMessage(props.sessionId, msg, undefined, model, plan, thinking, fast)
    } catch { /* status will update via event */ }
    setRetrying(false)
  }

  const retryNewSession = async () => {
    const msg = lastMessage()
    if (!msg || !props.taskId) return
    setRetrying(true)
    try {
      const session = await createSession(props.taskId, props.agentType ?? 'claude', props.model ?? undefined)
      setSelectedSessionId(session.id)
      const [model, plan, thinking, fast] = modeArgs()
      await sendMessage(session.id, msg, undefined, model, plan, thinking, fast)
    } catch { /* status will update via event */ }
    setRetrying(false)
  }

  return (
    <div class="mx-5 flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-status-error/8 ring-1 ring-status-error/15">
      <div class="flex items-start gap-2">
        <AlertTriangle size={14} class="text-status-error shrink-0 mt-0.5" />
        <span class="text-xs text-status-error">
          {props.error || 'Session encountered an error'}
        </span>
      </div>
      <Show when={lastMessage()}>
        <div class="flex items-center gap-2 ml-5.5">
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
  const [viewerImage, setViewerImage] = createSignal<{ mimeType: string; data: Uint8Array } | null>(null)

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
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
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

  // Rebuild blocks when output items change OR session switches.
  // ChatView stays mounted across session/task switches (Solid <Show> doesn't
  // remount on truthy->truthy), so we must track sessionId to avoid showing
  // stale blocks from the previous session when item counts happen to match.
  let lastSessionId: string | null | undefined = props.sessionId
  createEffect(on(
    [() => props.sessionId, () => props.output.length] as const,
    ([sid, len]) => {
      const sessionChanged = sid !== lastSessionId
      lastSessionId = sid

      if (len === 0 && (lastItemCount !== 0 || sessionChanged)) {
        setBlocks([])
        lastItemCount = 0
        if (sessionChanged) scheduleAutoScroll()
        return
      }
      if (len !== lastItemCount || sessionChanged) {
        const newBlocks = rebuildBlocks(props.output)
        setBlocks(reconcile(newBlocks, { merge: !sessionChanged }))
        lastItemCount = len
        // Re-apply search highlights after block rebuild (preserve position)
        if (showSearch() && searchQuery()) {
          requestAnimationFrame(() => refreshHighlights())
        }
        if (sessionChanged) {
          scheduleAutoScroll()
        } else if (pendingScrollRestore) {
          // On remount: restore saved scroll position instead of auto-scrolling
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

  const handleScroll = () => {
    if (!containerRef || scrollRafPending) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    const distFromBottom = scrollHeight - scrollTop - clientHeight
    autoScroll = distFromBottom < 30
    setIsAtBottom(distFromBottom < 200)
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
                                onClick={() => setViewerImage({ mimeType: img.mimeType, data: img.data })}
                                title="Open image"
                              >
                                <BlobImage
                                  data={img.data}
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
                  <span class="text-[11px] text-text-dim">{(block as SystemBlock).text}</span>
                </div>
              </Match>
            </Switch>
          )}
        </For>

        <Show when={props.sessionStatus === 'error'}>
          <ErrorBanner
            error={props.sessionError}
            output={props.output}
            sessionId={props.sessionId}
            taskId={props.taskId}
            agentType={props.agentType}
            model={props.model}
          />
        </Show>

        <Show when={props.sessionStatus === 'running'}>
          <div class="px-5 py-2">
            <div class="thinking-dots">
              <span /><span /><span />
            </div>
          </div>
        </Show>

        <Show when={blocks.length === 0 && props.sessionStatus !== 'error'}>
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
          class="absolute bottom-4 right-4 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-surface-2 ring-1 ring-white/10 shadow-lg text-text-dim hover:text-text-secondary hover:ring-white/20 transition-colors"
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
            mimeType={img().mimeType}
            data={img().data}
            onClose={() => setViewerImage(null)}
          />
        )}
      </Show>
    </div>
  )
}
