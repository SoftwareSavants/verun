import { Component, createSignal, createEffect, on, Show, For, onMount, onCleanup } from 'solid-js'
import { sendMessage, abortMessage, createSession, clearOutputItems, pendingApprovals, approveToolUse, denyToolUse, answerQuestion } from '../store/sessions'
import { effectiveModel, setSessionModel, setSelectedSessionId } from '../store/ui'
import { ModelSelector } from './ModelSelector'
import { CommandPalette } from './CommandPalette'
import type { Command } from '../store/commands'
import { Send, Square, X, Plus, ShieldAlert, HelpCircle } from 'lucide-solid'
import { clsx } from 'clsx'
import type { Attachment, ModelId } from '../types'
import { selectedTaskId } from '../store/ui'

interface Props {
  sessionId: string | null
  isRunning: boolean
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_FILE_SIZE = 10 * 1024 * 1024

async function fileToAttachment(file: File): Promise<Attachment | null> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return null
  if (file.size > MAX_FILE_SIZE) return null

  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      if (base64) {
        resolve({ name: file.name, mimeType: file.type, dataBase64: base64 })
      } else {
        resolve(null)
      }
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export const MessageInput: Component<Props> = (props) => {
  let fileInputRef!: HTMLInputElement
  let textareaRef!: HTMLTextAreaElement
  const [message, setMessage] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [dragOver, setDragOver] = createSignal(false)
  const [showPalette, setShowPalette] = createSignal(false)

  const currentModel = () => effectiveModel(props.sessionId)

  const currentApproval = () => {
    const sid = props.sessionId
    if (!sid) return null
    const list = pendingApprovals[sid]
    return list && list.length > 0 ? list[0] : null
  }

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
  const [customAnswer, setCustomAnswer] = createSignal('')
  const currentQuestion = () => questions()[questionIndex()]

  // Reset question state when approval changes
  createEffect(on(() => currentApproval()?.requestId, () => {
    setQuestionIndex(0)
    setQuestionAnswers({})
    setCustomAnswer('')
  }))

  // Auto-focus textarea when session changes (e.g. new task created)
  createEffect(on(() => props.sessionId, () => {
    if (textareaRef && !textareaRef.disabled) {
      requestAnimationFrame(() => textareaRef.focus())
    }
  }))

  // Auto-focus textarea when user starts typing anywhere
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if already focused on an input, or modifier keys, or special keys
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return // non-printable
      if (!textareaRef || textareaRef.disabled) return

      textareaRef.focus()
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
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

    setSending(true)
    setMessage('')
    setAttachments([])
    setShowPalette(false)
    try {
      await sendMessage(sid, msg, atts.length > 0 ? atts : undefined, currentModel())
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
        if (modelArg && ['opus', 'sonnet', 'haiku'].includes(modelArg) && props.sessionId) {
          setSessionModel(props.sessionId, modelArg)
        }
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

  const handleKeyDown = (e: KeyboardEvent) => {
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Check if it's a slash command (app or claude)
      const msg = message().trim()
      if (msg.startsWith('/')) {
        const cmdName = msg.slice(1).split(/\s+/)[0]
        // Check app commands first
        const appCmds = ['new-session', 'clear', 'model']
        if (appCmds.includes(cmdName)) {
          handleAppCommand({ name: cmdName, description: '', category: 'app' })
          return
        }
        // Otherwise send as-is (Claude skill)
      }
      handleSend()
    }
  }

  const handleInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const val = e.currentTarget.value
    setMessage(val)
    autoResize(e.currentTarget)

    // Show/hide command palette
    if (val.startsWith('/') && val.indexOf(' ') === -1) {
      setShowPalette(true)
    } else {
      setShowPalette(false)
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

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  // Keyboard shortcuts for approval/question UI
  onMount(() => {
    const approvalKeyHandler = (e: KeyboardEvent) => {
      const approval = currentApproval()
      if (!approval) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // AskUserQuestion: number keys select options
      if (isQuestion()) {
        const q = currentQuestion()
        if (!q) return
        const num = parseInt(e.key)
        if (num >= 1 && num <= (q.options?.length ?? 0)) {
          e.preventDefault()
          selectQuestionOption(q.options![num - 1].label)
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          submitQuestionAnswers()
        }
        return
      }

      // Tool approval: Enter/y = Allow, Escape/n = Deny
      if (e.key === 'Enter' || e.key === 'y') {
        e.preventDefault()
        approveToolUse(approval.requestId, approval.sessionId)
      } else if (e.key === 'Escape' || e.key === 'n') {
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
    setQuestionAnswers(prev => ({ ...prev, [q.question]: label }))
    setCustomAnswer('')
    // Auto-advance to next question after short delay
    const qs = questions()
    if (questionIndex() < qs.length - 1) {
      setTimeout(() => setQuestionIndex(i => i + 1), 200)
    }
  }

  const submitQuestionAnswers = () => {
    const approval = currentApproval()
    if (!approval) return
    // If there's a custom answer for the current question, use it
    const custom = customAnswer().trim()
    const q = currentQuestion()
    let answers = { ...questionAnswers() }
    if (custom && q) {
      answers[q.question] = custom
    }
    // Check all questions have answers
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
      class="px-4 py-3"
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
            <div class="bg-surface-1 border border-accent/30 rounded-xl p-3 mb-0">
              <div class="flex items-center gap-2 mb-2">
                <HelpCircle size={14} class="text-accent" />
                <span class="text-xs font-medium text-accent">Question from Claude</span>
                <Show when={qs().length > 1}>
                  <span class="text-[10px] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">
                    {questionIndex() + 1}/{qs().length}
                  </span>
                </Show>
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
                            const selected = () => questionAnswers()[question().question] === opt.label
                            return (
                              <button
                                class={clsx(
                                  'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors',
                                  selected()
                                    ? 'bg-accent/15 border border-accent/30 text-accent'
                                    : 'bg-surface-2 border border-border text-text-secondary hover:border-border-active'
                                )}
                                onClick={() => selectQuestionOption(opt.label)}
                              >
                                <span class={clsx(
                                  'w-4 h-4 rounded flex items-center justify-center text-[10px] font-medium shrink-0',
                                  selected() ? 'bg-accent text-white' : 'bg-surface-3 text-text-dim'
                                )}>
                                  {i() + 1}
                                </span>
                                <span class="font-medium">{opt.label}</span>
                                <Show when={opt.description}>
                                  <span class="text-text-dim">— {opt.description}</span>
                                </Show>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                    <input
                      type="text"
                      class="w-full bg-surface-2 border border-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary placeholder-text-dim outline-none focus:border-accent mb-2"
                      placeholder="Or type a custom answer..."
                      value={customAnswer()}
                      onInput={(e) => setCustomAnswer(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitQuestionAnswers() }
                      }}
                    />
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
                <button
                  class="flex-1 py-1.5 rounded-lg bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-30"
                  onClick={submitQuestionAnswers}
                  disabled={!questions().every(q => questionAnswers()[q.question] || customAnswer().trim())}
                >
                  Submit <span class="text-text-dim ml-1">(Enter)</span>
                </button>
              </div>
            </div>
          )
        }}
      </Show>

      {/* Tool approval overlay */}
      <Show when={!isQuestion() && currentApproval()}>
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

      <div class={clsx(
        'relative bg-surface-1 border rounded-xl transition-all focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.25)]',
        currentApproval() ? 'hidden' : '',
        dragOver()
          ? 'border-accent/50 bg-accent/5'
          : 'border-border'
      )}>
        {/* Command palette */}
        <Show when={showPalette()}>
          <CommandPalette
            query={message()}
            onSelect={handleCommandSelect}
            onTab={(cmd) => {
              setMessage(`/${cmd.name} `)
              setShowPalette(false)
            }}
            onDismiss={() => setShowPalette(false)}
          />
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
                    <img
                      src={`data:${att.mimeType};base64,${att.dataBase64}`}
                      alt={att.name}
                      class="w-16 h-16 rounded-lg object-cover border border-border"
                    />
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

        {/* Input row */}
        <div class="flex items-center gap-2 px-3 py-1.5">
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
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors shrink-0 disabled:opacity-30"
            onClick={() => fileInputRef?.click()}
            disabled={!props.sessionId || props.isRunning}
            title="Attach image"
          >
            <Plus size={16} />
          </button>

          <textarea
            ref={textareaRef}
            class="flex-1 bg-transparent text-sm text-text-primary outline-none resize-none placeholder-text-dim leading-normal"
            style={{ height: 'auto', 'max-height': '200px', 'overflow-y': 'auto' }}
            placeholder={
              dragOver()
                ? 'Drop files here...'
                : props.sessionId
                  ? 'Message Claude... (type / for commands)'
                  : 'Select a session first'
            }
            value={message()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={!props.sessionId || props.isRunning}
            rows={1}
          />

          <ModelSelector
            model={currentModel()}
            onChange={(m) => {
              if (props.sessionId) setSessionModel(props.sessionId, m)
            }}
            disabled={!props.sessionId || props.isRunning}
          />

          <Show
            when={props.isRunning}
            fallback={
              <button
                class="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-accent hover:bg-accent-muted transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                onClick={handleSend}
                disabled={(!message().trim() && attachments().length === 0) || !props.sessionId || sending()}
                title="Send (Enter)"
              >
                <Send size={16} />
              </button>
            }
          >
            <button
              class="w-8 h-8 flex items-center justify-center rounded-lg bg-status-error/10 text-status-error hover:bg-status-error/20 transition-colors"
              onClick={handleAbort}
              title="Stop"
            >
              <Square size={14} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
