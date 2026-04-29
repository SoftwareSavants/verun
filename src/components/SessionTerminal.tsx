import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'
import { formatDroppedPathsForTerminal } from '../lib/terminalMode'
import type { PtyExitedEvent } from '../types'

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
  let containerRef: HTMLDivElement | undefined

  // Capture-phase Cmd/Ctrl+V handler. Fires before ShellTerminal's inner-
  // container handler (capture order is outer→inner), so when the clipboard
  // holds an image we forward the saved file path to the PTY instead of
  // letting the text-only fallback eat the paste. Falls back to text when
  // there's no image so plain Cmd+V still works.
  function handleKeyDownCapture(e: KeyboardEvent) {
    if (e.key !== 'v' || !(e.metaKey || e.ctrlKey)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const tid = terminalId()
    if (!tid) return
    void (async () => {
      try {
        const imagePath = await ipc.readClipboardImageToPath()
        if (imagePath) {
          await ipc.ptyWrite(tid, formatDroppedPathsForTerminal([imagePath]))
          return
        }
        const text = await ipc.readClipboard()
        if (text) await ipc.ptyWrite(tid, text)
      } catch {
        // Paste failures are silent — same posture as ShellTerminal.
      }
    })()
  }

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
    if (containerRef) containerRef.removeEventListener('keydown', handleKeyDownCapture, true)
    ipc.claudeTerminalClose(props.sessionId).catch(() => {})
  })

  return (
    <div
      ref={(el) => {
        containerRef = el
        el.addEventListener('keydown', handleKeyDownCapture, true)
      }}
      class="w-full h-full flex flex-col bg-surface-0"
    >
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
