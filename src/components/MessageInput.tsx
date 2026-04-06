import { Component, createSignal, Show, For, onMount, onCleanup } from 'solid-js'
import { sendMessage, abortMessage, createSession, clearOutputItems } from '../store/sessions'
import { effectiveModel, setSessionModel, setSelectedSessionId } from '../store/ui'
import { ModelSelector } from './ModelSelector'
import { CommandPalette } from './CommandPalette'
import type { Command } from '../store/commands'
import { Send, Square, X, Plus } from 'lucide-solid'
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

  return (
    <div
      class="px-4 py-3"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div class={clsx(
        'relative bg-surface-1 border rounded-xl transition-all focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.25)]',
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
