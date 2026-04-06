import { Component, For } from 'solid-js'
import { toasts, dismissToast } from '../store/ui'
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
  info: 'border-accent/20 bg-accent/5',
}

const iconColors = {
  success: 'text-status-running',
  error: 'text-status-error',
  info: 'text-accent',
}

export const ToastContainer: Component = () => {
  return (
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      <For each={toasts()}>
        {(toast) => {
          const Icon = icons[toast.type]
          return (
            <div
              class={clsx(
                'pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-xl backdrop-blur-sm animate-slide-in min-w-64 max-w-sm',
                colors[toast.type],
                'bg-surface-2/90'
              )}
            >
              <Icon size={15} class={iconColors[toast.type]} />
              <span class="text-sm text-text-primary flex-1">{toast.message}</span>
              <button
                class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0"
                onClick={() => dismissToast(toast.id)}
              >
                <X size={13} />
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}
