import { Component, onMount, onCleanup, createSignal, Show, type Accessor } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { registerXterm, getXtermEntry } from '../store/terminals'
import type { XtermEntry } from '../store/terminals'
import * as ipc from '../lib/ipc'
import { isMac, modPressed } from '../lib/platform'
import '@xterm/xterm/css/xterm.css'

const THEME = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  selectionBackground: '#6366f140',
  black: '#0a0a0a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e5e5e5',
  brightBlack: '#525252',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
}

/** Capture-phase keydown on the container — fires before xterm's textarea gets it */
function setupCaptureKeyHandler(container: HTMLElement, term: XTerm, terminalId: string, isStopped?: Accessor<boolean>, onToggleSearch?: () => void) {
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = modPressed(e)
    if (mod && e.key === 'f') {
      e.preventDefault()
      e.stopImmediatePropagation()
      onToggleSearch?.()
      return
    }
    if (mod && e.key === 'c') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const selection = term.getSelection()
      if (selection) navigator.clipboard.writeText(selection)
      return
    }
    if (mod && e.key === 'a') { e.preventDefault(); term.selectAll(); return }
    if (mod && e.key === 'k') { e.preventDefault(); term.clear(); return }
    if (mod && e.key === 'ArrowUp') { e.preventDefault(); term.scrollToTop(); return }
    if (mod && e.key === 'ArrowDown') { e.preventDefault(); term.scrollToBottom(); return }
    // Block PTY writes when stopped
    if (isStopped?.()) return
    if (mod && e.key === 'v') {
      e.preventDefault()
      e.stopImmediatePropagation()
      ipc.readClipboard().then(text => { if (text) term.paste(text) })
      return
    }
    if (mod && e.key === 'ArrowLeft') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x01'); return }
    if (mod && e.key === 'ArrowRight') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x05'); return }
    if (mod && e.key === 'Backspace') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x15'); return }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x1bb'); return }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x1bf'); return }
    if (e.altKey && e.key === 'Backspace') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x17'); return }
  }, true)
}

function setupXtermPassthrough(term: XTerm) {
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true
    if (e.ctrlKey && (e.key === '`' || e.key === '~' || e.key === 'Tab')) return false
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') return false
    if (modPressed(e)) return false
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Backspace')) return false
    return true
  })
}

function attachResizeObserver(container: HTMLElement, entry: XtermEntry, terminalId: string): ResizeObserver {
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    if (container.clientWidth < 10 || container.clientHeight < 10) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      entry.fitAddon.fit()
      ipc.ptyResize(terminalId, entry.term.rows, entry.term.cols)
    }, 100)
  })
  observer.observe(container)
  return observer
}

function initialFit(entry: XtermEntry, terminalId: string) {
  requestAnimationFrame(() => {
    entry.fitAddon.fit()
    entry.term.refresh(0, entry.term.rows - 1)
    ipc.ptyResize(terminalId, entry.term.rows, entry.term.cols)
    entry.term.focus()
  })
}

interface Props {
  terminalId: string
  /** Reactive accessor — when true, keyboard input to the PTY is blocked (scrolling still works) */
  isStopped?: Accessor<boolean>
}

export const ShellTerminal: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let terminalRef: HTMLDivElement | undefined
  let searchInputRef: HTMLInputElement | undefined
  let resizeObserver: ResizeObserver | undefined
  let searchAddonRef: SearchAddon | undefined

  const [showSearch, setShowSearch] = createSignal(false)

  const toggleSearch = () => {
    const next = !showSearch()
    setShowSearch(next)
    if (next) {
      requestAnimationFrame(() => searchInputRef?.focus())
    } else {
      searchAddonRef?.clearDecorations()
    }
  }

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowSearch(false)
      searchAddonRef?.clearDecorations()
      getXtermEntry(props.terminalId)?.term.focus()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        searchAddonRef?.findPrevious((e.target as HTMLInputElement).value)
      } else {
        searchAddonRef?.findNext((e.target as HTMLInputElement).value)
      }
    }
  }

  onMount(() => {
    if (!terminalRef) return

    const existing = getXtermEntry(props.terminalId)

    if (existing) {
      const el = existing.term.element
      if (el) terminalRef.appendChild(el)
      searchAddonRef = existing.searchAddon
      setupCaptureKeyHandler(containerRef, existing.term, props.terminalId, props.isStopped, toggleSearch)
      initialFit(existing, props.terminalId)
      resizeObserver = attachResizeObserver(terminalRef, existing, props.terminalId)
      return
    }

    const term = new XTerm({
      theme: THEME,
      fontFamily: isMac
        ? "'SF Mono', Menlo, Monaco, 'Courier New', monospace, 'Apple Color Emoji', 'Segoe UI Emoji'"
        : "'Cascadia Code', 'Consolas', 'Courier New', monospace, 'Segoe UI Emoji'",
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: isMac,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: false,
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    searchAddonRef = searchAddon
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(new WebLinksAddon())
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    setupXtermPassthrough(term)
    setupCaptureKeyHandler(containerRef, term, props.terminalId, props.isStopped, toggleSearch)
    term.onData((data) => {
      if (props.isStopped?.()) return
      ipc.ptyWrite(props.terminalId, data)
    })
    registerXterm(props.terminalId, term, fitAddon, searchAddon)

    term.open(terminalRef)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available
    }

    const entry = { term, fitAddon, searchAddon }
    initialFit(entry, props.terminalId)
    resizeObserver = attachResizeObserver(terminalRef, entry, props.terminalId)
  })

  onCleanup(() => {
    resizeObserver?.disconnect()
  })

  return (
    <div ref={containerRef} class="w-full h-full relative">
      <Show when={showSearch()}>
        <div class="absolute top-2 right-2 z-10 flex items-center gap-1 bg-surface-2 border border-border rounded px-2 py-1">
          <input
            ref={searchInputRef}
            class="bg-transparent text-sm text-gray-200 outline-none w-48 placeholder-gray-500"
            placeholder="Search..."
            onKeyDown={handleSearchKeyDown}
            onInput={(e) => searchAddonRef?.findNext(e.currentTarget.value)}
          />
          <button
            class="text-gray-500 hover:text-gray-300 text-xs px-1"
            onClick={() => { setShowSearch(false); searchAddonRef?.clearDecorations(); getXtermEntry(props.terminalId)?.term.focus() }}
          >
            Esc
          </button>
        </div>
      </Show>
      <div
        ref={terminalRef}
        class="w-full h-full shell-terminal"
        style={{ "background-color": "#0a0a0a", cursor: "default" }}
      />
    </div>
  )
}
