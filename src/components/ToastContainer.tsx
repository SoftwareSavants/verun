import { Component, For, Show } from 'solid-js'
import { toasts, dismissToast, type ToastAction } from '../store/ui'
import { clsx } from 'clsx'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-solid'

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
}

const colors = {
  success: 'border-status-running/20 bg-status-running/5',
  error: 'border-status-error/20 bg-status-error/5',
  info: 'border-border bg-surface-3/40',
}

const iconColors = {
  success: 'text-status-running',
  error: 'text-status-error',
  info: 'text-text-primary',
}

const actionClass = (variant: ToastAction['variant']) => {
  switch (variant) {
    case 'primary': return 'btn-primary'
    case 'danger': return 'btn-danger border border-status-error/20'
    default: return 'btn-ghost'
  }
}

export const ToastContainer: Component = () => {
  return (
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <For each={toasts()}>
        {(toast) => {
          const Icon = icons[toast.type]
          const hasActions = () => (toast.actions?.length ?? 0) > 0
          return (
            <div
              class={clsx(
                'pointer-events-auto rounded-xl border shadow-xl backdrop-blur-sm animate-slide-in min-w-64 max-w-md',
                colors[toast.type],
                'bg-surface-2/90',
                hasActions() ? 'px-3.5 py-2.5' : 'px-3.5 py-2.5',
              )}
            >
              <div class="flex items-start gap-2.5">
                <Icon size={15} class={clsx(iconColors[toast.type], 'mt-0.5 shrink-0')} />
                <span class="text-sm text-text-primary flex-1">{toast.message}</span>
                <button
                  class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0"
                  onClick={() => dismissToast(toast.id)}
                >
                  <X size={13} />
                </button>
              </div>
              <Show when={hasActions()}>
                <div class="flex justify-end gap-2 mt-2.5 pl-[25px]">
                  <For each={toast.actions}>
                    {(action) => (
                      <button
                        class={clsx(actionClass(action.variant), 'text-xs px-2.5 py-1')}
                        onClick={async () => { await action.onClick() }}
                      >
                        {action.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}
