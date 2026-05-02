import { Component, createSignal, createEffect, on, onMount, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { X, Loader2, ArrowUp } from 'lucide-solid'
import { clsx } from 'clsx'
import { askSideQuestion } from '../lib/ipc'
import { renderMarkdown, handleMarkdownLinkClick, getWorktreePath } from '../lib/markdown'
import { registerDismissable } from '../lib/dismissable'
import {
  closeSideQuestion,
  getRememberedSideQuestion,
  rememberSideQuestion,
} from '../store/sideQuestion'
import type { SideQuestionResponse } from '../types'

interface Props {
  sessionId: string
  taskId?: string
  prefill?: string
  autoSubmit?: boolean
  /** Bumped on every `openSideQuestion` so we can re-seed even when other
      props are unchanged (eg. user re-opens with the same session id). */
  openId: number
}

export const SideQuestionPanel: Component<Props> = (props) => {
  const [question, setQuestion] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [answer, setAnswer] = createSignal<SideQuestionResponse | null | undefined>(undefined)
  const [error, setError] = createSignal<string | null>(null)
  let inputRef: HTMLTextAreaElement | undefined

  const seed = (prefill: string | undefined, sessionId: string) => {
    if (prefill !== undefined) {
      setQuestion(prefill)
      setAnswer(undefined)
      setError(null)
      return
    }
    const mem = getRememberedSideQuestion(sessionId)
    if (mem) {
      setQuestion(mem.question)
      setAnswer(mem.answer ?? undefined)
      setError(mem.error ?? null)
    } else {
      setQuestion('')
      setAnswer(undefined)
      setError(null)
    }
  }

  // Initial seed (synchronous so first paint has the right values).
  seed(props.prefill, props.sessionId)

  const persist = () => {
    rememberSideQuestion(props.sessionId, {
      question: question(),
      answer: answer() ?? null,
      error: error(),
    })
  }

  const focusAndSelectAll = () => {
    if (!inputRef) return
    const active = document.activeElement
    const safe = active === null || active === document.body || active === inputRef
    if (!safe) return
    inputRef.focus()
    inputRef.select()
  }

  const submit = async () => {
    const q = question().trim()
    if (!q || loading()) return
    setError(null)
    setAnswer(undefined)
    setLoading(true)
    // Keep the question highlighted while the request is in flight so the
    // user can see what they asked and instantly retype to replace.
    inputRef?.focus()
    inputRef?.select()
    try {
      const result = await askSideQuestion(props.sessionId, q)
      setAnswer(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      persist()
      focusAndSelectAll()
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  onMount(() => {
    inputRef?.focus()
    if (question().length > 0) {
      inputRef?.select()
    }
    const unregister = registerDismissable(closeSideQuestion)
    onCleanup(() => {
      unregister()
      persist()
    })
    if (props.autoSubmit && question().trim()) {
      submit()
    }
  })

  // Re-seed when openId changes (re-open while still mounted, eg. user typed
  // /btw on the same already-open session).
  createEffect(on(
    () => props.openId,
    (_id, prev) => {
      if (prev === undefined) return
      seed(props.prefill, props.sessionId)
      requestAnimationFrame(() => {
        inputRef?.focus()
        if (question().length > 0) inputRef?.select()
      })
      if (props.autoSubmit && question().trim()) {
        submit()
      }
    },
  ))

  const hasAnswerArea = () => loading() || answer() !== undefined || error()
  const canSend = () => question().trim().length > 0 && !loading()

  return (
    <Portal>
      <div
        class="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-3rem)] rounded-xl bg-surface-1 ring-1 ring-outline/15 shadow-2xl flex flex-col side-question-enter"
        role="dialog"
        aria-label="Ask a side question"
      >
        {/* Header */}
        <div class="flex items-center gap-2 px-3 py-2 border-b-1 border-b-solid border-b-border-subtle">
          <span class="text-xs font-medium text-text-primary">Side question</span>
          <span class="text-[10px] text-text-dim">ephemeral, not saved</span>
          <button
            class="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
            onClick={closeSideQuestion}
            title="Dismiss (Esc)"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>

        {/* Answer area (above the composer, like the chat) */}
        <Show when={hasAnswerArea()}>
          <div class="px-3 py-2.5 max-h-80 overflow-y-auto border-b-1 border-b-solid border-b-border-subtle">
            <Show when={loading()}>
              <div class="text-xs text-text-dim flex items-center gap-2">
                <Loader2 size={12} class="animate-spin" /> Asking Claude...
              </div>
            </Show>
            <Show when={!loading() && error()}>
              <div class="text-xs text-status-error">{error()}</div>
            </Show>
            <Show when={!loading() && answer() === null}>
              <div class="text-xs text-text-dim italic">
                Claude couldn't answer this side question right now.
              </div>
            </Show>
            <Show when={!loading() && answer()}>
              {(a) => (
                <div>
                  <Show when={a().synthetic}>
                    <span class="inline-block text-[9px] uppercase tracking-wider px-1.5 py-0.5 mb-1.5 rounded-sm bg-amber-500/15 text-amber-500 font-semibold">
                      synthetic
                    </span>
                  </Show>
                  <div
                    class="text-sm text-text-primary leading-relaxed prose-verun select-text break-words overflow-hidden"
                    innerHTML={renderMarkdown(a().response, getWorktreePath(props.taskId))}
                    onClick={(e) => handleMarkdownLinkClick(e, props.taskId)}
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>

        {/* Composer pinned to the bottom; send button overlaid in the
            textarea's bottom-right corner so it reads as one input. */}
        <div class="px-3 py-2.5">
          <div class="relative">
            <textarea
              ref={inputRef}
              value={question()}
              onInput={(e) => setQuestion(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about the current turn..."
              rows={2}
              // `readonly` (not `disabled`) so the text stays at full opacity
              // and the selection highlight remains visible while the request
              // is in flight. Submit is gated on `loading()` separately.
              readonly={loading()}
              class="w-full bg-surface-2 ring-1 ring-outline/15 rounded-md pl-2 pr-10 py-1.5 text-sm text-text-primary placeholder:text-text-dim resize-none focus:outline-none focus:ring-outline/30"
            />
            <button
              class={clsx(
                'absolute bottom-1.5 right-1.5 w-7 h-7 flex items-center justify-center rounded-md transition-colors',
                canSend()
                  ? 'text-text-primary bg-surface-3 hover:bg-surface-4'
                  : 'text-text-dim/40',
              )}
              onClick={submit}
              disabled={!canSend()}
              title="Ask (Enter)"
              aria-label="Ask"
            >
              <Show when={!loading()} fallback={<Loader2 size={14} class="animate-spin" />}>
                <ArrowUp size={14} />
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
