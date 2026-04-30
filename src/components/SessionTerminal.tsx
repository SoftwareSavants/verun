import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Loader2 } from 'lucide-solid'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'
import { formatDroppedPathsForTerminal } from '../lib/terminalMode'
import type { PtyExitedEvent, PtyOutputEvent } from '../types'

interface TauriDragDropPayload {
  paths: string[]
  position?: { x: number; y: number }
}

interface Props {
  sessionId: string
}

/**
 * Host a Claude Code TUI inside a real PTY. Opens `claude --resume <id>`
 * via the backend, receives a terminal id, and mounts a shared ShellTerminal
 * against it. If Claude exits (Ctrl+D / /exit / crash) we surface a reconnect
 * action so the user can respawn it without flipping the view-mode toggle.
 */
export const SessionTerminal: Component<Props> = (props) => {
  const [terminalId, setTerminalId] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [exited, setExited] = createSignal(false)
  // True once we've seen any non-empty pty-output for the current terminal.
  // Drives a centered spinner overlay so the user gets feedback during the
  // gap between PTY spawn and Claude printing its first frame.
  const [ready, setReady] = createSignal(false)

  async function openTerminal() {
    setError(null)
    setExited(false)
    setTerminalId(null)
    setReady(false)
    try {
      const res = await ipc.claudeTerminalOpen(props.sessionId, 24, 80)
      setTerminalId(res.terminalId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  onMount(() => {
    void openTerminal()
  })

  let unlisten: UnlistenFn | undefined
  void listen<PtyExitedEvent>('pty-exited', (event) => {
    if (event.payload.terminalId === terminalId()) {
      setExited(true)
      setTerminalId(null)
    }
  }).then((fn) => {
    unlisten = fn
  })

  let unlistenOutput: UnlistenFn | undefined
  void listen<PtyOutputEvent>('pty-output', (event) => {
    if (ready()) return
    if (event.payload.terminalId !== terminalId()) return
    if (!event.payload.data) return
    setReady(true)
  }).then((fn) => {
    unlistenOutput = fn
  })

  // Drop handler: SessionTerminal is the only drop target visible in Terminal
  // view (MessageInput is unmounted), so any drop on the window forwards its
  // paths to the PTY. No bbox hit-test — Tauri's drop position is in physical
  // pixels which doesn't reliably match getBoundingClientRect's CSS pixels
  // across displays / window moves.
  let unlistenDrop: UnlistenFn | undefined
  void listen<TauriDragDropPayload>('tauri://drag-drop', (event) => {
    const tid = terminalId()
    const paths = event.payload.paths ?? []
    if (!tid || paths.length === 0) return
    ipc.ptyWrite(tid, formatDroppedPathsForTerminal(paths)).catch(() => {})
  }).then((fn) => { unlistenDrop = fn })

  onCleanup(() => {
    unlisten?.()
    unlistenDrop?.()
    unlistenOutput?.()
    // Don't close the Claude PTY on unmount. The backend's `claude_terminal_open`
    // is idempotent per session (returns the existing handle when called again),
    // and ShellTerminal rejoins the existing xterm via the terminals registry —
    // so switching session tabs / toggling UI↔Terminal preserves the running
    // TUI instead of respawning `claude --resume` each time. Real cleanup
    // happens when the session itself is closed (`close_all_for_task`) or when
    // the PTY exits (`drop_if_stale`).
  })

  return (
    <div class="w-full h-full flex flex-col bg-surface-0">
      <Show
        when={!error()}
        fallback={
          <div class="flex-1 flex items-center justify-center p-6 text-sm text-status-error">
            {error()}
          </div>
        }
      >
        <Show
          when={!exited()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-sm text-text-muted">
              <div>Claude Code exited.</div>
              <button
                class="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                onClick={() => void openTerminal()}
              >
                Reconnect
              </button>
            </div>
          }
        >
          <Show
            when={terminalId()}
            fallback={
              <div class="flex-1 flex items-center justify-center p-6 text-sm text-text-dim">
                Starting Claude Code...
              </div>
            }
          >
            {(id) => (
              <div class="flex-1 min-h-0 relative">
                <ShellTerminal terminalId={id()} disableCmdVIntercept />
                <Show when={!ready()}>
                  <div
                    data-testid="claude-terminal-loading"
                    class="absolute inset-0 grid place-items-center bg-surface-0 pointer-events-none transition-opacity duration-200"
                  >
                    <div class="flex items-center gap-2 text-text-dim text-sm">
                      <Loader2 size={14} class="animate-spin" />
                      <span>Starting Claude Code…</span>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
