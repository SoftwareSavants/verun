import { Component, onMount, onCleanup, Show } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Loader2, X } from 'lucide-solid'
import * as ipc from '../lib/ipc'
import { getXtermTheme, getXtermFontConfig, subscribeXtermToAppearance } from '../lib/terminalTheme'
import '@xterm/xterm/css/xterm.css'

interface Props {
  projectName: string
  elapsedLabel: string
  scaffoldId: string
  errorText: string | null
  onCancel: () => void
}

interface OutputEvent {
  id: string
  data: string
}

export const BtsLogPane: Component<Props> = (p) => {
  let containerRef!: HTMLDivElement
  let term: XTerm | null = null
  let fitAddon: FitAddon | null = null
  let unlistenOutput: UnlistenFn | null = null
  let unsubscribeAppearance: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let resizeTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    const fontConfig = getXtermFontConfig()
    term = new XTerm({
      theme: getXtermTheme(),
      fontFamily: fontConfig.fontFamily,
      fontSize: fontConfig.fontSize,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef)

    unsubscribeAppearance = subscribeXtermToAppearance(term)

    listen<OutputEvent>('bts-scaffold-output', (e) => {
      if (e.payload.id !== p.scaffoldId) return
      term?.write(e.payload.data)
    }).then((un) => {
      unlistenOutput = un
    })

    term.onData((data) => {
      void ipc.btsScaffoldInput(p.scaffoldId, data)
    })

    const sendResize = () => {
      if (!fitAddon || !term) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
      void ipc.btsScaffoldResize(p.scaffoldId, term.rows, term.cols)
    }

    requestAnimationFrame(() => {
      sendResize()
      term?.focus()
    })

    resizeObserver = new ResizeObserver(() => {
      if (containerRef.clientWidth < 10 || containerRef.clientHeight < 10) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(sendResize, 80)
    })
    resizeObserver.observe(containerRef)
  })

  onCleanup(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeObserver?.disconnect()
    unlistenOutput?.()
    unsubscribeAppearance?.()
    term?.dispose()
    term = null
  })

  return (
    <div class="flex flex-col gap-3" style={{ height: '33.6rem', 'max-height': 'calc(100vh - 10rem)' }}>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm text-text-primary">
          <Loader2 size={16} class="animate-spin text-accent" />
          <span>Bootstrapping {p.projectName}</span>
          <span class="text-xs text-text-dim font-mono">{p.elapsedLabel}</span>
        </div>
        <button class="btn-ghost text-xs flex items-center gap-1.5" onClick={p.onCancel}>
          <X size={12} /> Cancel
        </button>
      </div>
      <div
        ref={containerRef}
        class="flex-1 min-h-0 bg-surface-0 ring-1 ring-white/8 rounded p-2 overflow-hidden"
        data-testid="bts-log"
      />
      <Show when={p.errorText}>
        <div class="text-xs text-status-error bg-status-error/10 rounded p-2">{p.errorText}</div>
      </Show>
    </div>
  )
}
