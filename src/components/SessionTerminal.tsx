import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'
import { formatDroppedPathsForTerminal, estimatePtyDimensions } from '../lib/terminalMode'
import { getXtermFontConfig } from '../lib/terminalTheme'
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

  async function openTerminal() {
    setError(null)
    setExited(false)
    setTerminalId(null)
    try {
      const { rows, cols } = measureContainer()
      const res = await ipc.claudeTerminalOpen(props.sessionId, rows, cols)
      setTerminalId(res.terminalId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Pre-size the PTY to match the visible container so Claude's first frame
  // renders at the right dimensions. Without this, Claude paints at the
  // hardcoded 24x80 spawn size, then xterm fits to the real size and emits
  // SIGWINCH - but residual content from the smaller frame stays in the
  // scrollback until the user resizes the window.
  function measureContainer(): { rows: number; cols: number } {
    if (!containerRef) return { rows: 24, cols: 80 }
    const rect = containerRef.getBoundingClientRect()
    const fontSize = getXtermFontConfig().fontSize
    return estimatePtyDimensions(rect.width, rect.height, fontSize)
  }

  onMount(() => {
    // Defer to the next paint so flex layout has computed our container
    // size before we measure it for the initial PTY dimensions.
    requestAnimationFrame(() => { void openTerminal() })
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
    ipc.claudeTerminalClose(props.sessionId).catch(() => {})
  })

  return (
    <div ref={containerRef} class="w-full h-full flex flex-col bg-surface-0">
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
                <ShellTerminal terminalId={id()} disableCmdVIntercept />
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
