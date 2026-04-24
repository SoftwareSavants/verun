import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'
import type { PtyExitedEvent } from '../types'

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

  async function openTerminal() {
    setError(null)
    setExited(false)
    setTerminalId(null)
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

  onCleanup(() => {
    unlisten?.()
    ipc.claudeTerminalClose(props.sessionId).catch(() => {})
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
              <div class="flex-1 min-h-0">
                <ShellTerminal terminalId={id()} />
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
