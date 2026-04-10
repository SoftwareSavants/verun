import { Component, Show } from 'solid-js'
import { Download, RefreshCw, X } from 'lucide-solid'
import {
  updateAvailable, updateProgress, updateReady, updateError,
  downloadAndInstall, restartApp, dismissUpdate,
} from '../lib/updater'

export const UpdateBanner: Component = () => {
  return (
    <Show when={updateAvailable()}>
      {(info) => (
        <div class="flex items-center gap-3 px-4 py-2 bg-accent-muted/30 border-b border-accent/10 text-xs text-text-secondary">
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
              Downloading v{info().version}... {updateProgress()}%
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

          <Show when={updateError()}>
            <span class="text-red-400 ml-2">{updateError()}</span>
          </Show>
        </div>
      )}
    </Show>
  )
}
