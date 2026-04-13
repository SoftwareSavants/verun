import { Component, Show } from 'solid-js'
import { CheckCircle2, Loader2, RefreshCw, X, AlertTriangle } from 'lucide-solid'
import {
  updateAvailable, updateProgress, updateReady, updateError,
  updateChecking, updateUpToDate, dismissed,
  downloadAndInstall, restartApp, dismissUpdate,
} from '../lib/updater'

export const UpdateToast: Component = () => {
  const visible = () =>
    !dismissed() && (
      updateAvailable() !== null
      || updateChecking()
      || updateUpToDate()
      || updateError() !== null
    )

  return (
    <Show when={visible()}>
      <div class="pointer-events-auto rounded-xl border border-border shadow-xl bg-surface-2/90 backdrop-blur-sm p-3.5 min-w-64 max-w-sm animate-slide-in">

        <Show when={updateError()}>
          {(err) => (
            <div class="flex items-start gap-2.5">
              <AlertTriangle size={15} class="text-status-error shrink-0 mt-0.5" />
              <span class="text-sm text-text-primary flex-1">Update check failed: {err()}</span>
              <button
                class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0"
                onClick={dismissUpdate}
              >
                <X size={13} />
              </button>
            </div>
          )}
        </Show>

        <Show when={!updateError() && updateChecking()}>
          <div class="flex items-center gap-2.5">
            <Loader2 size={15} class="text-accent shrink-0 animate-spin" />
            <span class="text-sm text-text-primary flex-1">Checking for updates…</span>
          </div>
        </Show>

        <Show when={!updateError() && !updateChecking() && updateUpToDate() && !updateAvailable()}>
          <div class="flex items-center gap-2.5">
            <CheckCircle2 size={15} class="text-accent shrink-0" />
            <span class="text-sm text-text-primary flex-1">You're up to date.</span>
            <button
              class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0"
              onClick={dismissUpdate}
            >
              <X size={13} />
            </button>
          </div>
        </Show>

        <Show when={!updateError() && !updateChecking() && updateAvailable()}>
          {(info) => (
            <>
              <Show when={updateReady()}>
                <div class="flex items-center gap-2.5">
                  <RefreshCw size={15} class="text-accent shrink-0" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-text-primary">Ready to restart</div>
                    <div class="text-xs text-text-secondary mt-0.5">v{info().version} installed</div>
                  </div>
                  <button
                    class="px-2.5 py-1 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 text-xs flex items-center gap-1.5 shrink-0"
                    onClick={restartApp}
                  >
                    Restart
                  </button>
                </div>
              </Show>

              <Show when={updateProgress() !== null && !updateReady()}>
                <div class="flex items-start gap-2.5">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-sm text-text-primary">Downloading v{info().version}…</span>
                      <span class="text-xs text-text-secondary shrink-0">{updateProgress()}%</span>
                    </div>
                    <div class="mt-1.5 h-1 bg-surface-3 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-accent rounded-full"
                        style={{ width: `${updateProgress()}%`, transition: 'width 0.3s ease' }}
                      />
                    </div>
                  </div>
                  <button
                    class="p-0.5 rounded text-text-dim hover:text-text-muted transition-colors shrink-0 mt-0.5"
                    onClick={dismissUpdate}
                  >
                    <X size={13} />
                  </button>
                </div>
              </Show>

              <Show when={updateProgress() === null && !updateReady()}>
                <div>
                  <div class="text-sm text-text-primary">Update available</div>
                  <div class="text-xs text-text-secondary mt-0.5">v{info().version} is ready to download</div>
                  <div class="flex items-center justify-end gap-2 mt-2.5">
                    <button
                      class="px-2.5 py-1 rounded-lg text-text-dim hover:text-text-muted text-xs"
                      onClick={dismissUpdate}
                    >
                      Later
                    </button>
                    <button
                      class="btn-primary text-xs px-2.5 py-1"
                      onClick={downloadAndInstall}
                    >
                      Update now
                    </button>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>

      </div>
    </Show>
  )
}
