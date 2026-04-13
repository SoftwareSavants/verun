import { Component, createSignal, createEffect, on, Show, For, onMount, onCleanup } from 'solid-js'
import { sendMessage, abortMessage, createSession, clearOutputItems, pendingApprovals, approveToolUse, denyToolUse, answerQuestion, autoApprovedCounts, sessionCosts, sessionTokens, rateLimitInfo, taskPlanMode, setTaskPlanMode, taskThinkingMode, setTaskThinkingMode, taskFastMode, setTaskFastMode, taskPlanFilePath, setTaskPlanFilePath, outputItems, tryDrainSteps } from '../store/sessions'
import { effectiveModel, setTaskModel, setSelectedSessionId, selectedTaskId, editStepRequest, setEditStepRequest, chatPrefillRequest, setChatPrefillRequest } from '../store/ui'
import { isSetupRunning, queueMessage, queuedMessages, clearQueuedMessage } from '../store/setup'
import { addStep, getSteps, updateStep, extractStep } from '../store/steps'
import { ModelSelector } from './ModelSelector'
import { CommandPalette } from './CommandPalette'
import { FileMention } from './FileMention'
import { openFile } from '../store/files'
import type { Command } from '../store/commands'
import { ArrowUp, Square, X, Plus, ShieldAlert, HelpCircle, Shield, ShieldCheck, ListChecks, Zap, Brain, Minimize2, Maximize2, Loader2, Activity, ListPlus, Check } from 'lucide-solid'
import { marked } from 'marked'
import { invoke } from '@tauri-apps/api/core'
import { clsx } from 'clsx'
import type { Attachment, ModelId, TrustLevel } from '../types'
import * as ipc from '../lib/ipc'
import { Popover } from './Popover'
import { ImageViewer } from './ImageViewer'
import { BlobImage } from './BlobImage'
import { serializeAttachments, deserializeAttachments } from '../lib/binary'

interface Props {
  sessionId: string | null
  isRunning: boolean
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_FILE_SIZE = 10 * 1024 * 1024

async function fileToAttachment(file: File): Promise<Attachment | null> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return null
  if (file.size > MAX_FILE_SIZE) return null
  try {
    const buf = await file.arrayBuffer()
    return { name: file.name, mimeType: file.type, data: new Uint8Array(buf) }
  } catch {
    return null
  }
}

// Module-level signal — survives re-renders
const [planExpanded, setPlanExpanded] = createSignal(true)

// ---------------------------------------------------------------------------
// Usage chip + popover (rate limit info + session cost/tokens)
// ---------------------------------------------------------------------------

const [showUsagePopover, setShowUsagePopover] = createSignal(false)

const fmtCost = (c: number) => c < 0.01 ? `$${c.toFixed(4)}` : c < 1 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`
const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

function formatResetTime(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const now = new Date()
  const isToday = d.getUTCDate() === now.getUTCDate() && d.getUTCMonth() === now.getUTCMonth()
  const h = d.getUTCHours()
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  if (isToday) return `${h12}${ampm} (UTC)`
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()} at ${h12}${ampm} (UTC)`
}

function formatTimeUntil(epochSec: number): string {
  const diffMs = epochSec * 1000 - Date.now()
  if (diffMs <= 0) return 'now'
  const h = Math.floor(diffMs / 3_600_000)
  const m = Math.floor((diffMs % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function UsageChip(chipProps: { sessionId: string | null }) {
  const cost = () => {
    const sid = chipProps.sessionId
    return sid ? (sessionCosts[sid] || 0) : 0
  }
  const tokens = () => {
    const sid = chipProps.sessionId
    return sid ? sessionTokens[sid] : undefined
  }

  const chipLabel = () => {
    const c = cost()
    const rl = rateLimitInfo()
    if (c > 0 && rl) return `${fmtCost(c)} · Resets ${formatTimeUntil(rl.resetsAt)}`
    if (c > 0) return fmtCost(c)
    if (rl) return `Resets ${formatTimeUntil(rl.resetsAt)}`
    return 'Usage'
  }

  return (
    <div class="relative">
      <button
        class={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
          rateLimitInfo()?.isUsingOverage
            ? 'text-status-error/80 hover:text-status-error hover:bg-status-error/10'
            : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
        )}
        onClick={() => setShowUsagePopover(!showUsagePopover())}
        title="Usage info"
      >
        <Activity size={13} />
        <span>{chipLabel()}</span>
      </button>
      <Popover open={showUsagePopover()} onClose={() => setShowUsagePopover(false)} class="py-3 px-4 min-w-64 absolute bottom-full left-0 mb-1">
        {/* Rate limit windows */}
        <Show when={rateLimitInfo()}>
          {(() => {
            const rl = rateLimitInfo()!
            return (
              <>
                <div class="mb-3">
                  <div class="text-[11px] font-medium text-text-primary mb-0.5">Current session</div>
                  <div class="text-[10px] text-text-dim">
                    Resets {formatResetTime(rl.resetsAt)}
                  </div>
                </div>
                <Show when={rl.overageResetsAt > 0}>
                  <div class="mb-3">
                    <div class="flex items-center gap-1.5">
                      <span class="text-[11px] font-medium text-text-primary">Overage window</span>
                      <Show when={rl.isUsingOverage}>
                        <span class="text-[9px] px-1 py-0.5 rounded bg-status-error/15 text-status-error font-medium">Active</span>
                      </Show>
                    </div>
                    <div class="text-[10px] text-text-dim mt-0.5">
                      Resets {formatResetTime(rl.overageResetsAt)}
                    </div>
                  </div>
                </Show>
              </>
            )
          })()}
        </Show>

        {/* Session stats */}
        <Show when={cost() > 0 || tokens()}>
          <Show when={rateLimitInfo()}>
            <div class="border-t border-border-subtle my-2.5" />
          </Show>
          <div class="text-[11px] font-medium text-text-primary mb-1.5">This session</div>
          <div class="space-y-1 text-[11px]">
            <Show when={cost() > 0}>
              <div class="flex justify-between gap-6">
                <span class="text-text-dim">Cost</span>
                <span class="text-text-secondary font-mono">{fmtCost(cost())}</span>
              </div>
            </Show>
            <Show when={tokens()}>
              <div class="flex justify-between gap-6">
                <span class="text-text-dim">Input</span>
                <span class="text-text-secondary font-mono">{fmtTokens(tokens()!.input)} tokens</span>
              </div>
              <div class="flex justify-between gap-6">
                <span class="text-text-dim">Output</span>
                <span class="text-text-secondary font-mono">{fmtTokens(tokens()!.output)} tokens</span>
              </div>
            </Show>
          </div>
        </Show>
      </Popover>
    </div>
  )
}

export const MessageInput: Component<Props> = (props) => {
  let fileInputRef!: HTMLInputElement
  let inputRef!: HTMLDivElement
  let customAnswerRef!: HTMLInputElement

  // ── Contenteditable helpers ──────────────────────────────────────────
  // The input is a contenteditable div with text nodes + badge spans.
  // `data-mention` spans are non-editable inline badges.
  // serializeInput() reads the DOM and returns plain text with @path tokens.

  const serializeInput = (): string => {
    if (!inputRef) return ''
    let text = ''
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent ?? '').replace(/\u200B/g, '')
      } else if (node instanceof HTMLElement) {
        if (node.dataset.mention) {
          text += `@${node.dataset.mention}`
        } else if (node.tagName === 'BR') {
          text += '\n'
        } else {
          for (const child of node.childNodes) walk(child)
        }
      }
    }
    for (const child of inputRef.childNodes) walk(child)
    // Browser may leave a trailing <br> → lone '\n'; treat as empty
    return text === '\n' ? '' : text
  }

  const setInputContent = (text: string) => {
    if (!inputRef) return
    // Parse text into mixed text nodes + badge elements
    inputRef.innerHTML = ''
    const mentionRe = /@([^\s]+)/g
    let lastIndex = 0
    for (const match of text.matchAll(mentionRe)) {
      const start = match.index!
      if (start > lastIndex) {
        inputRef.appendChild(document.createTextNode(text.slice(lastIndex, start)))
      }
      inputRef.appendChild(wrapBadge(createMentionBadge(match[1])))
      lastIndex = start + match[0].length
    }
    if (lastIndex < text.length) {
      inputRef.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    autoResizeInput()
  }

  const ZWS = '\u200B' // zero-width space — cursor landing pad around badges

  const createMentionBadge = (filePath: string): HTMLSpanElement => {
    const span = document.createElement('span')
    span.dataset.mention = filePath
    span.contentEditable = 'false'
    span.className = 'inline-flex items-center gap-1 rounded-md font-mono border px-1.5 py-0.5 text-xs bg-accent/10 border-accent/15 hover:bg-accent/20 transition-colors cursor-pointer align-baseline mx-0.5 select-all'
    span.title = filePath
    const name = filePath.split('/').pop() ?? filePath
    span.textContent = name
    span.addEventListener('click', () => {
      const tid = selectedTaskId()
      if (tid) openFile(tid, filePath, name)
    })
    return span
  }

  /** Wrap a badge with ZWS text nodes so the cursor can land before/after it */
  const wrapBadge = (badge: HTMLSpanElement): DocumentFragment => {
    const frag = document.createDocumentFragment()
    frag.appendChild(document.createTextNode(ZWS))
    frag.appendChild(badge)
    frag.appendChild(document.createTextNode(ZWS))
    return frag
  }

  const getCursorOffset = (): number => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !inputRef) return 0
    const range = sel.getRangeAt(0)
    const preRange = document.createRange()
    preRange.setStart(inputRef, 0)
    preRange.setEnd(range.startContainer, range.startOffset)
    // Serialize the pre-cursor content to count the offset in text terms
    const frag = preRange.cloneContents()
    const tmp = document.createElement('div')
    tmp.appendChild(frag)
    let offset = 0
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += (node.textContent ?? '').replace(/\u200B/g, '').length
      } else if (node instanceof HTMLElement) {
        if (node.dataset.mention) {
          offset += node.dataset.mention.length + 1 // @path
        } else if (node.tagName === 'BR') {
          offset += 1
        } else {
          for (const child of node.childNodes) walk(child)
        }
      }
    }
    for (const child of tmp.childNodes) walk(child)
    return offset
  }

  const setCursorToEnd = () => {
    if (!inputRef) return
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(inputRef)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const autoResizeInput = () => {
    if (!inputRef) return
    inputRef.style.height = 'auto'
    inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + 'px'
  }
  // Drafts are keyed by sessionId so each session inside a task has its own
  // composer text + attachments. Task-scoped settings (plan mode, model,
  // trust level, …) are still keyed by taskId further down.
  const [sessionMessages, setSessionMessages] = createSignal<Record<string, string>>({})
  const [sessionAttachments, setSessionAttachments] = createSignal<Record<string, Attachment[]>>({})
  const [viewerAttachment, setViewerAttachment] = createSignal<Attachment | null>(null)
  const message = () => sessionMessages()[props.sessionId ?? ''] ?? ''

  // Debounced localStorage persistence for drafts
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
  const persistDraft = (sid: string) => {
    if (draftSaveTimer) clearTimeout(draftSaveTimer)
    draftSaveTimer = setTimeout(() => {
      const msg = sessionMessages()[sid] ?? ''
      const atts = sessionAttachments()[sid] ?? []
      if (msg) localStorage.setItem(`verun:draft-msg:${sid}`, msg)
      else localStorage.removeItem(`verun:draft-msg:${sid}`)
      if (atts.length > 0) localStorage.setItem(`verun:draft-att:${sid}`, serializeAttachments(atts))
      else localStorage.removeItem(`verun:draft-att:${sid}`)
    }, 500)
  }
  const clearPersistedDraft = (sid: string) => {
    if (draftSaveTimer) clearTimeout(draftSaveTimer)
    localStorage.removeItem(`verun:draft-msg:${sid}`)
    localStorage.removeItem(`verun:draft-att:${sid}`)
  }

  const setMessageRaw = (v: string) => {
    const sid = props.sessionId
    if (sid) {
      setSessionMessages(prev => ({ ...prev, [sid]: v }))
      // Clear persisted draft immediately when emptied (message sent), debounce otherwise
      if (v === '' && !sessionAttachments()[sid]?.length) clearPersistedDraft(sid)
      else persistDraft(sid)
    }
  }
  /** Set message signal + sync the contenteditable DOM */
  const setMessage = (v: string) => {
    setMessageRaw(v)
    if (!inputRef) return
    // Sync DOM when set programmatically (not from handleInput which already has the DOM right)
    const current = serializeInput()
    if (current !== v) {
      if (v === '') {
        inputRef.textContent = ''
      } else {
        setInputContent(v)
        setCursorToEnd()
      }
    }
  }
  const attachments = () => sessionAttachments()[props.sessionId ?? ''] ?? []
  const setAttachments = (v: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    const sid = props.sessionId
    if (!sid) return
    const resolved = typeof v === 'function' ? v(sessionAttachments()[sid] ?? []) : v
    setSessionAttachments(prev => ({ ...prev, [sid]: resolved }))
    if (resolved.length === 0 && !sessionMessages()[sid]) clearPersistedDraft(sid)
    else persistDraft(sid)
  }
  const [sending, setSending] = createSignal(false)
  const [dragOver, setDragOver] = createSignal(false)
  const [showPalette, setShowPalette] = createSignal(false)
  const [showFileMention, setShowFileMention] = createSignal(false)
  const [fileMentionQuery, setFileMentionQuery] = createSignal('')
  const [worktreeFiles, setWorktreeFiles] = createSignal<string[]>([])
  const [filesLoaded, setFilesLoaded] = createSignal<string | null>(null)
  const [trustLevel, setTrustLevelLocal] = createSignal<TrustLevel>('normal')
  const [showTrustMenu, setShowTrustMenu] = createSignal(false)

  // Edit last message state — ArrowUp loads last user/queued message, Escape restores draft
  const [editingMessageIdx, setEditingMessageIdx] = createSignal<number | null>(null)
  const [editingStepId, setEditingStepId] = createSignal<string | null>(null)
  const [savedDraft, setSavedDraft] = createSignal<string>('')
  const [savedDraftAttachments, setSavedDraftAttachments] = createSignal<Attachment[]>([])

  // React to edit requests from StepList (clicking Edit on a step)
  createEffect(on(editStepRequest, (req) => {
    if (!req) return
    setEditStepRequest(null) // consume the request
    setSavedDraft(message())
    setSavedDraftAttachments(attachments())
    setEditingStepId(req.stepId)
    setMessage(req.message)
    // Restore step's attachments into the input
    const stepAttachments: Attachment[] = req.attachmentsJson ? deserializeAttachments(req.attachmentsJson) : []
    setAttachments(stepAttachments)
    requestAnimationFrame(() => {
      if (inputRef) {
        setInputContent(req.message)
        setCursorToEnd()
        inputRef.focus()
      }
    })
  }))

  // React to prefill requests from the editor's merged hover ("Ask agent to fix")
  createEffect(on(chatPrefillRequest, (req) => {
    if (!req) return
    setChatPrefillRequest(null) // consume
    setMessage(req.text)
    requestAnimationFrame(() => {
      if (inputRef) {
        setInputContent(req.text)
        setCursorToEnd()
        inputRef.focus()
      }
    })
  }))

  // Load trust level when task changes + reset file cache
  createEffect(on(selectedTaskId, async (taskId) => {
    setFilesLoaded(null)
    setWorktreeFiles([])
    if (taskId) {
      try {
        const level = await ipc.getTrustLevel(taskId) as TrustLevel
        setTrustLevelLocal(level)
      } catch { /* default to normal */ }
    }
  }))

  // Restore persisted draft when the visible session changes
  createEffect(on(() => props.sessionId, (sid) => {
    if (!sid) return
    if (!sessionMessages()[sid]) {
      const savedMsg = localStorage.getItem(`verun:draft-msg:${sid}`)
      if (savedMsg) setSessionMessages(prev => ({ ...prev, [sid]: savedMsg }))
    }
    if (!sessionAttachments()[sid]?.length) {
      try {
        const savedAtt = localStorage.getItem(`verun:draft-att:${sid}`)
        if (savedAtt) setSessionAttachments(prev => ({ ...prev, [sid]: deserializeAttachments(savedAtt) }))
      } catch { /* ignore corrupt data */ }
    }
    // Sync the contenteditable DOM to the restored draft
    if (inputRef) {
      const msg = sessionMessages()[sid] ?? ''
      if (serializeInput() !== msg) {
        if (msg === '') inputRef.textContent = ''
        else { setInputContent(msg); setCursorToEnd() }
      }
    }
  }))

  const handleTrustChange = async (level: TrustLevel) => {
    const taskId = selectedTaskId()
    if (!taskId) return
    await ipc.setTrustLevel(taskId, level)
    setTrustLevelLocal(level)
    setShowTrustMenu(false)
  }

  const autoApprovedCount = () => {
    const sid = props.sessionId
    return sid ? (autoApprovedCounts[sid] || 0) : 0
  }

  // Plan mode — per-session state, backed by the persisted store
  const [planResponseSession, setPlanResponseSession] = createSignal<string | null>(null)
  const [planFeedback, setPlanFeedback] = createSignal('')

  const planMode = () => {
    const tid = selectedTaskId()
    return tid ? (taskPlanMode[tid] ?? false) : false
  }

  const setPlanMode = (on: boolean) => {
    const tid = selectedTaskId()
    if (!tid) return
    setTaskPlanMode(tid, on)
  }

  const thinkingMode = () => {
    const tid = selectedTaskId()
    return tid ? (taskThinkingMode[tid] ?? true) : true
  }

  const setThinking = (on: boolean) => {
    const tid = selectedTaskId()
    if (!tid) return
    setTaskThinkingMode(tid, on)
  }

  const fastMode = () => {
    const tid = selectedTaskId()
    return tid ? (taskFastMode[tid] ?? false) : false
  }

  const setFast = (on: boolean) => {
    const tid = selectedTaskId()
    if (!tid) return
    setTaskFastMode(tid, on)
  }

  const showPlanResponse = () => {
    const sid = props.sessionId
    // Don't show the simple panel when the full plan viewer is active
    if (showPlanViewer() && planContent()) return false
    return sid !== null && planResponseSession() === sid && !currentApproval()
  }

  const setShowPlanResponse = (show: boolean) => {
    if (show) {
      setPlanResponseSession(props.sessionId)
    } else {
      // Only clear if it matches the current session
      if (planResponseSession() === props.sessionId) {
        setPlanResponseSession(null)
      }
    }
  }

  // Detect when plan response should show:
  // 1. Running → idle transition with plan mode on
  // 2. Session loaded (e.g. app restart) with plan mode on and already idle
  createEffect(on(
    () => [props.isRunning, planMode(), props.sessionId] as const,
    ([running, plan, sid], prev) => {
      if (!plan || !sid) return
      // Was running, now idle → show plan response
      if (prev && prev[0] && !running) {
        setPlanResponseSession(sid)
      }
      // Session just selected, already idle, plan mode on → show plan response
      if (!running && (!prev || prev[2] !== sid)) {
        setPlanResponseSession(sid)
      }
    }
  ))

  const handleApprovePlan = () => {
    const sid = props.sessionId
    if (!sid) return
    setPlanMode(false)
    setShowPlanResponse(false)
    sendMessage(sid, 'The plan is approved. Please implement it now.', undefined, currentModel(), false)
  }

  // Handles both live ExitPlanMode approval and persisted plan viewer
  const handlePlanViewerAction = (feedback: string) => {
    const sid = props.sessionId
    if (!sid) return
    const approval = currentApproval()
    if (feedback) {
      // Request changes
      setPlanChanges('')
      if (approval && isExitPlanMode()) {
        denyToolUse(approval.requestId, approval.sessionId)
      }
      sendMessage(sid, feedback, undefined, currentModel(), true)
    } else {
      // Approve — always send a message so plan_mode: false gets persisted
      setPlanMode(false)
      const tid = selectedTaskId()
      if (tid) setTaskPlanFilePath(tid, null)
      if (approval && isExitPlanMode()) {
        approveToolUse(approval.requestId, approval.sessionId)
      }
      // Send implementation message (persists plan_mode: false so restart doesn't re-show)
      sendMessage(sid, 'The plan is approved. Please implement it now.', undefined, currentModel(), false)
    }
  }

  const handlePlanFeedback = () => {
    const text = planFeedback().trim()
    if (!text) return
    const sid = props.sessionId
    if (!sid) return
    setShowPlanResponse(false)
    setPlanFeedback('')
    sendMessage(sid, text, undefined, currentModel(), true)
  }

  const currentModel = () => effectiveModel(selectedTaskId())

  const currentApproval = () => {
    const sid = props.sessionId
    if (!sid) return null
    const list = pendingApprovals[sid]
    return list && list.length > 0 ? list[0] : null
  }

  const isExitPlanMode = () => currentApproval()?.toolName === 'ExitPlanMode'
  const [planFileContent, setPlanFileContent] = createSignal<string | null>(null)
  const [planFilePathSignal, setPlanFilePathSignal] = createSignal<string | null>(null)

  // Whether to show the full plan viewer (live approval OR persisted plan file)
  const showPlanViewer = () => {
    // Never show while session is running (implementing)
    if (props.isRunning && !isExitPlanMode()) return false
    if (isExitPlanMode()) return true
    // No live approval, but plan mode on + idle + have plan file → show viewer
    const tid = selectedTaskId()
    if (tid && planMode() && !props.isRunning && taskPlanFilePath[tid] && planFileContent()) return true
    return false
  }

  // Load plan file content — from live approval or persisted path
  createEffect(on(
    () => [isExitPlanMode(), props.sessionId, planMode()] as const,
    async ([isExit, _sid]) => {
      // From live ExitPlanMode approval
      if (isExit) {
        const approval = currentApproval()
        if (!approval) return
        const inlinePlan = approval.toolInput.plan as string | undefined
        const filePath = approval.toolInput.planFilePath as string | undefined
        setPlanFilePathSignal(filePath || null)
        if (inlinePlan) {
          setPlanFileContent(inlinePlan)
        } else if (filePath) {
          try {
            const content = await invoke<string>('read_text_file', { path: filePath })
            setPlanFileContent(content)
          } catch {
            setPlanFileContent('*Could not read plan file.*')
          }
        }
        return
      }
      // From persisted plan file path (e.g. after restart)
      const tid = selectedTaskId()
      if (tid && planMode()) {
        const filePath = taskPlanFilePath[tid]
        if (filePath) {
          setPlanFilePathSignal(filePath)
          try {
            const content = await invoke<string>('read_text_file', { path: filePath })
            setPlanFileContent(content)
          } catch {
            setPlanFileContent(null)
          }
          return
        }
      }
      setPlanFileContent(null)
      setPlanFilePathSignal(null)
    }
  ))

  const planContent = () => {
    const content = planFileContent()
    if (!content) return null
    return { plan: content, filePath: planFilePathSignal() }
  }
  const [planChanges, setPlanChanges] = createSignal('')

  const pendingCount = () => {
    const sid = props.sessionId
    if (!sid) return 0
    return pendingApprovals[sid]?.length ?? 0
  }

  // AskUserQuestion state
  const isQuestion = () => currentApproval()?.toolName === 'AskUserQuestion'
  const questions = () => {
    const approval = currentApproval()
    if (!approval || !isQuestion()) return []
    const qs = approval.toolInput.questions
    return Array.isArray(qs) ? qs as Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> : []
  }
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [questionAnswers, setQuestionAnswers] = createSignal<Record<string, string>>({})
  const [customAnswers, setCustomAnswers] = createSignal<Record<string, string>>({})
  const [isCustomSelected, setIsCustomSelected] = createSignal<Record<string, boolean>>({})
  const currentQuestion = () => questions()[questionIndex()]
  const customAnswer = () => customAnswers()[currentQuestion()?.question ?? ''] ?? ''
  const setCustomAnswer = (val: string) => {
    const q = currentQuestion()
    if (q) setCustomAnswers(prev => ({ ...prev, [q.question]: val }))
  }

  // Reset question state when approval changes
  createEffect(on(() => currentApproval()?.requestId, () => {
    setQuestionIndex(0)
    setQuestionAnswers({})
    setCustomAnswers({})
    setIsCustomSelected({})
  }))

  // Sync contenteditable DOM when task changes (each task has its own message)
  createEffect(on(selectedTaskId, () => {
    setPlanFeedback('')
    if (inputRef) {
      const msg = message()
      if (msg) {
        setInputContent(msg)
      } else {
        inputRef.textContent = ''
      }
      inputRef.style.height = 'auto'
      if (props.sessionId) {
        requestAnimationFrame(() => { inputRef.focus(); setCursorToEnd() })
      }
    }
  }))

  // Auto-focus input when user starts typing anywhere
  onMount(() => {
    requestAnimationFrame(() => {
      if (inputRef && props.sessionId) inputRef.focus()
    })

    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      if (active && ((active as HTMLElement).isContentEditable || active.closest('.cm-editor'))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return // non-printable
      if (!inputRef || !props.sessionId) return

      inputRef.focus()
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  // Refocus input when the window regains focus
  onMount(() => {
    const handler = () => {
      if (inputRef && props.sessionId) {
        requestAnimationFrame(() => inputRef.focus())
      }
    }
    window.addEventListener('focus', handler)
    onCleanup(() => window.removeEventListener('focus', handler))
  })

  // Re-evaluate overlays when cursor moves (arrow keys, click to reposition)
  onMount(() => {
    let raf = 0
    const handler = () => {
      if (!inputRef || document.activeElement !== inputRef) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => updateOverlays())
    }
    document.addEventListener('selectionchange', handler)
    onCleanup(() => {
      document.removeEventListener('selectionchange', handler)
      cancelAnimationFrame(raf)
    })
  })

  const addFiles = async (files: FileList | File[]) => {
    const results = await Promise.all(Array.from(files).map(fileToAttachment))
    const valid = results.filter((a): a is Attachment => a !== null)
    if (valid.length > 0) {
      setAttachments(prev => [...prev, ...valid])
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const handleSend = async () => {
    const sid = props.sessionId
    const msg = message().trim()
    const atts = attachments()
    if (!sid || (!msg && atts.length === 0) || sending()) return

    const tid = selectedTaskId()

    // If setup hook is still running, queue the message for auto-send on completion
    if (tid && isSetupRunning(tid)) {
      queueMessage(tid, {
        sessionId: sid,
        message: msg,
        attachments: atts.length > 0 ? atts : undefined,
        model: currentModel(),
        planMode: planMode(),
        thinkingMode: thinkingMode(),
        fastMode: fastMode(),
      })
      setMessage('')
      setAttachments([])
      setShowPalette(false)
      return
    }

    setSending(true)
    setEditingMessageIdx(null)
    setEditingStepId(null)
    setSavedDraft('')
    setMessage('')
    setAttachments([])
    setShowPalette(false)
    try {
      await sendMessage(sid, msg, atts.length > 0 ? atts : undefined, currentModel(), planMode(), thinkingMode(), fastMode())
    } catch (e) {
      console.error('Failed to send message:', e)
    } finally {
      setSending(false)
    }
  }

  const handleAbort = async () => {
    const sid = props.sessionId
    if (sid) await abortMessage(sid)
  }

  const handleAddStep = (armed: boolean) => {
    const sid = props.sessionId
    const msg = message().trim()
    const atts = attachments()
    if (!sid || (!msg && atts.length === 0)) return

    addStep({
      sessionId: sid,
      message: msg,
      attachments: atts.length > 0 ? atts : undefined,
      armed,
      model: currentModel(),
      planMode: planMode(),
      thinkingMode: thinkingMode(),
      fastMode: fastMode(),
    })
    setMessage('')
    setAttachments([])
    setShowPalette(false)
  }

  const handleSteer = async () => {
    const sid = props.sessionId
    const msg = message().trim()
    const atts = attachments()
    if (!sid || (!msg && atts.length === 0)) return

    setMessage('')
    setAttachments([])
    setShowPalette(false)
    setSending(true)
    try {
      await abortMessage(sid)
      await sendMessage(sid, msg, atts.length > 0 ? atts : undefined, currentModel(), planMode(), thinkingMode(), fastMode())
    } catch (e) {
      console.error('Failed to steer:', e)
    } finally {
      setSending(false)
    }
  }

  const handleFireNextStep = async () => {
    const sid = props.sessionId
    if (!sid) return
    const steps = getSteps(sid)
    if (steps.length === 0) return
    const step = extractStep(sid, steps[0].id)
    if (!step) return
    const atts = step.attachmentsJson ? JSON.parse(step.attachmentsJson) : undefined
    await sendMessage(sid, step.message, atts, step.model ?? undefined, step.planMode ?? undefined, step.thinkingMode ?? undefined, step.fastMode ?? undefined)
  }

  const handleAppCommand = async (cmd: Command) => {
    switch (cmd.name) {
      case 'new-session': {
        const tid = selectedTaskId()
        if (tid) {
          const session = await createSession(tid)
          setSelectedSessionId(session.id)
        }
        break
      }
      case 'clear': {
        const sid = props.sessionId
        if (sid) clearOutputItems(sid)
        break
      }
      case 'model': {
        // Extract model from remaining text, e.g. "/model opus"
        const parts = message().trim().split(/\s+/)
        const modelArg = parts[1] as ModelId | undefined
        const modelTaskId = selectedTaskId()
        if (modelArg && ['opus', 'sonnet', 'haiku'].includes(modelArg) && modelTaskId) {
          setTaskModel(modelTaskId, modelArg)
        }
        break
      }
      case 'plan': {
        setPlanMode(!planMode())
        break
      }
    }
    setMessage('')
    setShowPalette(false)
  }

  const handleCommandSelect = async (cmd: Command) => {
    if (cmd.category === 'app') {
      // For /model, prefill the command and let user type the model name
      if (cmd.name === 'model') {
        setMessage('/model ')
        setShowPalette(false)
        return
      }
      handleAppCommand(cmd)
    } else {
      // Claude skill — send as message
      setMessage(`/${cmd.name}`)
      setShowPalette(false)
      // Auto-send claude skills immediately
      const sid = props.sessionId
      if (sid && !sending()) {
        setSending(true)
        setMessage('')
        try {
          await sendMessage(sid, `/${cmd.name}`, undefined, currentModel())
        } catch (e) {
          console.error('Failed to send skill:', e)
        } finally {
          setSending(false)
        }
      }
    }
  }

  const handleFileMentionSelect = (filePath: string) => {
    if (!inputRef) return
    setShowFileMention(false)

    // Find and remove the @query text from the DOM, then insert badge + space
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const textNode = range.startContainer
    if (textNode.nodeType !== Node.TEXT_NODE) return

    const text = textNode.textContent ?? ''
    const cursorPos = range.startOffset
    // Walk backwards to find the @ trigger
    let atIdx = cursorPos - 1
    while (atIdx >= 0 && text[atIdx] !== '@') atIdx--
    // Also account for possible space before @
    const beforeAt = text.slice(0, atIdx)
    const afterCursor = text.slice(cursorPos)

    // Replace the text node: [beforeAt] [ZWS badge ZWS] [space + afterCursor]
    const parent = textNode.parentNode!
    const beforeNode = document.createTextNode(beforeAt)
    const wrapped = wrapBadge(createMentionBadge(filePath))
    const afterNode = document.createTextNode(' ' + afterCursor)

    parent.insertBefore(beforeNode, textNode)
    parent.insertBefore(wrapped, textNode)
    parent.insertBefore(afterNode, textNode)
    parent.removeChild(textNode)

    // Place cursor after the space
    const newRange = document.createRange()
    newRange.setStart(afterNode, 1)
    newRange.collapse(true)
    sel.removeAllRanges()
    sel.addRange(newRange)

    setMessageRaw(serializeInput())
    autoResizeInput()
    inputRef.focus()
  }

  const handleCancelEdit = () => {
    const draft = savedDraft()
    const draftAtts = savedDraftAttachments()
    setEditingMessageIdx(null)
    setEditingStepId(null)
    setSavedDraft('')
    setSavedDraftAttachments([])
    setMessage(draft)
    setAttachments(draftAtts)
    requestAnimationFrame(() => {
      if (inputRef) {
        setInputContent(draft)
        autoResizeInput()
      }
    })
  }

  const handleSaveEdit = () => {
    const esId = editingStepId()
    if (esId && props.sessionId) {
      const editedMsg = message().trim()
      const atts = attachments()
      if (editedMsg) {
        updateStep(props.sessionId, esId, {
          message: editedMsg,
          model: currentModel(),
          planMode: planMode(),
          thinkingMode: thinkingMode(),
          fastMode: fastMode(),
          attachmentsJson: atts.length > 0 ? JSON.stringify(atts) : null,
        })
      }
      setEditingStepId(null)
      setSavedDraft('')
      setSavedDraftAttachments([])
      setMessage('')
      setAttachments([])
      setShowPalette(false)
      if (!props.isRunning) {
        tryDrainSteps(props.sessionId)
      }
      return true
    }
    return false
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // Forward to file mention if open
    if (showFileMention()) {
      const handler = (window as any).__fileMentionKeyDown
      if (handler && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key)) {
        handler(e)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        handler?.(e)
        return
      }
    }

    // Forward to command palette if open
    if (showPalette()) {
      const handler = (window as any).__commandPaletteKeyDown
      if (handler && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key)) {
        handler(e)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        handler?.(e)
        return
      }
    }

    // Arrow keys — skip over ZWS nodes and badges.
    // Given cursor position, find where to jump to skip the badge group.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && inputRef) {
      const right = e.key === 'ArrowRight'

      const findSkipTarget = (): { node: Node; offset: number } | null => {
        const sel = window.getSelection()
        if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null
        const range = sel.getRangeAt(0)
        const node = range.startContainer
        const off = range.startOffset

        // Helper: given a ZWS node, find the real text node past the badge group
        const skipFromZws = (zwsNode: Node): { node: Node; offset: number } | null => {
          const sib = right ? zwsNode.nextSibling : zwsNode.previousSibling
          if (!sib) return null
          if (sib.nodeType === Node.TEXT_NODE && sib.textContent !== ZWS) {
            return { node: sib, offset: right ? 0 : (sib.textContent?.length ?? 0) }
          }
          if (sib instanceof HTMLElement && sib.dataset.mention) {
            const far = right ? sib.nextSibling : sib.previousSibling
            if (far?.nodeType === Node.TEXT_NODE && far.textContent === ZWS) {
              const real = right ? far.nextSibling : far.previousSibling
              if (real?.nodeType === Node.TEXT_NODE) {
                return { node: real, offset: right ? 0 : (real.textContent?.length ?? 0) }
              }
              const idx = Array.from(inputRef.childNodes).indexOf(far as ChildNode)
              return { node: inputRef, offset: right ? idx + 1 : idx }
            }
          }
          if (sib.nodeType === Node.TEXT_NODE && sib.textContent === ZWS) {
            return skipFromZws(sib)
          }
          return null
        }

        // Case 1: cursor is on a ZWS
        if (node.nodeType === Node.TEXT_NODE && node.textContent === ZWS) {
          return skipFromZws(node)
        }
        // Case 2: cursor at edge of a text node, about to enter ZWS
        if (node.nodeType === Node.TEXT_NODE) {
          const atEdge = right ? off === (node.textContent?.length ?? 0) : off === 0
          if (atEdge) {
            const sib = right ? node.nextSibling : node.previousSibling
            if (sib?.nodeType === Node.TEXT_NODE && sib.textContent === ZWS) {
              return skipFromZws(sib)
            }
          }
        }
        // Case 3: cursor at container level
        if (node === inputRef) {
          const child = right ? inputRef.childNodes[off] : inputRef.childNodes[off - 1]
          if (child?.nodeType === Node.TEXT_NODE && child.textContent === ZWS) {
            return skipFromZws(child)
          }
        }
        return null
      }

      if (e.altKey) {
        // Option+Arrow: let browser handle word jump natively, then fix up
        // if the cursor landed on or crossed a ZWS/badge zone.
        requestAnimationFrame(() => {
          const sel = window.getSelection()
          if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return
          const range = sel.getRangeAt(0)
          const node = range.startContainer
          // If landed on a ZWS, skip past the badge group
          if (node.nodeType === Node.TEXT_NODE && node.textContent === ZWS) {
            const target = findSkipTarget()
            if (target) {
              const newRange = document.createRange()
              newRange.setStart(target.node, target.offset)
              newRange.collapse(true)
              sel.removeAllRanges()
              sel.addRange(newRange)
            }
          }
        })
      } else {
        // Plain arrow: intercept synchronously
        const target = findSkipTarget()
        if (target) {
          e.preventDefault()
          const sel = window.getSelection()!
          const newRange = document.createRange()
          newRange.setStart(target.node, target.offset)
          newRange.collapse(true)
          sel.removeAllRanges()
          sel.addRange(newRange)
        }
      }
    }

    // Backspace/Delete adjacent to a badge — remove the badge + its ZWS wrappers
    if ((e.key === 'Backspace' || e.key === 'Delete') && inputRef) {
      const sel = window.getSelection()
      if (sel && sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        const node = range.startContainer
        const offset = range.startOffset

        // Helper: remove a badge and all its surrounding ZWS nodes
        const removeBadge = (badge: HTMLElement) => {
          e.preventDefault()
          // Collect all ZWS siblings around the badge
          const toRemove: Node[] = [badge]
          let sib = badge.previousSibling
          while (sib?.nodeType === Node.TEXT_NODE && sib.textContent === ZWS) {
            toRemove.push(sib)
            sib = sib.previousSibling
          }
          sib = badge.nextSibling
          while (sib?.nodeType === Node.TEXT_NODE && sib.textContent === ZWS) {
            toRemove.push(sib)
            sib = sib.nextSibling
          }
          // Also remove the current node if it's a ZWS
          if (node !== badge && node.nodeType === Node.TEXT_NODE && node.textContent === ZWS) {
            toRemove.push(node)
          }
          for (const n of toRemove) n.parentNode?.removeChild(n)
          setMessageRaw(serializeInput())
          autoResizeInput()
        }

        // Check if we're in a ZWS text node next to a badge
        if (node.nodeType === Node.TEXT_NODE && node.textContent === ZWS) {
          const sibling = e.key === 'Backspace' ? node.previousSibling : node.nextSibling
          if (sibling instanceof HTMLElement && sibling.dataset.mention) {
            removeBadge(sibling)
          }
        }
        // Check if cursor is at a position in the parent where sibling is a badge
        else if (node === inputRef || node.nodeType === Node.ELEMENT_NODE) {
          const children = Array.from((node === inputRef ? inputRef : node).childNodes)
          const idx = e.key === 'Backspace' ? offset - 1 : offset
          const target = children[idx]
          if (target instanceof HTMLElement && target.dataset.mention) {
            removeBadge(target)
          }
        }
      }
    }

    // Cmd+Enter
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      if (props.isRunning) {
        handleSteer() // abort + send immediately
      } else {
        handleFireNextStep() // fire next step from list
      }
      return
    }

    // Shift+Enter while running = add armed step
    if (e.key === 'Enter' && e.shiftKey && props.isRunning) {
      e.preventDefault()
      handleAddStep(true)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      // Check if it's a slash command (app or claude)
      const msg = message().trim()
      if (msg.startsWith('/')) {
        const cmdName = msg.slice(1).split(/\s+/)[0]
        const appCmds = ['new-session', 'clear', 'model', 'plan']
        if (appCmds.includes(cmdName)) {
          handleAppCommand({ name: cmdName, description: '', category: 'app' })
          return
        }
      }
      // If editing a step, save the edit back
      if (handleSaveEdit()) return
      if (props.isRunning) {
        handleAddStep(false) // add paused step
      } else {
        handleSend()
      }
    }

    // ArrowUp with empty input — edit last step or last unsent user message
    if (e.key === 'ArrowUp' && editingMessageIdx() === null && editingStepId() === null) {
      if (!message().trim() && inputRef && getCursorOffset() === 0) {
        const sid = props.sessionId
        if (!sid) return

        // Check steps first — edit the last step
        const steps = getSteps(sid)
        if (steps.length > 0) {
          const last = steps[steps.length - 1]
          e.preventDefault()
          setSavedDraft(message())
          setSavedDraftAttachments(attachments())
          setEditingStepId(last.id)
          setMessage(last.message)
          const stepAtts: Attachment[] = last.attachmentsJson ? JSON.parse(last.attachmentsJson) : []
          setAttachments(stepAtts)
          requestAnimationFrame(() => {
            if (inputRef) {
              setInputContent(last.message)
              setCursorToEnd()
            }
          })
          return
        }

        // No steps — check if last output item is an unsent user message
        if (!props.isRunning) {
          const items = outputItems[sid]
          if (!items) return
          const lastItem = items[items.length - 1]
          if (lastItem?.kind === 'userMessage') {
            e.preventDefault()
            setSavedDraft(message())
            setEditingMessageIdx(items.length - 1)
            const text = (lastItem as { text: string }).text
            setMessage(text)
            requestAnimationFrame(() => {
              if (inputRef) {
                setInputContent(text)
                setCursorToEnd()
              }
            })
          }
        }
      }
    }

    // Escape while editing — restore saved draft
    if (e.key === 'Escape' && (editingMessageIdx() !== null || editingStepId() !== null)) {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  const handleInput = () => {
    const val = serializeInput()
    setMessageRaw(val)
    autoResizeInput()
    // Clean up stale browser artifacts when empty
    if (val.length === 0 && inputRef && inputRef.childNodes.length > 0) {
      inputRef.textContent = ''
    }

    // /plan + space → toggle plan mode and clear
    if (val === '/plan ') {
      setPlanMode(!planMode())
      setMessageRaw('')
      setShowPalette(false)
      if (inputRef) inputRef.textContent = ''
      return
    }

    updateOverlays(val)
  }

  /** Check cursor position and show/hide command palette + file mention overlay */
  const updateOverlays = (val?: string) => {
    if (val === undefined) val = message()

    // Show/hide command palette
    if (val.startsWith('/') && val.indexOf(' ') === -1) {
      setShowPalette(true)
    } else {
      setShowPalette(false)
    }

    // Detect @ file mentions
    const cursorPos = getCursorOffset()
    const textBeforeCursor = val.slice(0, cursorPos)
    // Find the last @ that's either at start or after a space
    const atMatch = textBeforeCursor.match(/(?:^|[\s])@([^\s]*)$/)
    if (atMatch) {
      const query = atMatch[1]
      setFileMentionQuery(query)
      setShowFileMention(true)

      // Load files lazily on first @
      const tid = selectedTaskId()
      if (tid && filesLoaded() !== tid) {
        setFilesLoaded(tid)
        ipc.listWorktreeFiles(tid).then(setWorktreeFiles).catch(() => {})
      }
    } else {
      setShowFileMention(false)
    }
  }

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && SUPPORTED_IMAGE_TYPES.has(item.type)) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      await addFiles(files)
      return
    }
    // Plain text paste — strip HTML formatting from contenteditable
    const text = e.clipboardData?.getData('text/plain')
    if (text) {
      e.preventDefault()
      document.execCommand('insertText', false, text)
    }
  }

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true) }
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); setDragOver(false) }
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) await addFiles(files)
  }


  // Keyboard shortcuts for approval/question UI
  onMount(() => {
    const approvalKeyHandler = (e: KeyboardEvent) => {
      // Plan response: Enter to approve (only when feedback input isn't focused)
      if (showPlanResponse() && !currentApproval()) {
        const active = document.activeElement
        const isInputFocused = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
        if (e.key === 'Enter' && !e.shiftKey && !isInputFocused) {
          e.preventDefault()
          handleApprovePlan()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowPlanResponse(false)
          return
        }
        return
      }

      const approval = currentApproval()
      if (!approval) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // AskUserQuestion: number keys select options, Escape to skip
      if (isQuestion()) {
        if (e.key === 'Escape') {
          e.preventDefault()
          denyToolUse(approval.requestId, approval.sessionId)
          return
        }
        const q = currentQuestion()
        if (!q) return
        const num = parseInt(e.key)
        const optCount = q.options?.length ?? 0
        if (num >= 1 && num <= optCount) {
          e.preventDefault()
          selectQuestionOption(q.options![num - 1].label)
        } else if (num === optCount + 1) {
          e.preventDefault()
          customAnswerRef?.focus()
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          const qs = questions()
          if (questionIndex() < qs.length - 1) {
            setQuestionIndex(i => i + 1)
          } else {
            submitQuestionAnswers()
          }
        }
        return
      }

      // Skip shortcuts when plan viewer is active (it has its own input)
      if (showPlanViewer()) return

      // Skip y/n shortcuts when an input is focused
      const active = document.activeElement
      const isInputFocused = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')

      // Tool approval: Enter = Allow, Escape = Deny, y/n only when not typing
      if (e.key === 'Enter' && !isInputFocused) {
        e.preventDefault()
        approveToolUse(approval.requestId, approval.sessionId)
      } else if (e.key === 'y' && !isInputFocused) {
        e.preventDefault()
        approveToolUse(approval.requestId, approval.sessionId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        denyToolUse(approval.requestId, approval.sessionId)
      } else if (e.key === 'n' && !isInputFocused) {
        e.preventDefault()
        denyToolUse(approval.requestId, approval.sessionId)
      }
    }
    window.addEventListener('keydown', approvalKeyHandler)
    onCleanup(() => window.removeEventListener('keydown', approvalKeyHandler))
  })

  const selectQuestionOption = (label: string) => {
    const q = currentQuestion()
    if (!q) return
    setIsCustomSelected(prev => ({ ...prev, [q.question]: false }))

    if (q.multiSelect) {
      // Toggle selection in comma-separated list
      setQuestionAnswers(prev => {
        const current = prev[q.question] || ''
        const selected = current ? current.split(', ') : []
        const idx = selected.indexOf(label)
        if (idx >= 0) {
          selected.splice(idx, 1)
        } else {
          selected.push(label)
        }
        return { ...prev, [q.question]: selected.join(', ') }
      })
    } else {
      setQuestionAnswers(prev => ({ ...prev, [q.question]: label }))
      // Auto-advance to next question after short delay
      const qs = questions()
      if (questionIndex() < qs.length - 1) {
        setTimeout(() => setQuestionIndex(i => i + 1), 200)
      }
    }
  }

  const selectCustomOption = () => {
    const q = currentQuestion()
    if (!q) return
    setIsCustomSelected(prev => ({ ...prev, [q.question]: true }))
    // Clear the preset selection so custom is the answer
    setQuestionAnswers(prev => {
      const next = { ...prev }
      delete next[q.question]
      return next
    })
    customAnswerRef?.focus()
  }

  const getEffectiveAnswers = () => {
    const answers = { ...questionAnswers() }
    const customs = customAnswers()
    const customFlags = isCustomSelected()
    for (const q of questions()) {
      if (customFlags[q.question] && customs[q.question]?.trim()) {
        answers[q.question] = customs[q.question].trim()
      }
    }
    return answers
  }

  const submitQuestionAnswers = () => {
    const approval = currentApproval()
    if (!approval) return
    const answers = getEffectiveAnswers()
    const qs = questions()
    const allAnswered = qs.every(q => answers[q.question])
    if (!allAnswered && qs.length > 0) return
    answerQuestion(approval.requestId, approval.sessionId, answers, approval.toolInput)
  }

  const formatToolInput = (input: Record<string, unknown>) => {
    const keys = Object.keys(input)
    if (keys.length === 0) return null
    // For Bash, just show the command
    if ('command' in input && typeof input.command === 'string') return input.command
    // For Edit/Write, show file path
    if ('file_path' in input && typeof input.file_path === 'string') return input.file_path as string
    return JSON.stringify(input, null, 2)
  }

  return (
    <div
      class="px-4 py-3 min-w-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* AskUserQuestion UI */}
      <Show when={isQuestion() && currentApproval()}>
        {(_approval) => {
          const q = () => currentQuestion()
          const qs = () => questions()
          return (
            <div class="bg-surface-1 border border-accent/30 rounded-xl p-3 mb-0 min-w-0 overflow-hidden">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <HelpCircle size={14} class="text-accent" />
                  <span class="text-xs font-medium text-accent">Question from Claude</span>
                  <Show when={qs().length > 1}>
                    <span class="text-[10px] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">
                      {questionIndex() + 1}/{qs().length}
                    </span>
                  </Show>
                </div>
                <button
                  class="p-1 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  onClick={() => denyToolUse(currentApproval()!.requestId, currentApproval()!.sessionId)}
                  title="Skip (Esc)"
                >
                  <X size={14} />
                </button>
              </div>
              <Show when={q()}>
                {(question) => (
                  <>
                    <Show when={question().header}>
                      <div class="text-[11px] text-text-muted mb-0.5">{question().header}</div>
                    </Show>
                    <div class="text-sm text-text-primary mb-2">{question().question}</div>
                    <Show when={question().options && question().options!.length > 0}>
                      <div class="flex flex-col gap-1 mb-2">
                        <For each={question().options!}>
                          {(opt, i) => {
                            const selected = () => {
                              const val = questionAnswers()[question().question] || ''
                              if (question().multiSelect) {
                                return val.split(', ').includes(opt.label)
                              }
                              return val === opt.label
                            }
                            return (
                              <button
                                class={clsx(
                                  'flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors min-w-0',
                                  selected()
                                    ? 'bg-accent/15 border border-accent/30 text-accent'
                                    : 'bg-surface-2 border border-border text-text-secondary hover:border-border-active'
                                )}
                                onClick={() => selectQuestionOption(opt.label)}
                              >
                                <span class={clsx(
                                  'w-4 h-4 rounded flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5',
                                  selected() ? 'bg-accent text-white' : 'bg-surface-3 text-text-dim'
                                )}>
                                  {i() + 1}
                                </span>
                                <div class="min-w-0">
                                  <div class="font-medium">{opt.label}</div>
                                  <Show when={opt.description}>
                                    <div class="text-text-dim text-[11px] mt-0.5">{opt.description}</div>
                                  </Show>
                                </div>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                    {(() => {
                      const customActive = () => isCustomSelected()[question().question] ?? false
                      return (
                        <div
                          class={clsx(
                            'flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors min-w-0 cursor-text mb-2',
                            customActive()
                              ? 'bg-accent/15 border border-accent/30 text-accent'
                              : 'bg-surface-2 border border-border text-text-secondary hover:border-border-active'
                          )}
                          onClick={() => selectCustomOption()}
                        >
                          <span class={clsx(
                            'w-4 h-4 rounded flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5',
                            customActive() ? 'bg-accent text-white' : 'bg-surface-3 text-text-dim'
                          )}>
                            {(question().options?.length ?? 0) + 1}
                          </span>
                          <input
                            ref={(el) => { customAnswerRef = el }}
                            type="text"
                            class="flex-1 min-w-0 bg-transparent outline-none text-xs text-text-primary placeholder-text-dim"
                            style={{ outline: 'none' }}
                            placeholder="Or type a custom answer..."
                            value={customAnswer()}
                            onInput={(e) => {
                              setCustomAnswer(e.currentTarget.value)
                              if (!customActive()) selectCustomOption()
                            }}
                            onFocus={() => { if (!customActive()) selectCustomOption() }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault(); e.stopPropagation()
                                const qs = questions()
                                if (questionIndex() < qs.length - 1) {
                                  setQuestionIndex(i => i + 1)
                                } else {
                                  submitQuestionAnswers()
                                }
                              }
                            }}
                          />
                        </div>
                      )
                    })()}
                  </>
                )}
              </Show>
              <div class="flex gap-2">
                <Show when={qs().length > 1 && questionIndex() > 0}>
                  <button
                    class="px-3 py-1.5 rounded-lg bg-surface-3 text-text-secondary text-xs font-medium hover:bg-surface-4 transition-colors"
                    onClick={() => setQuestionIndex(i => i - 1)}
                  >
                    Back
                  </button>
                </Show>
                <Show
                  when={questionIndex() < qs().length - 1}
                  fallback={
                    <button
                      class="flex-1 py-1.5 rounded-lg bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-30"
                      onClick={submitQuestionAnswers}
                      disabled={(() => {
                        const answers = getEffectiveAnswers()
                        return !questions().every(q => answers[q.question])
                      })()}
                    >
                      Submit <span class="text-text-dim ml-1">(Enter)</span>
                    </button>
                  }
                >
                  <button
                    class="flex-1 py-1.5 rounded-lg bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-30"
                    onClick={() => setQuestionIndex(i => i + 1)}
                    disabled={!questionAnswers()[currentQuestion()?.question ?? ''] && !(isCustomSelected()[currentQuestion()?.question ?? ''] && customAnswer().trim())}
                  >
                    Next <span class="text-text-dim ml-1">(Enter)</span>
                  </button>
                </Show>
              </div>
            </div>
          )
        }}
      </Show>

      {/* Plan viewer — live ExitPlanMode approval or persisted plan file */}
      <Show when={showPlanViewer() && planContent()}>
        {(plan) => (
          <div
            class={clsx(
              'bg-surface-0 border border-accent/30 rounded-xl flex flex-col overflow-hidden transition-all',
              planExpanded() ? 'fixed inset-4 z-50' : 'max-h-[50vh]'
            )}
          >
            {/* Header */}
            <div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div class="flex items-center gap-2">
                <ListChecks size={16} class="text-accent" />
                <span class="text-sm font-medium text-text-primary">Plan Review</span>
                <Show when={plan().filePath}>
                  <span class="text-[10px] text-text-dim font-mono truncate max-w-60">{plan().filePath}</span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  class="p-1.5 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  onClick={() => setPlanExpanded(!planExpanded())}
                  title={planExpanded() ? 'Collapse' : 'Expand'}
                >
                  {planExpanded() ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              </div>
            </div>

            {/* Plan content */}
            <div class="flex-1 overflow-auto px-6 py-4">
              <div
                class="prose prose-invert prose-sm max-w-none
                  [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-text-primary [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:first:mt-0
                  [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-text-primary [&_h2]:mb-2 [&_h2]:mt-5
                  [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-text-primary [&_h3]:mb-1.5 [&_h3]:mt-4
                  [&_p]:text-sm [&_p]:text-text-secondary [&_p]:mb-3 [&_p]:leading-relaxed
                  [&_ul]:text-sm [&_ul]:text-text-secondary [&_ul]:mb-3 [&_ul]:pl-5 [&_ul]:list-disc
                  [&_ol]:text-sm [&_ol]:text-text-secondary [&_ol]:mb-3 [&_ol]:pl-5 [&_ol]:list-decimal
                  [&_li]:mb-1
                  [&_code]:text-xs [&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-accent-hover
                  [&_pre]:bg-surface-1 [&_pre]:border [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:mb-3 [&_pre]:overflow-x-auto
                  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-secondary
                  [&_table]:text-sm [&_table]:w-full [&_table]:mb-3
                  [&_th]:text-left [&_th]:text-text-muted [&_th]:font-medium [&_th]:px-2 [&_th]:py-1.5 [&_th]:border-b [&_th]:border-border
                  [&_td]:text-text-secondary [&_td]:px-2 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border/50
                  [&_strong]:text-text-primary [&_strong]:font-semibold
                  [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-4 [&_blockquote]:text-text-muted [&_blockquote]:italic"
                innerHTML={marked.parse(plan().plan, { async: false }) as string}
              />
            </div>

            {/* Footer actions */}
            <div class="flex items-center gap-3 px-4 py-3 border-t border-border shrink-0">
              <input
                class="flex-1 bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none placeholder-text-dim focus:border-border-active transition-colors"
                style={{ outline: 'none' }}
                placeholder="Request changes..."
                value={planChanges()}
                onInput={(e) => setPlanChanges(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handlePlanViewerAction(planChanges().trim())
                  }
                }}
              />
              <button
                class={clsx(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0',
                  planChanges().trim()
                    ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                    : 'bg-status-running/15 text-status-running hover:bg-status-running/25'
                )}
                onClick={() => handlePlanViewerAction(planChanges().trim())}
              >
                {planChanges().trim() ? 'Send' : 'Approve'} <span class="text-text-dim ml-1">(Enter)</span>
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Backdrop for fullscreen plan viewer */}
      <Show when={showPlanViewer() && planContent() && planExpanded()}>
        <div class="fixed inset-0 bg-black/60 z-40" />
      </Show>

      {/* Tool approval overlay */}
      <Show when={!isQuestion() && !isExitPlanMode() && currentApproval()}>
        {(approval) => (
          <div class="bg-surface-1 border border-amber-500/30 rounded-xl p-3 mb-0">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <ShieldAlert size={14} class="text-amber-500" />
                <span class="text-xs font-medium text-amber-500">Tool Approval</span>
                <Show when={pendingCount() > 1}>
                  <span class="text-[10px] bg-amber-500/15 text-amber-500 px-1.5 py-0.5 rounded-full">
                    +{pendingCount() - 1} more
                  </span>
                </Show>
              </div>
            </div>
            <div class="text-sm font-medium text-text-primary mb-1">{approval().toolName}</div>
            <Show when={formatToolInput(approval().toolInput)}>
              {(detail) => (
                <pre class="text-[11px] text-text-muted font-mono bg-surface-2 rounded-lg p-2 mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                  {detail()}
                </pre>
              )}
            </Show>
            <div class="flex gap-2">
              <button
                class="flex-1 py-1.5 rounded-lg bg-status-running/15 text-status-running text-xs font-medium hover:bg-status-running/25 transition-colors"
                onClick={() => approveToolUse(approval().requestId, approval().sessionId)}
              >
                Allow <span class="text-text-dim ml-1">(Enter)</span>
              </button>
              <button
                class="flex-1 py-1.5 rounded-lg bg-status-error/15 text-status-error text-xs font-medium hover:bg-status-error/25 transition-colors"
                onClick={() => denyToolUse(approval().requestId, approval().sessionId)}
              >
                Deny <span class="text-text-dim ml-1">(Esc)</span>
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Plan response panel */}
      <Show when={showPlanResponse() && !currentApproval()}>
        <div class="bg-surface-1 border border-accent/30 rounded-xl p-3 mb-0">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <ListChecks size={14} class="text-accent" />
              <span class="text-xs font-medium text-accent">Plan ready</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                class="p-1 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                onClick={() => setShowPlanResponse(false)}
                title="Dismiss (Esc)"
              >
                <X size={14} />
              </button>
              <button
                class="px-3 py-1.5 rounded-lg bg-status-running/15 text-status-running text-xs font-medium hover:bg-status-running/25 transition-colors"
                onClick={handleApprovePlan}
              >
                Approve <span class="text-text-dim ml-1">(Enter)</span>
              </button>
            </div>
          </div>
          <div class="flex gap-2">
            <input
              class="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none placeholder-text-dim focus:border-border-active transition-colors"
              placeholder="Ask for changes..."
              value={planFeedback()}
              onInput={(e) => setPlanFeedback(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handlePlanFeedback()
                }
              }}
            />
            <button
              class="px-3 py-1.5 rounded-lg bg-surface-3 text-text-secondary text-xs font-medium hover:bg-surface-4 transition-colors disabled:opacity-30"
              onClick={handlePlanFeedback}
              disabled={!planFeedback().trim()}
            >
              Send
            </button>
          </div>
        </div>
      </Show>

      {/* Queued message indicator (setup hook still running) */}
      <Show when={selectedTaskId() && queuedMessages[selectedTaskId()!]}>
        <div class="flex items-center gap-2 px-3 py-1.5 mb-1 text-xs text-text-dim bg-surface-1 rounded-lg border border-accent/10">
          <Loader2 size={10} class="animate-spin text-accent shrink-0" />
          <span class="truncate">Message queued — will send when setup completes</span>
          <button
            class="ml-auto shrink-0 text-text-dim hover:text-text-muted transition-colors"
            onClick={() => {
              const tid = selectedTaskId()!
              const queued = queuedMessages[tid]
              if (queued) {
                setMessage(queued.message)
                clearQueuedMessage(tid)
              }
            }}
            title="Cancel queued message"
          >
            <X size={12} />
          </button>
        </div>
      </Show>

      <Show when={editingMessageIdx() !== null || editingStepId() !== null}>
        <div class="px-3 pb-0.5">
          <span class="text-[10px] text-text-dim">
            Editing next step · Escape to cancel
          </span>
        </div>
      </Show>
      <Show when={props.isRunning && editingMessageIdx() === null && editingStepId() === null && (message().trim() || attachments().length > 0)}>
        <div class="px-3 pb-0.5">
          <span class="text-[10px] text-text-dim">
            Enter to add next step · Shift+Enter to add & arm · Cmd+Enter to redirect
          </span>
        </div>
      </Show>
      <Show when={!props.isRunning && editingMessageIdx() === null && editingStepId() === null && getSteps(props.sessionId).length > 0}>
        <div class="px-3 pb-0.5">
          <span class="text-[10px] text-text-dim">
            Cmd+Enter to send next step
          </span>
        </div>
      </Show>

      <div class={clsx(
        'relative bg-surface-1 rounded-xl transition-all outline-none',
        currentApproval() || showPlanResponse() || (showPlanViewer() && planContent()) ? 'hidden' : '',
        (editingMessageIdx() !== null || editingStepId() !== null)
          ? 'border border-amber-500/40 shadow-[0_0_0_2px_rgba(245,158,11,0.12)]'
          : planMode()
            ? 'border border-accent/40 shadow-[0_0_0_2px_rgba(59,130,246,0.15)]'
            : dragOver()
              ? 'border border-accent/50 bg-accent/5'
              : ''
      )}>
        {/* Command palette — onMouseDown preventDefault keeps focus in the input */}
        <Show when={showPalette()}>
          <div onMouseDown={e => e.preventDefault()}>
            <CommandPalette
              query={message()}
              onSelect={handleCommandSelect}
              onTab={(cmd) => {
                if (cmd.name === 'plan') {
                  setPlanMode(!planMode())
                  setMessage('')
                  setShowPalette(false)
                  return
                }
                setMessage(`/${cmd.name} `)
                setShowPalette(false)
              }}
              onDismiss={() => setShowPalette(false)}
            />
          </div>
        </Show>

        {/* File mention palette */}
        <Show when={showFileMention()}>
          <div onMouseDown={e => e.preventDefault()}>
            <FileMention
              query={fileMentionQuery()}
              files={worktreeFiles()}
              onSelect={handleFileMentionSelect}
              onDismiss={() => setShowFileMention(false)}
            />
          </div>
        </Show>

        {/* Attachment previews */}
        <Show when={attachments().length > 0}>
          <div class="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto">
            <For each={attachments()}>
              {(att, i) => (
                <div class="relative shrink-0 group">
                  <Show
                    when={att.mimeType.startsWith('image/')}
                    fallback={
                      <div class="w-16 h-16 rounded-lg bg-surface-2 border border-border flex items-center justify-center">
                        <span class="text-[10px] text-text-dim truncate max-w-14 px-1">{att.name}</span>
                      </div>
                    }
                  >
                    <button
                      type="button"
                      class="block cursor-pointer"
                      onClick={() => setViewerAttachment(att)}
                      title="Open image"
                    >
                      <BlobImage
                        data={att.data}
                        mimeType={att.mimeType}
                        alt={att.name}
                        class="w-16 h-16 object-cover rounded-xl border border-border transition-all duration-150 hover:border-border-active hover:brightness-110 hover:scale-[1.03]"
                      />
                    </button>
                  </Show>
                  <button
                    class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-3 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => removeAttachment(i())}
                  >
                    <X size={10} class="text-text-muted" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          class="hidden"
          ref={(el) => { fileInputRef = el }}
          onChange={(e) => {
            const files = e.currentTarget.files
            if (files) addFiles(files)
            e.currentTarget.value = ''
          }}
        />

        {/* Contenteditable input — text + inline mention badges */}
        <div class="relative">
          <Show when={!message()}>
            <div class="absolute inset-0 text-sm text-text-dim leading-normal px-3.5 pt-3 pb-2 pointer-events-none select-none">
              {dragOver()
                ? 'Drop files here...'
                : props.sessionId
                  ? 'Ask for changes, @reference files, use /skills'
                  : 'Select a session first'}
            </div>
          </Show>
          <div
            ref={inputRef}
            class="w-full bg-transparent text-sm text-text-primary outline-none leading-normal px-3.5 pt-3 pb-2 whitespace-pre-wrap break-words"
            style={{ 'min-height': '4.5em', 'max-height': '200px', 'overflow-y': 'auto', outline: 'none' }}
            contentEditable={!!props.sessionId}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => updateOverlays()}
            onBlur={() => {
              setShowPalette(false)
              setShowFileMention(false)
            }}
          />
        </div>

        {/* Bottom toolbar */}
        <div class="flex items-center justify-between px-2 pb-2 pt-0.5">
          <div class="flex items-center gap-0.5">
            {/* Model selector */}
            <ModelSelector
              model={currentModel()}
              onChange={(m) => {
                const tid = selectedTaskId()
                if (tid) setTaskModel(tid, m)
              }}
              disabled={!props.sessionId || props.isRunning}
            />

            {/* Plan mode toggle */}
            <button
              class={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
                planMode()
                  ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-2',
                'disabled:opacity-30'
              )}
              onClick={() => {
                setPlanMode(!planMode())
                if (!planMode()) setShowPlanResponse(false)
              }}
              disabled={!props.sessionId || props.isRunning}
              title="Plan mode — Claude will plan before acting"
            >
              <ListChecks size={13} />
              <span>Plan</span>
            </button>

            {/* Thinking mode toggle */}
            <button
              class={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
                thinkingMode()
                  ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-2',
                'disabled:opacity-30'
              )}
              onClick={() => setThinking(!thinkingMode())}
              disabled={!props.sessionId || props.isRunning}
              title="Thinking mode — extended thinking for complex tasks"
            >
              <Brain size={13} />
              <span>Think</span>
            </button>

            {/* Fast mode toggle */}
            <button
              class={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
                fastMode()
                  ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-2',
                'disabled:opacity-30'
              )}
              onClick={() => setFast(!fastMode())}
              disabled={!props.sessionId || props.isRunning}
              title="Fast mode — less thinking, quicker responses"
            >
              <Zap size={13} />
              <span>Fast</span>
            </button>

            {/* Trust level selector */}
            <div class="relative">
              <button
                class={clsx(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
                  trustLevel() === 'full_auto'
                    ? 'text-status-running bg-status-running/10 hover:bg-status-running/15'
                    : trustLevel() === 'supervised'
                      ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/15'
                      : 'text-text-muted hover:text-text-secondary hover:bg-surface-2',
                  'disabled:opacity-30'
                )}
                onClick={() => setShowTrustMenu(!showTrustMenu())}
                disabled={!props.sessionId}
                title={`Trust: ${trustLevel()}`}
              >
                {trustLevel() === 'full_auto' ? <ShieldCheck size={13} /> :
                 trustLevel() === 'supervised' ? <ShieldAlert size={13} /> :
                 <Shield size={13} />}
                <span>
                  {trustLevel() === 'full_auto' ? 'Auto' :
                   trustLevel() === 'supervised' ? 'Supervised' :
                   'Normal'}
                </span>
              </button>
              <Popover open={showTrustMenu()} onClose={() => setShowTrustMenu(false)} class="py-1 min-w-44 absolute bottom-full left-0 mb-1">
                <button
                  class={clsx('w-full text-left px-3 py-1.5 text-[11px] transition-colors', trustLevel() === 'normal' ? 'text-accent bg-accent-muted' : 'text-text-secondary hover:bg-surface-4')}
                  onClick={() => handleTrustChange('normal')}
                >
                  <div class="font-medium">Normal</div>
                  <div class="text-[10px] text-text-dim mt-0.5">Auto-approve safe actions</div>
                </button>
                <button
                  class={clsx('w-full text-left px-3 py-1.5 text-[11px] transition-colors', trustLevel() === 'full_auto' ? 'text-accent bg-accent-muted' : 'text-text-secondary hover:bg-surface-4')}
                  onClick={() => handleTrustChange('full_auto')}
                >
                  <div class="font-medium">Full Auto</div>
                  <div class="text-[10px] text-text-dim mt-0.5">Auto-approve everything</div>
                </button>
                <button
                  class={clsx('w-full text-left px-3 py-1.5 text-[11px] transition-colors', trustLevel() === 'supervised' ? 'text-accent bg-accent-muted' : 'text-text-secondary hover:bg-surface-4')}
                  onClick={() => handleTrustChange('supervised')}
                >
                  <div class="font-medium">Supervised</div>
                  <div class="text-[10px] text-text-dim mt-0.5">Approve every action</div>
                </button>
              </Popover>
            </div>

            {/* Auto-approved count */}
            <Show when={autoApprovedCount() > 0}>
              <span
                class="text-[10px] text-status-running/70 px-1.5 py-0.5 rounded-full flex items-center"
                title={`${autoApprovedCount()} tool calls auto-approved this session`}
              >
                {autoApprovedCount()} auto-approved
              </span>
            </Show>

            {/* Usage chip */}
            <UsageChip sessionId={props.sessionId} />
          </div>

          <div class="flex items-center gap-1">
            {/* Attach button */}
            <button
              class="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors shrink-0 disabled:opacity-30"
              onClick={() => fileInputRef?.click()}
              disabled={!props.sessionId}
              title="Attach image"
            >
              <Plus size={16} />
            </button>

            {/* Send / Stop buttons */}
            <Show when={props.isRunning}>
              <button
                class="w-7 h-7 flex items-center justify-center rounded-lg bg-status-error/10 text-status-error hover:bg-status-error/20 transition-colors"
                onClick={handleAbort}
                title="Stop session"
              >
                <Square size={14} />
              </button>
            </Show>
            <Show
              when={props.isRunning}
              fallback={
                <>
                  <Show
                    when={editingStepId() !== null || editingMessageIdx() !== null}
                    fallback={
                      <button
                        class={clsx(
                          'w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                          (!message().trim() && attachments().length === 0) || !props.sessionId
                            ? 'text-text-dim/20'
                            : 'text-text-dim hover:text-accent hover:bg-accent/10'
                        )}
                        onClick={() => handleAddStep(false)}
                        disabled={(!message().trim() && attachments().length === 0) || !props.sessionId}
                        title="Add as next step"
                      >
                        <ListPlus size={16} />
                      </button>
                    }
                  >
                    <button
                      class="w-7 h-7 flex items-center justify-center rounded-lg text-text-dim hover:text-status-error hover:bg-status-error/10 transition-colors"
                      onClick={handleCancelEdit}
                      title="Cancel edit (Esc)"
                    >
                      <X size={16} />
                    </button>
                  </Show>
                  <Show
                    when={editingStepId() !== null || editingMessageIdx() !== null}
                    fallback={
                      <button
                        class={clsx(
                          'w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                          (!message().trim() && attachments().length === 0) || !props.sessionId || sending()
                            ? 'text-text-dim/30 border border-border'
                            : 'text-text-primary bg-surface-3 border border-border-active hover:bg-surface-4'
                        )}
                        onClick={handleSend}
                        disabled={(!message().trim() && attachments().length === 0) || !props.sessionId || sending()}
                        title="Send (Enter)"
                      >
                        <ArrowUp size={16} />
                      </button>
                    }
                  >
                    <button
                      class={clsx(
                        'w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                        !message().trim()
                          ? 'text-text-dim/30 border border-border'
                          : 'text-amber-500 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20'
                      )}
                      onClick={handleSaveEdit}
                      disabled={!message().trim()}
                      title="Save edit (Enter)"
                    >
                      <Check size={16} />
                    </button>
                  </Show>
                </>
              }
            >
              <button
                class={clsx(
                  'w-7 h-7 flex items-center justify-center rounded-lg transition-colors relative',
                  (!message().trim() && attachments().length === 0) || !props.sessionId || sending()
                    ? 'text-text-dim/30 border border-border'
                    : 'text-accent bg-accent/10 border border-accent/30 hover:bg-accent/20'
                )}
                onClick={() => handleAddStep(false)}
                disabled={(!message().trim() && attachments().length === 0) || !props.sessionId || sending()}
                title="Add next step (Enter)"
              >
                <ArrowUp size={16} />
                <div class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent" />
              </button>
            </Show>
          </div>
        </div>
      </div>
      <Show when={viewerAttachment()}>
        {(att) => (
          <ImageViewer
            open={true}
            mimeType={att().mimeType}
            data={att().data}
            name={att().name}
            onClose={() => setViewerAttachment(null)}
          />
        )}
      </Show>
    </div>
  )
}
