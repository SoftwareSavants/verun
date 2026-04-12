import { Component, Show } from 'solid-js'
import { CheckCircle2, Download, Loader2, RefreshCw, X, AlertTriangle } from 'lucide-solid'
import {
  updateAvailable, updateProgress, updateReady, updateError,
  updateChecking, updateUpToDate,
  downloadAndInstall, restartApp, dismissUpdate,
} from '../lib/updater'

export const UpdateBanner: Component = () => {
  const visible = () =>
    updateAvailable() !== null
    || updateChecking()
    || updateUpToDate()
    || updateError() !== null

  return (
    <Show when={visible()}>
      <div class="flex items-center gap-3 px-4 py-2 bg-accent-muted/30 border-b border-accent/10 text-xs text-text-secondary">
        <Show when={updateError()}>
          {(err) => (
            <>
              <AlertTriangle size={13} class="text-red-400 shrink-0" />
              <span class="flex-1 text-red-400">Update check failed: {err()}</span>
              <button
                class="p-0.5 text-text-dim hover:text-text-muted transition-colors"
                onClick={dismissUpdate}
              >
                <X size={13} />
              </button>
            </>
          )}
        </Show>

        <Show when={!updateError() && updateChecking()}>
          <Loader2 size={13} class="text-accent shrink-0 animate-spin" />
          <span class="flex-1">Checking for updates…</span>
        </Show>

        <Show when={!updateError() && !updateChecking() && updateUpToDate() && !updateAvailable()}>
          <CheckCircle2 size={13} class="text-accent shrink-0" />
          <span class="flex-1">You're up to date.</span>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors"
            onClick={dismissUpdate}
          >
            <X size={13} />
          </button>
        </Show>

        <Show when={!updateError() && updateAvailable()}>
          {(info) => (
            <>
              <Download size={13} class="text-accent shrink-0" />

              <Show when={updateReady()}>
                <span class="flex-1">
                  Update installed. Restart to use v{info().version}.
                </span>
                <button
                  class="px-3 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1.5"
                  onClick={restartApp}
                >
                  <RefreshCw size={11} />
                  Restart
                </button>
              </Show>

              <Show when={updateProgress() !== null && !updateReady()}>
                <span class="flex-1">
                  Downloading v{info().version}… {updateProgress()}%
                </span>
                <div class="w-32 h-1 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-accent rounded-full transition-all"
                    style={{ width: `${updateProgress()}%` }}
                  />
                </div>
              </Show>

              <Show when={updateProgress() === null && !updateReady()}>
                <span class="flex-1">
                  Verun v{info().version} is available.
                </span>
                <button
                  class="px-3 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                  onClick={downloadAndInstall}
                >
                  Update Now
                </button>
                <button
                  class="p-0.5 text-text-dim hover:text-text-muted transition-colors"
                  onClick={dismissUpdate}
                >
                  <X size={13} />
                </button>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
