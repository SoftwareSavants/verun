import { Component, For, Show, createSignal } from 'solid-js'
import { GripVertical, Play, Pause, X, ArrowUp, ListChecks, Zap, Paperclip, Brain } from 'lucide-solid'
import { getSteps, removeStep, updateStep, reorderSteps, extractStep } from '../store/steps'
import { sendMessage, sessionById } from '../store/sessions'
import { agents } from '../store/agents'
import { clsx } from 'clsx'
import { ModelSelector } from './ModelSelector'
import type { AgentType, ModelId } from '../types'

interface Props {
  sessionId: string | null
  isRunning: boolean
}

const ROW_HEIGHT = 32

export const StepList: Component<Props> = (props) => {
  const [dragging, setDragging] = createSignal<number | null>(null)
  const [dropTarget, setDropTarget] = createSignal<number | null>(null)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editText, setEditText] = createSignal('')

  const stepList = () => getSteps(props.sessionId)

  const sessionAgent = () => {
    const sid = props.sessionId
    const at = sid ? sessionById(sid)?.agentType : undefined
    return at ? agents.find(a => a.id === at) : undefined
  }

  const toggleArmed = (stepId: string, currentArmed: boolean) => {
    if (!props.sessionId) return
    updateStep(props.sessionId, stepId, { armed: !currentArmed })
  }

  const handleDelete = (stepId: string) => {
    if (!props.sessionId) return
    removeStep(props.sessionId, stepId)
  }

  const handleFire = async (stepId: string) => {
    if (!props.sessionId) return
    const step = extractStep(props.sessionId, stepId)
    if (!step) return
    const attachments = step.attachmentsJson ? JSON.parse(step.attachmentsJson) : undefined
    await sendMessage(
      step.sessionId, step.message, attachments,
      step.model ?? undefined, step.planMode ?? undefined,
      step.thinkingMode ?? undefined, step.fastMode ?? undefined,
    )
  }

  const startEdit = (stepId: string, message: string) => {
    setEditingId(stepId)
    setEditText(message)
  }

  const saveEdit = () => {
    const id = editingId()
    if (!id || !props.sessionId) return
    const msg = editText().trim()
    if (msg) updateStep(props.sessionId, id, { message: msg })
    setEditingId(null)
  }

  const cancelEdit = () => setEditingId(null)

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  const startDrag = (e: MouseEvent, dragIndex: number) => {
    e.preventDefault()
    setDragging(dragIndex)
    setDropTarget(dragIndex)
    const startY = e.clientY
    const items = stepList()

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY
      const offset = Math.round(delta / ROW_HEIGHT)
      const newIndex = Math.max(0, Math.min(items.length - 1, dragIndex + offset))
      setDropTarget(newIndex)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const from = dragIndex
      const to = dropTarget()
      setDragging(null)
      setDropTarget(null)
      if (from !== to && to !== null && props.sessionId) {
        const arr = [...stepList()]
        const [moved] = arr.splice(from, 1)
        arr.splice(to, 0, moved)
        reorderSteps(props.sessionId, arr.map(s => s.id))
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <Show when={stepList().length > 0}>
      <div class="border-t border-border bg-surface-1 px-3 py-1.5 max-h-48 flex flex-col min-h-0">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[10px] text-text-dim font-medium uppercase tracking-wider">Next Steps</span>
        </div>
        <div class="flex-1 overflow-y-auto min-h-0">
          <For each={stepList()}>
          {(step, i) => {
            const isEditing = () => editingId() === step.id
            const attachmentCount = () => {
              if (!step.attachmentsJson) return 0
              try { return JSON.parse(step.attachmentsJson).length } catch { return 0 }
            }
            return (
              <div
                data-step-id={step.id}
                class={clsx(
                  'group flex gap-1 px-1.5 py-1 rounded text-xs relative transition-colors',
                  isEditing() ? 'items-start' : 'items-center',
                  dragging() === i() && 'opacity-40',
                  dropTarget() === i() && dragging() !== null && dragging() !== i() && 'border-t-2 border-accent',
                  !isEditing() && 'hover:bg-surface-2',
                  isEditing() && 'bg-surface-2 ring-1 ring-accent/40',
                  !isEditing() && step.armed && 'shadow-[inset_2px_0_0_0_#2d6e4f]',
                )}
                style={!isEditing() ? { height: `${ROW_HEIGHT}px` } : undefined}
                onMouseDown={(e) => {
                  // Keep textarea focused when clicking buttons/selector in edit mode
                  // so the blur-to-save doesn't fire. WebKit (Tauri) does not focus
                  // buttons on click, so relatedTarget-based detection is unreliable.
                  if (!isEditing()) return
                  const t = e.target as HTMLElement
                  if (!t.closest('textarea, input')) e.preventDefault()
                }}
              >
                {/* Drag handle */}
                <div
                  class={clsx(
                    'text-text-dim shrink-0 flex items-center',
                    isEditing() ? 'pt-1' : 'cursor-grab hover:text-text-muted',
                  )}
                  onMouseDown={(e) => { if (!isEditing()) startDrag(e, i()) }}
                >
                  <GripVertical size={12} />
                </div>

                <Show
                  when={isEditing()}
                  fallback={
                    <>
                      {/* Message (click to edit) */}
                      <div
                        class="flex-1 flex items-center gap-1 min-w-0 cursor-text"
                        onClick={() => startEdit(step.id, step.message)}
                      >
                        <span class="truncate text-text-secondary">{step.message}</span>
                        <Show when={step.planMode}>
                          <span class="text-text-dim shrink-0 flex items-center" title="Plan mode"><ListChecks size={11} /></span>
                        </Show>
                        <Show when={step.fastMode}>
                          <span class="text-text-dim shrink-0 flex items-center" title="Fast mode"><Zap size={11} /></span>
                        </Show>
                        <Show when={attachmentCount() > 0}>
                          <span class="text-text-dim shrink-0 flex items-center" title={`${attachmentCount()} attachment${attachmentCount() > 1 ? 's' : ''}`}>
                            <Paperclip size={11} />
                          </span>
                        </Show>
                      </div>

                      {/* Action cluster: fire (first idle step) → arm → delete.
                          First idle step shows icons always; other rows hover-reveal. */}
                      <div
                        class={clsx(
                          'flex items-center shrink-0 transition-opacity',
                          !(i() === 0 && !props.isRunning) && 'opacity-0 group-hover:opacity-100',
                        )}
                      >
                        <Show when={i() === 0 && !props.isRunning}>
                          <button
                            class="p-0.5 rounded text-accent hover:bg-accent/10 transition-colors shrink-0"
                            onClick={() => handleFire(step.id)}
                            title="Send now"
                          >
                            <ArrowUp size={13} />
                          </button>
                        </Show>

                        <Show when={!(i() === 0 && !props.isRunning)}>
                          <button
                            class="p-0.5 rounded transition-colors shrink-0 text-text-dim hover:text-text-muted"
                            onClick={() => toggleArmed(step.id, step.armed)}
                            title={step.armed ? 'Disarm (won\'t auto-send)' : 'Arm (auto-send when idle)'}
                          >
                            {step.armed ? <Pause size={12} /> : <Play size={12} />}
                          </button>
                        </Show>

                        <button
                          class="p-0.5 rounded text-text-dim hover:text-status-error hover:bg-status-error/10 transition-colors shrink-0"
                          onClick={() => handleDelete(step.id)}
                          title="Remove"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </>
                  }
                >
                  {/* Edit mode */}
                  <div class="flex-1 flex flex-col gap-1 min-w-0">
                    <textarea
                      class="w-full bg-transparent text-text-primary outline-none resize-none text-xs leading-tight py-0.5"
                      rows={1}
                      value={editText()}
                      ref={(el) => {
                        requestAnimationFrame(() => {
                          autoResize(el)
                          el.focus()
                          el.setSelectionRange(el.value.length, el.value.length)
                        })
                      }}
                      onInput={(e) => { setEditText(e.currentTarget.value); autoResize(e.currentTarget) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                      }}
                      onBlur={(e) => {
                        const row = e.currentTarget.closest('[data-step-id]')
                        const next = e.relatedTarget as HTMLElement | null
                        if (!next || !row || !row.contains(next)) saveEdit()
                      }}
                    />
                    <div class="flex items-center gap-1 flex-wrap">
                      <Show when={sessionAgent()?.supportsPlanMode !== false}>
                        <button
                          class={clsx(
                            'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                            step.planMode
                              ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                              : 'text-text-muted hover:bg-surface-3',
                          )}
                          onClick={() => updateStep(props.sessionId!, step.id, { planMode: !step.planMode })}
                          title="Plan mode"
                        >
                          <ListChecks size={10} />
                          <span>Plan</span>
                        </button>
                      </Show>
                      <Show when={sessionAgent()?.supportsEffort !== false}>
                        <button
                          class={clsx(
                            'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                            step.thinkingMode
                              ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                              : 'text-text-muted hover:bg-surface-3',
                          )}
                          onClick={() => updateStep(props.sessionId!, step.id, { thinkingMode: !step.thinkingMode })}
                          title="Thinking mode"
                        >
                          <Brain size={10} />
                          <span>Think</span>
                        </button>
                        <button
                          class={clsx(
                            'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                            step.fastMode
                              ? 'text-accent bg-accent-muted hover:bg-accent-muted/80'
                              : 'text-text-muted hover:bg-surface-3',
                          )}
                          onClick={() => updateStep(props.sessionId!, step.id, { fastMode: !step.fastMode })}
                          title="Fast mode"
                        >
                          <Zap size={10} />
                          <span>Fast</span>
                        </button>
                      </Show>
                      <ModelSelector
                        model={step.model as ModelId | null | undefined}
                        agentType={sessionAgent()?.id ?? ('claude' as AgentType)}
                        onChange={(m) => updateStep(props.sessionId!, step.id, { model: m })}
                        fixedPosition
                        compact
                      />
                      <Show when={attachmentCount() > 0}>
                        <span class="text-text-dim flex items-center gap-1 text-[10px] px-1.5 py-0.5">
                          <Paperclip size={10} />
                          <span>{attachmentCount()}</span>
                        </span>
                      </Show>
                      <span class="ml-auto text-[10px] text-text-dim">Enter to save · Esc to cancel</span>
                    </div>
                  </div>
                </Show>
              </div>
            )
          }}
          </For>
        </div>
      </div>
    </Show>
  )
}
