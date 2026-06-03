import { Component, For, Show } from 'solid-js'
import { toasts, dismissToast, type ToastAction } from '../store/ui'
import { clsx } from 'clsx'
import { CheckCircle, AlertCircle, Info, Loader2, X } from 'lucide-solid'
import { UpdateToast } from './UpdateBanner'

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
          const Icon = toast.loading ? Loader2 : icons[toast.type]
          const hasActions = () => (toast.actions?.length ?? 0) > 0
          return (
            <div
              class={clsx(
                'pointer-events-auto rounded-xl border shadow-xl backdrop-blur-sm animate-slide-in min-w-64 max-w-md overflow-hidden',
                colors[toast.type],
                'bg-surface-2/90',
                'px-3.5 py-2.5',
              )}
            >
              <div class="flex items-start gap-2.5">
                <Icon size={15} class={clsx(iconColors[toast.type], 'mt-0.5 shrink-0', toast.loading && 'animate-spin')} />
                <div class="flex-1 min-w-0">
                  <Show
                    when={toast.title}
                    fallback={<span class="text-sm text-text-primary break-words">{toast.message}</span>}
                  >
                    <div class="text-sm font-medium text-text-primary leading-tight">{toast.title}</div>
                    <Show when={toast.message}>
                      <div class="text-xs text-text-secondary mt-0.5 font-mono break-all">{toast.message}</div>
                    </Show>
                  </Show>
                  <Show when={toast.meta}>
                    <div class="text-[11px] text-text-dim mt-1">{toast.meta}</div>
                  </Show>
                </div>
                <button
                  class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0"
                  onClick={() => dismissToast(toast.id)}
                >
                  <X size={13} />
                </button>
              </div>
              <Show when={toast.progress}>
                <div class="mt-2 flex items-center gap-2 pl-[25px]">
                  <div class="relative flex-1 h-1 overflow-hidden rounded-full bg-surface-3">
                    <div class="absolute inset-y-0 left-0 w-1/4 rounded-full bg-accent animate-indeterminate-progress" />
                  </div>
                  <For each={toast.actions}>
                    {(action) => (
                      <button
                        class={clsx(actionClass(action.variant), 'text-xs px-2.5 py-0.5 shrink-0')}
                        onClick={async () => { await action.onClick() }}
                      >
                        {action.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={hasActions() && !toast.progress}>
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
      <UpdateToast />
    </div>
  )
}
