import { Component, For, Show, createSignal } from 'solid-js'
import { GripVertical, Play, Pause, Pencil, Trash2, ArrowUp, ListChecks, Zap, Paperclip } from 'lucide-solid'
import { getSteps, removeStep, updateStep, reorderSteps, extractStep } from '../store/steps'
import { sendMessage } from '../store/sessions'
import { setEditStepRequest } from '../store/ui'
import { clsx } from 'clsx'

interface Props {
  sessionId: string | null
  isRunning: boolean
}

export const StepList: Component<Props> = (props) => {
  const [dragging, setDragging] = createSignal<number | null>(null)
  const [dropTarget, setDropTarget] = createSignal<number | null>(null)

  const stepList = () => getSteps(props.sessionId)

  const toggleArmed = (stepId: string, currentArmed: boolean) => {
    if (!props.sessionId) return
    updateStep(props.sessionId, stepId, { armed: !currentArmed })
  }

  const handleEdit = (stepId: string, message: string, attachmentsJson?: string | null) => {
    if (!props.sessionId) return
    setEditStepRequest({ sessionId: props.sessionId, stepId, message, attachmentsJson })
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

  const ROW_HEIGHT = 32

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
      <div class="border-t border-border px-3 py-1.5 max-h-40 overflow-y-auto">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[10px] text-text-dim font-medium uppercase tracking-wider">Next Steps</span>
        </div>
        <For each={stepList()}>
          {(step, i) => (
            <div
              class={clsx(
                'flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-colors',
                dragging() === i() && 'opacity-40',
                dropTarget() === i() && dragging() !== null && dragging() !== i() && 'border-t-2 border-accent',
                'hover:bg-surface-2',
              )}
              style={{ height: `${ROW_HEIGHT}px` }}
            >
              {/* Drag handle */}
              <div
                class="cursor-grab text-text-dim hover:text-text-muted shrink-0 flex items-center"
                onMouseDown={(e) => startDrag(e, i())}
              >
                <GripVertical size={12} />
              </div>

              {/* Number */}
              <span class="text-text-dim w-4 text-right shrink-0">{i() + 1}.</span>

              {/* Message + mode indicators */}
              <div class="flex-1 flex items-center gap-1 min-w-0">
                <span class="truncate text-text-secondary">{step.message}</span>
                <Show when={step.planMode}>
                  <span class="text-text-dim shrink-0 flex items-center" title="Plan mode"><ListChecks size={11} /></span>
                </Show>
                <Show when={step.fastMode}>
                  <span class="text-text-dim shrink-0 flex items-center" title="Fast mode"><Zap size={11} /></span>
                </Show>
                <Show when={step.attachmentsJson}>
                  {(() => {
                    try { const n = JSON.parse(step.attachmentsJson!).length; return n > 0 ? <span class="text-text-dim shrink-0 flex items-center" title={`${n} attachment${n > 1 ? 's' : ''}`}><Paperclip size={11} /></span> : null } catch { return null }
                  })()}
                </Show>
              </div>

              {/* Armed toggle */}
              <button
                class={clsx(
                  'p-0.5 rounded transition-colors shrink-0',
                  step.armed
                    ? 'text-accent hover:text-accent/80'
                    : 'text-text-dim hover:text-text-muted',
                )}
                onClick={() => toggleArmed(step.id, step.armed)}
                title={step.armed ? 'Disarm (won\'t auto-send)' : 'Arm (auto-send when idle)'}
              >
                {step.armed ? <Play size={12} /> : <Pause size={12} />}
              </button>

              {/* Fire button — only for first step when idle */}
              <Show when={i() === 0 && !props.isRunning}>
                <button
                  class="p-0.5 rounded text-accent hover:bg-accent/10 transition-colors shrink-0"
                  onClick={() => handleFire(step.id)}
                  title="Send now"
                >
                  <ArrowUp size={13} />
                </button>
              </Show>

              {/* Edit */}
              <button
                class="p-0.5 rounded text-text-dim hover:text-text-muted hover:bg-surface-3 transition-colors shrink-0"
                onClick={() => handleEdit(step.id, step.message, step.attachmentsJson)}
                title="Edit"
              >
                <Pencil size={12} />
              </button>

              {/* Delete */}
              <button
                class="p-0.5 rounded text-text-dim hover:text-status-error hover:bg-status-error/10 transition-colors shrink-0"
                onClick={() => handleDelete(step.id)}
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
